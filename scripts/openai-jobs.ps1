[CmdletBinding()]
param(
    [Parameter(Mandatory, Position=0)]
    [string]$Directory,
    [ValidateRange(1, 1000)]
    [int]$Limit = 100,
    [ValidateRange(1, 64)]
    [int]$MaxCheckpointMiB = 2,
    [switch]$WithNext
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
$fileIdPattern = '\Afile[-_][A-Za-z0-9_-]{1,251}\z'

function Get-ReceiptField([System.Collections.IDictionary]$Row, [string[]]$Fields) {
    foreach ($field in $Fields) {
        $value = $Row[$field]
        if ($value -is [string] -and $value -cmatch '\A[A-Za-z0-9._-]{1,262}\z') { return $value }
    }
}

function Read-Checkpoint([IO.FileInfo]$File) {
    $snapshot = [ordered]@{ checkpoint = $File.FullName; lastWriteUtc = $File.LastWriteTimeUtc.ToString('o') }
    try {
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.File]::Open($File.FullName, 'Open', 'Read', $share)
        try {
            $length = $stream.Length
            if ($length -gt ($MaxCheckpointMiB * 1MB)) {
                $snapshot.state = 'checkpoint_too_large'
                $snapshot.bytes = $length
                return [pscustomobject]$snapshot
            }
            $bytes = [byte[]]::new([int]$length)
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
                if (!$read) { break }
                $offset += $read
            }
        } finally { $stream.Dispose() }
        $lastLf = if ($offset) { [Array]::LastIndexOf($bytes, [byte]10, $offset - 1) } else { -1 }
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        $lines = $encoding.GetString($bytes, 0, $lastLf + 1).TrimStart([char]0xfeff).Split([char]10)
        $seen = $false
        $invalid = 0
        $unrecognized = 0
        $attempts = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $operations = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $identityClaims = @{}
        foreach ($field in 'responseId','batchId','sessionId','fileId','observedFileId','scanId','inputFileId','containerId',
            'uploadId','workspaceTriggerId','workspaceRunId','liveSessionId','originalResponseId','continuationResponseId','steerId') {
            $identityClaims[$field] = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        }
        foreach ($line in $lines) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $row = ConvertFrom-OpenAiJsonObject $line }
            catch { $invalid++; continue }
            if ($row -isnot [System.Collections.IDictionary]) { continue }
            $operation = Get-ReceiptField $row @('action', 'operation')
            $phase = Get-ReceiptField $row @('phase', 'state')
            $attempt = Get-ReceiptField $row @('attemptId', 'clientRequestId')
            if (!$operation -or !$phase -or !$attempt -or $operation -notmatch '^(?:(?:Responses|RetrieveResponse|Batch|Security)$|(?:responses|batches|sessions|files|audio|images|vectorstores|decisions|conversations|skills|agents|environments|automations|vaults|embeddings|moderations|containers|uploads|provenance|live|workspace|models|admin)\.)') {
                $unrecognized++
                continue
            }
            $operation = switch ($operation) {
                'Responses' { 'Responses' }
                'RetrieveResponse' { 'RetrieveResponse' }
                'Batch' { 'Batch' }
                'Security' { 'Security' }
                default { $operation.ToLowerInvariant() }
            }
            $seen = $true
            $snapshot.operation = $operation
            [void]$attempts.Add($attempt)
            [void]$operations.Add($operation)
            if ($phase -eq 'local_cleanup' -and $row['version'] -eq 2 -and $row['operation']) {
                foreach ($field in 'localExitConfirmed','localIoSettled') {
                    if ($row[$field] -is [bool]) { $snapshot[$field] = $row[$field] }
                }
                continue
            }
            $snapshot.phase = $phase
            foreach ($set in @(
                @('responseId', 'responseId'), @('sessionId', 'sessionId'), @('batchId', 'batchId'),
                @('scanId', 'scanId'), @('inputFileId', 'inputFileId'), @('outputFileId', 'outputFileId'),
                @('errorFileId', 'errorFileId'),
                @('remoteStatus', 'resourceStatus', 'responseStatus', 'batchStatus', 'scanStatus'),
                @('observedResourceStatus', 'observedResourceStatus', 'observedBatchStatus', 'observedResponseStatus'),
                @('resourceStatusClassification', 'resourceStatusClassification'),
                @('projectHint', 'projectHint'), @('clientRequestId', 'clientRequestId'), @('requestId', 'requestId'),
                @('turnId', 'turnId'), @('outcome', 'outcome'), @('end', 'end'),
                @('artifactVerification', 'artifactVerification'),
                @('containerId', 'containerId'), @('containerFileId', 'containerFileId'),
                @('uploadId', 'uploadId'), @('partId', 'partId'), @('fileId', 'fileId'),
                @('localSourceSha256', 'sourceSha256'),
                @('workspaceTriggerId', 'workspaceTriggerId'), @('workspaceRunId', 'workspaceRunId'),
                @('idempotencyKey', 'idempotencyKey'), @('liveSessionId', 'liveSessionId'),
                @('liveCloseReason', 'liveCloseReason', 'closeReason'),
                @('originalResponseId','originalResponseId'), @('continuationResponseId','continuationResponseId'),
                @('originalStatus','originalStatus'), @('continuationStatus','continuationStatus'),
                @('steerId','steerId'), @('steerDispatch','steerDispatch'), @('steerErrorCode','steerErrorCode'),
                @('providerErrorCode','providerErrorCode'), @('localCode','localCode'),
                @('pendingReason','pendingReason')
            )) {
                $value = Get-ReceiptField $row $set[1..($set.Length - 1)]
                if ($value) { $snapshot[$set[0]] = $value }
            }
            if ($row['storeRequested'] -is [bool]) { $snapshot.storeRequested = $row['storeRequested'] }
            $pendingCount = $row['pendingInputCount']
            if (($pendingCount -is [int] -or $pendingCount -is [long]) -and $pendingCount -ge 0) {
                $snapshot.pendingInputCount = $pendingCount
            }
            $daybreak = $row['daybreak']
            if ($daybreak -is [System.Collections.IDictionary]) {
                $evidence = [ordered]@{}
                foreach ($field in 'requestedProgram','observedProgram') {
                    if ($daybreak[$field] -cin 'standard','daybreak_blue','daybreak_red') { $evidence[$field] = $daybreak[$field] }
                }
                if ($daybreak['acceptanceState'] -cin 'not-attempted','unconfirmed','accepted','rejected') {
                    $evidence.acceptanceState = $daybreak['acceptanceState']
                }
                if ($daybreak['configurationState'] -cin 'unconfirmed','confirmed','mismatch','observed') {
                    $evidence.configurationState = $daybreak['configurationState']
                }
                foreach ($field in 'observationSource','jobRef','inputSha256','failureCategory') {
                    $value = Get-ReceiptField $daybreak @($field)
                    if ($value) { $evidence[$field] = $value }
                }
                $snapshot.daybreak = $evidence
            }
            if ($row['safetyOutcome'] -cin 'provider-cyber-policy','content-filter','content-refusal') {
                $snapshot.safetyOutcome = $row['safetyOutcome']
            }
            foreach ($field in 'requestedModel','requestedEffort','reportedModel','reportedEffort') {
                $value = Get-ReceiptField $row @($field)
                if ($value) { $snapshot[$field] = $value }
            }
            $observedId = Get-ReceiptField $row @('resourceId')
            $requestedId = Get-ReceiptField $row @('requestedId')
            if ($row['resourceStatusClassification'] -ceq 'unknown') { $snapshot.Remove('remoteStatus') }
            elseif ($row['resourceStatus'] -or $row['batchStatus'] -or $row['responseStatus']) {
                $snapshot.Remove('observedResourceStatus')
                $snapshot.Remove('resourceStatusClassification')
            }
            if ($requestedId) { $snapshot.requestedId = $requestedId }
            $requestedIdentity = switch -CaseSensitive -Regex ($operation) {
                '^(?:RetrieveResponse|responses\.(?:multiagent\.)?(?:retrieve|cancel))$' { 'responseId' }
                '^batches\.(?:retrieve|wait|cancel)$' { 'batchId' }
                '^sessions\.retrieve$' { 'sessionId' }
                '^files\.(?:retrieve|content|delete)$' { 'fileId' }
            }
            if ($requestedId -and $requestedIdentity) { [void]$identityClaims[$requestedIdentity].Add($requestedId) }
            foreach ($claim in @(@('^resp_','responseId'),@('^batch_','batchId'),@('^sess_','sessionId'))) {
                if ($observedId -cmatch $claim[0]) {
                    [void]$identityClaims[$claim[1]].Add($observedId)
                    $snapshot[$claim[1]] = $observedId
                }
            }
            if ($observedId -cmatch '^file[-_]') { $snapshot.fileId = $observedId }
            $isUploadCompletion = $operation -cin 'files.create','uploads.complete','uploads.transfer'
            if ($isUploadCompletion) {
                $observedFile = Get-ReceiptField $row @('observedFileId')
                if ($observedFile -cmatch $fileIdPattern) { $snapshot.observedFileId = $observedFile }
            }
            foreach ($field in $identityClaims.Keys) {
                if ($field -eq 'fileId' -and $requestedIdentity -ne 'fileId' -and $operation -cne 'files.create' -and !$isUploadCompletion) { continue }
                if ($field -eq 'observedFileId' -and !$isUploadCompletion) { continue }
                if ($snapshot[$field]) { [void]$identityClaims[$field].Add($snapshot[$field]) }
                $explicit = Get-ReceiptField $row @($field)
                if ($explicit -and ($field -ne 'observedFileId' -or $explicit -cmatch $fileIdPattern)) {
                    [void]$identityClaims[$field].Add($explicit)
                }
            }
            $timestamp = if ($row['at']) { $row['at'] } else { $row['utc'] }
            if ($row['sourceBytes'] -is [long] -or $row['sourceBytes'] -is [int]) { $snapshot.localSourceBytes = $row['sourceBytes'] }
            if ($timestamp -and $phase -in 'response_received','accepted','response_observed','batch_observed','terminal_event','workspace_run_observed') {
                $snapshot.lastObservation = $timestamp
            }
            if ($row['headers'] -is [System.Collections.IDictionary]) {
                $requestId = Get-ReceiptField $row['headers'] @('x-request-id')
                if ($requestId) { $snapshot.requestId = $requestId }
            }
            $sequence = $row['sequenceNumber']
            if (($sequence -is [int] -or $sequence -is [long]) -and $sequence -ge 0) {
                $snapshot.sequenceNumber = $sequence
            }
            $integrity = $row['streamIntegrity']
            if ($integrity -is [System.Collections.IDictionary]) {
                $snapshot.streamIntegrity = Get-ReceiptField $integrity @('state')
                $snapshot.streamOrigin = Get-ReceiptField $integrity @('origin')
                $snapshot.Remove('lastDurableContiguousSequence')
                $durable = $integrity['lastDurableContiguousSequence']
                if ($snapshot.streamOrigin -cin 'creation-observed','requested-cursor' -and
                    ($durable -is [int] -or $durable -is [long]) -and $durable -ge 0) {
                    $snapshot.lastDurableContiguousSequence = $durable
                }
            }
            foreach ($field in 'outcomeUnconfirmed','dispatch','apiCode','apiType','httpStatus','headers','errorObservedAt',
                'errorRecordedAt','headerMethod','headerScope','failureCategory','recoveryConflictFields','recoveryEvidence') {
                if ($snapshot.Contains($field)) { $snapshot.Remove($field) }
            }
            if ($row['outcomeUnconfirmed'] -is [bool]) { $snapshot.outcomeUnconfirmed = $row['outcomeUnconfirmed'] }
            if ($phase -eq 'error') {
                foreach ($aliases in @(@('dispatch'),@('apiCode','errorCode'),@('apiType','errorType'),
                    @('headerMethod','sourceMethod'),@('headerScope'),@('failureCategory'))) {
                    $value = Get-ReceiptField $row $aliases
                    if ($value) { $snapshot[$aliases[0]] = $value }
                }
                $status = $row['httpStatus'] ?? $row['status']
                if (($status -is [int] -or $status -is [long]) -and $status -ge 100 -and $status -le 599) { $snapshot.httpStatus = $status }
                if ($row['headers'] -is [System.Collections.IDictionary]) { $snapshot.headers = $row['headers'] }
                $errorTime = Get-OpenAiZonedTimestamp $row['headerObservedAt']
                if ($errorTime) { $snapshot.errorObservedAt = $errorTime }
                $snapshot.errorRecordedAt = Get-OpenAiZonedTimestamp $timestamp
                $knownFields = 'responseId','responseStatus','stage','input_file_id','batch_id'
                $conflictFields = @($row['recoveryConflictFields'] | Where-Object { $_ -cin $knownFields } | Select-Object -Unique)
                if ($conflictFields.Count) { $snapshot.recoveryConflictFields = $conflictFields }
                if ($row['recoveryEvidence'] -is [System.Collections.IDictionary]) {
                    $sources = @{}
                    foreach ($field in $knownFields) {
                        $values = @($row['recoveryEvidence'][$field] | Where-Object { $_ -cin 'http','stdout','stderr' } | Select-Object -Unique)
                        if ($values.Count) { $sources[$field] = $values }
                    }
                    if ($sources.Count) { $snapshot.recoveryEvidence = $sources }
                }
            }
        }
        $mixed = $attempts.Count -gt 1 -or $operations.Count -gt 1
        $conflicts = @($identityClaims.Keys | Where-Object { $identityClaims[$_].Count -gt 1 } | Sort-Object)
        if ($identityClaims.fileId.Count -eq 1 -and $identityClaims.observedFileId.Count -eq 1 -and
            !$identityClaims.fileId.SetEquals($identityClaims.observedFileId)) {
            $conflicts = @($conflicts + @('fileId','observedFileId') | Sort-Object -Unique)
        }
        $conflict = $conflicts.Count -gt 0
        if ($seen) { $invalid += $unrecognized }
        $snapshot.partialTail = $lastLf -ne ($offset - 1)
        $snapshot.state = if ($mixed) { 'mixed_attempts' }
            elseif ($conflict) { if ($conflicts.Count -eq 1 -and $conflicts[0] -eq 'responseId') {
                'conflicting_response_ids'
            } else { 'conflicting_resource_ids' } } elseif ($invalid) { 'invalid_checkpoint_lines' }
            elseif (!$seen) { if ($snapshot.partialTail) { 'partial_checkpoint' } else { 'no_checkpoint_records' } }
            else { 'recorded' }
        $snapshot.serverStateVerified = $false
        if ($invalid) { $snapshot.invalidLines = $invalid }
        if ($mixed -or $conflict -or $invalid) {
            foreach ($field in @($snapshot.Keys)) {
                if ($field -notin 'checkpoint', 'lastWriteUtc', 'state', 'serverStateVerified', 'partialTail', 'invalidLines') {
                    $snapshot.Remove($field)
                }
            }
        }
        if ($conflict) { $snapshot.conflictFields = $conflicts }
    } catch {
        return [pscustomobject]@{ checkpoint = $File.FullName; state = 'checkpoint_unreadable' }
    }
    [pscustomobject]$snapshot
}

function Get-KnownJobId($Job, [string]$Field, [string]$Pattern, [string]$RequestedAction) {
    $observed = $Job.PSObject.Properties[$Field]
    if ($observed -and $observed.Value -cmatch $Pattern) { return $observed.Value }
    $requested = $Job.PSObject.Properties['requestedId']
    if ($RequestedAction -and $requested -and $Job.operation -cmatch $RequestedAction -and $requested.Value -cmatch $Pattern) {
        return $requested.Value
    }
}

$folder = Get-Item -LiteralPath $Directory
if (!$folder.PSIsContainer -or $folder.PSProvider.Name -ne 'FileSystem') { throw 'Select a local checkpoint directory.' }
$jobs = @(Get-ChildItem -LiteralPath $folder.FullName -File -Filter '*.jsonl' |
    Where-Object { !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
    Sort-Object LastWriteTimeUtc -Descending |
    ForEach-Object { Read-Checkpoint $_ } |
    Where-Object { $_.state -ne 'no_checkpoint_records' } |
    Select-Object -First $Limit)
if ($WithNext) {
    foreach ($job in $jobs) {
        $remoteId = $null
        $operation = $null
        $parameters = $null
        $category = 'reconcile'
        $hint = 'Inspect the checkpoint and reconcile the server outcome before any resubmission.'
        if ($job.state -eq 'recorded' -and !($job.PSObject.Properties['recoveryConflictFields'] -and $job.recoveryConflictFields)) {
            $batch = Get-KnownJobId $job 'batchId' '\Abatch_[A-Za-z0-9_-]+\z' '\Abatches\.(?:retrieve|wait|cancel)\z'
            $response = Get-KnownJobId $job 'responseId' '\Aresp_[A-Za-z0-9_-]+\z' '\A(?:RetrieveResponse|responses\.(?:multiagent\.)?(?:retrieve|cancel))\z'
            $session = Get-KnownJobId $job 'sessionId' '\Asess_[A-Za-z0-9_-]+\z' '\Asessions\.(?:retrieve|events\.stream)\z'
            $file = Get-KnownJobId $job 'fileId' $fileIdPattern '\Afiles\.(?:retrieve|content)\z'
            if ($batch) {
                $remoteId = $batch
                $operation = 'batches.retrieve'
                $status = if ($job.PSObject.Properties['remoteStatus']) { $job.remoteStatus }
                $category = if ($status -in 'completed','failed','expired','cancelled') { 'collect_or_review' }
                    elseif ($status -in 'validating','in_progress','finalizing','cancelling') { 'check_pending' }
                    else { 'verify_remote' }
                $hint = 'Confirm current Batch status, then use batches.wait to collect output and error files.'
            } elseif ($response) {
                $remoteId = $response
                $operation = if ($job.operation -clike 'responses.multiagent.*') { 'responses.multiagent.retrieve' }
                    else { 'responses.retrieve' }
                $hint = 'Try retrieval by response ID if the response was stored. A missing response alone does not establish non-execution.'
            } elseif ($job.operation -ceq 'responses.steer') {
                if ($job.PSObject.Properties['storeRequested'] -and $job.storeRequested) {
                    $remoteId = Get-KnownJobId $job 'continuationResponseId' '\Aresp_[A-Za-z0-9_-]+\z'
                    if (!$remoteId) { $remoteId = Get-KnownJobId $job 'originalResponseId' '\Aresp_[A-Za-z0-9_-]+\z' }
                }
                if ($remoteId) {
                    $operation = 'responses.retrieve'
                    $hint = 'Try retrieving the recorded stored response. Retrieval does not resend a steering update.'
                } else {
                    $hint = 'Inspect steering and response IDs. The original connection cannot be resumed. Do not automatically replay.'
                }
            } elseif ($session) {
                $remoteId = $session
                $operation = 'sessions.retrieve'
                $hint = 'Verify the original session and check for required actions.'
                if ($job.PSObject.Properties['daybreak'] -and $job.PSObject.Properties['turnId']) {
                    $remoteId = $job.turnId
                    $operation = 'sessions.turns.retrieve'
                    $parameters = @{ session_id = $session }
                    $hint = 'Retrieve the recorded turn in the original session. Inspect the session separately for configuration evidence.'
                }
            } elseif ($job.operation -ceq 'sessions.create' -and $job.PSObject.Properties['daybreak'] -and $job.daybreak.jobRef) {
                $operation = 'sessions.list'
                $parameters = @{ metadata = @{ job_ref = $job.daybreak.jobRef } }
                $hint = 'Look for the original session in the same project using this job reference.'
            } elseif ($job.PSObject.Properties['workspaceTriggerId'] -and $job.PSObject.Properties['workspaceRunId']) {
                $remoteId = $job.workspaceTriggerId
                $operation = 'workspace.status'
                $parameters = @{ run_id = $job.workspaceRunId }
                $hint = 'Check the recorded run with its Workspace Agent identity.'
            } elseif ($file) {
                $remoteId = $file
                $operation = 'files.retrieve'
                $hint = 'Verify File metadata and use files.content when this purpose allows download.'
            } elseif ($job.operation -cin 'files.create','uploads.complete','uploads.transfer') {
                $remoteId = Get-KnownJobId $job 'observedFileId' $fileIdPattern
                if ($remoteId) {
                    $operation = 'files.retrieve'
                    $hint = 'Check the observed File metadata against the original upload. Its identity and upload outcome are unconfirmed.'
                }
            }
        }
        if ($operation -and $category -eq 'reconcile') { $category = 'verify_remote' }
        $job | Add-Member -NotePropertyName next -NotePropertyValue @{
            action = $operation; id = $remoteId; request = $parameters; hint = $hint
            category = $category; source = 'local_checkpoint'
        }
    }
}
ConvertTo-Json -InputObject $jobs -Depth 5
