#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position=0)][ValidateSet('Submit', 'Status', 'ReleaseUnconfirmed')][string]$Action,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_-]{0,79}\z')][string]$Pool = 'openai-shared',
    [System.Collections.IDictionary]$Request,
    [string]$StableInstructionsPath,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\z')][string]$WorkId,
    [ValidatePattern('\A[A-Za-z0-9._-]{1,120}\z')][string]$ProjectHint,
    [ValidatePattern('\A[a-f0-9]{32}\z')][string]$ExpectedAttempt,
    [string]$Directory,
    [ValidateRange(1,600)][int]$TimeoutSeconds = 60,
    [switch]$CapacityReviewed,
    [switch]$BillingReviewed,
    [switch]$Reconciled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OpenAiFailureClassification.ps1')
. (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
. (Join-Path $PSScriptRoot 'OpenAiQueueEvidence.ps1')
. (Join-Path $PSScriptRoot 'OpenAiPlatform.ps1')
if ($PWD.Provider.Name -ne 'FileSystem') { throw 'Select a filesystem working directory.' }
if ($Action -eq 'Submit') {
    $requestJson = ConvertTo-OpenAiDelegationRequest $Request
    $stableText = if ($StableInstructionsPath) {
        Read-OpenAiStableInstructions $StableInstructionsPath
    } else { '' }
    if ($StableInstructionsPath -and [string]::IsNullOrWhiteSpace($stableText)) { throw 'Expected nonempty stable instructions.' }
    $requestKey = Get-OpenAiDelegationRequestFingerprint $requestJson $stableText $ProjectHint
} elseif ($Request -or $StableInstructionsPath -or $CapacityReviewed -or $BillingReviewed -or $ProjectHint) {
    throw 'Request, instructions, project hint and quota review apply to Submit.'
}
if ($Reconciled -ne ($Action -eq 'ReleaseUnconfirmed')) {
    throw 'ReleaseUnconfirmed requires -Reconciled after independently checking the earlier attempt.'
}
if (($CapacityReviewed -or $BillingReviewed -or $Reconciled) -and !$ExpectedAttempt) {
    throw 'Pass -ExpectedAttempt with the ID of the attempt you reviewed.'
}

$api = Join-Path $PSScriptRoot 'openai-agents.ps1'
if (!$PSBoundParameters.ContainsKey('Directory')) { $Directory = Join-Path (Get-LegatusStateRoot) 'delegation' }
$baseDirectory = [IO.Path]::GetFullPath($Directory, $PWD.ProviderPath)
$root = (New-LegatusStateDirectory (Join-Path $baseDirectory $Pool.ToLowerInvariant())).FullName
$currentPath = Join-Path $root 'current.json'
$retiredDirectory = Join-Path $root 'retired'

function Get-HistoryPath([string]$Id) {
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Id)))
    Join-Path $root "work-$hash.json"
}

function Save-LocalText([string]$Destination, [string]$Value, [switch]$PublishResult) {
    $temporary = "$Destination.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value + "`n")
        $handle = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
        try { $handle.Write($bytes); $handle.Flush($true) }
        finally { $handle.Dispose() }
        [IO.File]::Move($temporary, $Destination, !$PublishResult)
        if ($PublishResult) {
            [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        }
    } finally { [IO.File]::Delete($temporary) }
}

function Read-LocalResult {
    if ($current['resultPublicationError']) { throw 'Existing result needs review after a publication error.' }
    $source = Read-OpenAiLocalBytes $resultPath 66MB
    if ($current['resultSha256']) {
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($source.bytes)).ToLowerInvariant()
        if ($hash -cne $current['resultSha256']) { throw 'Stored result changed after publication.' }
    }
    [Text.UTF8Encoding]::new($false, $true).GetString($source.bytes).TrimStart([char]0xfeff)
}

function Save-Current {
    Save-LocalText $currentPath ($current | ConvertTo-Json -Compress -Depth 16)
}

function Get-RetiredPath([string]$Attempt) {
    Join-Path $retiredDirectory ($Attempt + '.json')
}

function Remember-Retired {
    [void][IO.Directory]::CreateDirectory($retiredDirectory)
    $marker = Get-RetiredPath $current.attempt
    if (!(Test-Path -LiteralPath $marker)) {
        Save-LocalText $marker ($current | ConvertTo-Json -Compress -Depth 16)
    }
    $marker
}

function Get-QuotaReviewState($AttemptRecord) {
    $category = $AttemptRecord['quotaCategory']
    if (!$category) {
        $category = Get-OpenAiQuotaCategory $AttemptRecord.providerError $null $(if ($AttemptRecord['capacityReview']) {429})
    }
    switch ($category) {
        'billing' { 'review_billing' }
        'capacity' { 'review_shared_capacity' }
        'unclassified_429' { 'review_rate_limit' }
    }
}

function Test-QuotaReview($AttemptRecord, [string]$ReviewState) {
    if ($AttemptRecord['quotaReview'] -and $AttemptRecord['quotaReview']['state'] -ceq $ReviewState) { return $true }
    if ($ExpectedAttempt -cne $AttemptRecord.attempt) { return $false }
    if ($ReviewState -eq 'review_billing') { return [bool]$BillingReviewed }
    return [bool]$CapacityReviewed
}

function Confirm-QuotaReview([string]$ReviewState) {
    if (!$ReviewState -or !(Test-QuotaReview $current $ReviewState)) { return $false }
    if ($current['quotaReview'] -and $current['quotaReview']['state'] -cne $ReviewState) { [void]$current.Remove('quotaReview') }
    if (!$current['quotaReview']) {
        $current['quotaReview'] = @{ state = $ReviewState; reviewedAt = [DateTimeOffset]::UtcNow.ToString('o') }
        Save-Current
        # A late acceptance can still have a marker for the same current attempt.
        if ($current.state -eq 'terminal') { Complete-Retired }
    }
    return $true
}

function Complete-Retired {
    $marker = Get-RetiredPath $current.attempt
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
        if ($current['workId']) {
            Save-LocalText (Get-HistoryPath $current['workId']) ($current | ConvertTo-Json -Compress -Depth 16)
        }
        if ((Get-QuotaReviewState $current) -or $current['resultPublicationError']) {
            Save-LocalText $marker ($current | ConvertTo-Json -Compress -Depth 16)
        } else {
            [IO.File]::Delete($marker)
        }
    }
}

function Set-QuotaObservation($Code, $Type, $HttpStatus, $Headers, [string]$ActionName, [switch]$FromDisk,
    [string]$OriginalTime, [string]$HeaderMethod, [string]$HeaderScope) {
    if ($Code -cne $current.providerError -or $Type -cne $current['providerErrorType'] -or
        $HttpStatus -ne $current['providerHttpStatus'] -or ($OriginalTime -and $OriginalTime -cne $current.observedAt)) {
        [void]$current.Remove('quotaReview')
    }
    $current.providerError = $Code
    $current['providerErrorType'] = $Type
    $current['providerHttpStatus'] = $HttpStatus
    $current['quotaCategory'] = Get-OpenAiQuotaCategory $Code $Type $HttpStatus
    $current.capacityReview = $current['quotaCategory'] -in 'capacity','unclassified_429'
    if (!$FromDisk -or $Headers -or $OriginalTime) { $current.rateHeaders = $Headers }
    if (!$FromDisk -or $OriginalTime) {
        $current.observedAt = $OriginalTime
        $current['headerAction'] = if ($Headers) { $ActionName }
        $current['headerMethod'] = if ($Headers) { $HeaderMethod }
        $current['headerScope'] = if ($Headers) { $HeaderScope }
    }
    if ($FromDisk -and !$current['recoveredAt']) { $current['recoveredAt'] = [DateTimeOffset]::UtcNow.ToString('o') }
    if ($ActionName -eq 'responses.create' -and (!$FromDisk -or $OriginalTime)) {
        $current['submitHeaders'] = $Headers
        $current['submitObservedAt'] = $OriginalTime
        $current['submitHeaderMethod'] = $current['headerMethod']
        $current['submitHeaderScope'] = $current['headerScope']
    }
}

function Save-Observation([string]$Wire, $Observed, [switch]$FromDisk) {
    if (!$Observed) { $Observed = Get-OpenAiResponseObservation $Wire }
    if ($current.responseId -and $Observed.id -cne $current.responseId) {
        throw 'Retrieved Response identity does not match.'
    }
    if ($current.state -eq 'terminal' -and $current.responseStatus -and $Observed.status -cne $current.responseStatus) {
        throw 'Observation conflicts with a previously recorded terminal status.'
    }
    if (!$current.responseId -and ($FromDisk -or $current['clientRequestId']) -and
        ($Observed.receipt.action -cne 'responses.create' -or !$current['clientRequestId'] -or
         $Observed.receipt['clientRequestId'] -cne $current['clientRequestId'])) {
        throw 'An independent acceptance or matching create correlation is required.'
    }
    $terminal = $Observed.terminal
    if (($FromDisk -or $current.state -eq 'terminal') -and !$terminal) {
        throw 'Expected the known terminal Response status.'
    }
    $current.responseId = $Observed.id
    $current.responseStatus = $Observed.status
    [void]$current.Remove('retrievalFailure')
    $safetyOutcome = $Observed.receipt['safetyOutcome']
    if ($safetyOutcome -cin 'provider-cyber-policy','content-refusal','content-filter') {
        $current['safetyOutcome'] = $safetyOutcome
    }
    $failure = $Observed.error
    $code = if ($failure) { $failure['code'] }
    $type = if ($failure) { $failure['type'] }
    $headerTime = Get-OpenAiZonedTimestamp $Observed.receipt['headerObservedAt']
    $headers = if (!$FromDisk -or $headerTime) { $Observed.receipt['headers'] }
    Set-QuotaObservation $code $type $null $headers $Observed.receipt.action -FromDisk:$FromDisk -OriginalTime $headerTime `
        -HeaderMethod $Observed.receipt['sourceMethod'] -HeaderScope $Observed.receipt['headerScope']
    if ($terminal) {
        $current.state = 'terminal'
        if (!$FromDisk) {
            try {
                $current['resultSha256'] = Save-LocalText $resultPath $Wire -PublishResult
                [void]$current.Remove('resultPublicationError')
            } catch {
                $current['resultPublicationError'] = $_.Exception.GetType().Name
            }
        } else {
            [void]$current.Remove('resultPublicationError')
        }
    }
    [void]$current.Remove('observationPersistence')
    try {
        Save-Current
        if ($terminal) { Complete-Retired }
    } catch {
        $current['observationPersistence'] = 'reconcile-local-state'
    }
}

function Save-Rejection($Failure, [switch]$FromDisk) {
    if (!$Failure) { return $false }
    if ($Failure['outcomeUnconfirmed'] -isnot [bool] -or $Failure['outcomeUnconfirmed']) { return $false }
    $noSend = $Failure['dispatch'] -ceq 'not-attempted'
    $rejected = ($Failure['httpStatus'] -is [int] -or $Failure['httpStatus'] -is [long]) -and
        $Failure['httpStatus'] -in 400,401,403,404,405,413,415,422,429
    if (!$noSend -and !$rejected) { return $false }
    $current.state = 'not_accepted'
    $current['dispatchOutcome'] = if ($noSend) { 'not_sent' } else { 'explicitly_rejected' }
    $receipt = $Failure['receipt']
    if ($Failure['apiCode'] -ceq 'cyber_policy' -or $Failure['apiType'] -ceq 'cyber_policy') {
        $current['safetyOutcome'] = 'provider-cyber-policy'
    }
    $sourceTime = Get-OpenAiZonedTimestamp $Failure['headerObservedAt']
    $sourceMethod = if ($Failure['sourceMethod']) { $Failure['sourceMethod'] } elseif ($receipt) { $receipt['sourceMethod'] }
    Set-QuotaObservation $Failure['apiCode'] $Failure['apiType'] $Failure['httpStatus'] $Failure['headers'] 'responses.create' `
        -FromDisk:$FromDisk -OriginalTime $sourceTime -HeaderMethod $sourceMethod -HeaderScope $Failure['headerScope']
    Save-Current
    return $true
}

function Assert-LocalRecord($Record) {
    if ($Record -isnot [System.Collections.IDictionary] -or $Record['version'] -ne 1 -or
        $Record['attempt'] -cnotmatch '\A[a-f0-9]{32}\z' -or
        $Record['state'] -cnotin 'dispatching','active','terminal','not_accepted','released_after_reconciliation' -or
        ($Record['state'] -in 'active','terminal' -and $Record['responseId'] -cnotmatch '\Aresp_[A-Za-z0-9_-]+\z')) {
        throw 'Invalid local delegation record. Reconcile the earlier attempt before sending another request.'
    }
    foreach ($field in 'responseId','responseStatus','providerError','rateHeaders','observedAt','capacityReview') {
        if (!$Record.Contains($field)) { $Record[$field] = $null }
    }
}

function Show-Current([string]$State, $Submitted = $false) {
    $verifiedPath = $null
    $resultState = 'missing'
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        try {
            if ($current['resultPublicationError']) { throw 'Existing result needs review after a publication error.' }
            $fileResult = Get-OpenAiResponseObservation (Read-LocalResult)
            if ($current.state -ne 'terminal' -or !$fileResult.terminal -or $fileResult.id -cne $current.responseId -or
                $fileResult.status -cne $current.responseStatus) {
                throw 'Stored result does not match the recorded terminal Response.'
            }
            $resultState = 'verified'
            $verifiedPath = $resultPath
        } catch {
            $State = 'local_result_invalid'
            $resultState = 'invalid'
        }
    }
    if ($resultState -eq 'missing' -and $current.state -eq 'terminal' -and $current['resultPublicationError']) {
        $State = 'local_result_pending'
    }
    [pscustomobject]@{
        pool = $Pool; state = $State; submitted = $Submitted
        attempt = $current.attempt; responseId = $current.responseId
        workId = $current['workId']; projectHint = $current['projectHint']
        requestFingerprint = $current['requestKey']; requestFingerprintVersion = $current['requestKeyVersion']
        dispatchOutcome = if ($current.responseId) { 'accepted_with_id' } else { $current['dispatchOutcome'] }
        remoteTerminal = $current.state -eq 'terminal'
        responseStatus = $current.responseStatus; providerError = $current.providerError
        providerHttpStatus = $current['providerHttpStatus']; providerErrorType = $current['providerErrorType']
        quotaCategory = $current['quotaCategory']; quotaReview = $current['quotaReview']
        safetyOutcome = $current['safetyOutcome']
        rateHeaders = $current.rateHeaders; observedAt = $current.observedAt; receiptPath = $checkpoint
        headerAction = $current['headerAction']; headerMethod = $current['headerMethod']; headerScope = $current['headerScope']
        submitHeaders = $current['submitHeaders']; submitHeaderMethod = $current['submitHeaderMethod']; submitHeaderScope = $current['submitHeaderScope']
        submitObservedAt = $current['submitObservedAt']
        recoveredAt = $current['recoveredAt']; resultState = $resultState; resultPath = $verifiedPath
        resultPublicationError = $current['resultPublicationError']; observationPersistence = $current['observationPersistence']
        resultSha256 = if ($resultState -eq 'verified') { $current['resultSha256'] }
        resultIntegrity = if ($resultState -eq 'verified') { if ($current['resultSha256']) { 'sha256' } else { 'identity-only' } }
        retrievalFailure = $current['retrievalFailure']
        next = if ($State -eq 'local_result_pending') { 'Recover the saved Response by ID using Status after resolving the local destination.' }
            elseif ($State -eq 'review_retrieval') { 'Review the effective project, authorization and Response availability, then use Status on the same attempt.' }
        unverifiedResultPath = if ($resultState -eq 'invalid') { $resultPath }
        conflictingObservationPath = if ($State -eq 'terminal_observation_conflict') { $resultPath + '.conflict.json' }
    }
}

function Read-KnownResponse {
    try {
        $wire = & $api responses.retrieve -Id $current.responseId -TimeoutSeconds $TimeoutSeconds
    } catch {
        $wire = $_.Exception.Data['OpenAiLocalApiResult']
        if (!$wire) {
            $failure = $_.Exception.Data['OpenAiLocalAgents']
            $status = if ($failure) { $failure['httpStatus'] }
            $category = if ($status -in 401,403,404,410) { 'access_or_availability_review' }
                elseif ($failure) { Get-OpenAiQuotaCategory $failure['apiCode'] $failure['apiType'] $status }
            $current['retrievalFailure'] = @{
                category = if ($category) { $category } else { 'retryable_or_unclassified' }
                httpStatus = $status; observedAt = [DateTimeOffset]::UtcNow.ToString('o')
                apiCode = if ($failure) { $failure['apiCode'] }; apiType = if ($failure) { $failure['apiType'] }
            }
            try { Save-Current } catch { $current['observationPersistence'] = 'reconcile-local-state' }
            Write-Warning 'Could not retrieve the known Response. Its local record is retained.'
            return (Show-Current $(if ($category -in 'access_or_availability_review','billing') { 'review_retrieval' } else { 'retry_retrieval' }))
        }
    }
    $observed = Get-OpenAiResponseObservation $wire
    if ($observed.receipt.action -cne 'responses.retrieve') { throw 'Expected a Responses retrieve receipt.' }
    if ($current.state -eq 'terminal' -and $observed.id -ceq $current.responseId -and
        $current.responseStatus -and $observed.status -cne $current.responseStatus) {
        $conflict = $resultPath + '.conflict.json'
        if (!(Test-Path -LiteralPath $conflict)) { Save-LocalText $conflict $wire }
        return (Show-Current 'terminal_observation_conflict')
    }
    Save-Observation $wire -Observed $observed
    Show-Current $current.state
}

function Get-SubmitRecord {
    $record = Read-OpenAiSubmitJournal $checkpoint
    if ($current['clientRequestId'] -and $record['clientRequestId'] -and
        $record['clientRequestId'] -cne $current['clientRequestId']) { return @{kind='invalid'} }
    $record
}

function Set-SubmitAcceptance($Record) {
    $current.responseId = $Record.responseId
    $current.state = 'active'
    $current['submitHeaders'] = $Record['headers']
    $current['submitObservedAt'] = Get-OpenAiZonedTimestamp $Record['headerObservedAt']
    $current['submitHeaderMethod'] = $Record['sourceMethod']
    $current['submitHeaderScope'] = $Record['headerScope']
    $current['recoveredAt'] = [DateTimeOffset]::UtcNow.ToString('o')
}

function Read-RetiredAttempt([string]$Marker, [switch]$Poll) {
    $currentPath = $Marker
    $current = ConvertFrom-OpenAiJsonObject (Read-OpenAiLocalText $Marker 2MB)
    Assert-LocalRecord $current
    if ([IO.Path]::GetFileNameWithoutExtension($Marker) -cne $current.attempt -or
        $current.state -cnotin 'released_after_reconciliation','active','terminal') {
        throw 'Invalid retired delegation record.'
    }
    $attemptDirectory = Join-Path $root $current.attempt
    $checkpoint = Join-Path $attemptDirectory 'submit.jsonl'
    $resultPath = Join-Path $attemptDirectory 'result.json'
    $record = Get-SubmitRecord
    if ($record.kind -eq 'invalid') { return (Show-Current 'invalid_submit_journal') }
    if ($record.kind -eq 'positive') {
        if ($current.responseId -and $current.responseId -cne $record.responseId) {
            throw 'Retired work has conflicting Response identities.'
        }
        if (!$current.responseId) { Set-SubmitAcceptance $record }
    }
    if ($current.state -eq 'terminal' -and ($reviewState = Get-QuotaReviewState $current)) {
        if ($Poll -and $current['resultPublicationError'] -and !(Test-Path -LiteralPath $resultPath -PathType Leaf)) { return (Read-KnownResponse) }
        if ($Poll) { return (Show-Current $current.state) }
        if (Confirm-QuotaReview $reviewState) {
            $observed = Show-Current $current.state
            if ($observed.resultState -ne 'verified') { return $observed }
            [IO.File]::Delete($Marker)
            return
        }
        return (Show-Current $reviewState)
    }
    if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
        try { Save-Observation (Read-LocalResult) -FromDisk }
        catch { return (Show-Current 'local_result_invalid') }
        return (Show-Current 'late_acceptance')
    }
    if (!$current.responseId) { return }
    if ($current.state -ne 'terminal') { $current.state = 'active' }
    Save-Current
    if ($Poll) { return (Read-KnownResponse) }
    Show-Current 'late_acceptance'
}

function Find-RetiredAcceptance([switch]$Poll) {
    if (!(Test-Path -LiteralPath $retiredDirectory -PathType Container)) { return }
    foreach ($marker in Get-ChildItem -LiteralPath $retiredDirectory -File -Filter '*.json') {
        $observed = Read-RetiredAttempt $marker.FullName -Poll:$Poll
        if ($observed) { return $observed }
    }
}

try { $lock = [IO.File]::Open((Join-Path $root 'pool.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch [IO.IOException] {
    $failure = $_.Exception.GetBaseException()
    $contentionCodes = if ($IsWindows) { 32,33 } elseif ($IsMacOS) { 35 } else { 11 }
    if ($failure -isnot [IO.IOException] -or ($failure.HResult -band 0xffff) -notin $contentionCodes) { throw }
    return [pscustomobject]@{ pool = $Pool; state = 'busy'; submitted = $false }
}
try {
    $current = $null
    if (Test-Path -LiteralPath $currentPath) {
        $current = ConvertFrom-OpenAiJsonObject (Read-OpenAiLocalText $currentPath 2MB)
        Assert-LocalRecord $current
    }
    if ($ExpectedAttempt -and (!$current -or $current.attempt -cne $ExpectedAttempt) -and
        !($Action -eq 'Submit' -and ($CapacityReviewed -or $BillingReviewed) -and
          (Test-Path -LiteralPath (Get-RetiredPath $ExpectedAttempt) -PathType Leaf))) {
        return [pscustomobject]@{ pool=$Pool; state='attempt_changed'; submitted=$false
            attempt=$(if ($current) { $current.attempt }) }
    }
    if ($current -and $ExpectedAttempt -and $current.attempt -cne $ExpectedAttempt -and ($CapacityReviewed -or $BillingReviewed)) {
        $target = Get-RetiredPath $ExpectedAttempt
        $targetResult = Read-RetiredAttempt $target
        if ($targetResult) { return $targetResult }
    }
    if ($Reconciled -and $WorkId -and (!$current -or $current['workId'] -cne $WorkId)) {
        throw 'The supplied work ID does not identify the current attempt.'
    }
    if ($WorkId -and (!$current -or $current['workId'] -cne $WorkId)) {
        $historyPath = Get-HistoryPath $WorkId
        if (Test-Path -LiteralPath $historyPath -PathType Leaf) {
            $archived = ConvertFrom-OpenAiJsonObject (Read-OpenAiLocalText $historyPath 2MB)
            Assert-LocalRecord $archived
            if ($archived['workId'] -cne $WorkId -or $archived.state -in 'active','dispatching') {
                throw 'Archived work ID does not match a resolved local attempt.'
            }
            if ($Action -eq 'Submit' -and $archived['requestKey'] -and $archived['requestKey'] -cne $requestKey) {
                return [pscustomobject]@{pool=$Pool;state='work_request_conflict';submitted=$false;workId=$WorkId;attempt=$archived.attempt}
            }
            if ($Action -eq 'Status' -or $archived.state -in 'terminal','released_after_reconciliation') {
                $current = $archived
                $attemptDirectory = Join-Path $root $current.attempt
                $checkpoint = Join-Path $attemptDirectory 'submit.jsonl'
                $resultPath = Join-Path $attemptDirectory 'result.json'
                if ($Action -eq 'Status' -and $current.state -eq 'terminal' -and
                    !(Test-Path -LiteralPath $resultPath -PathType Leaf)) {
                    $currentPath = $historyPath
                    return (Read-KnownResponse)
                }
                if ($current.state -eq 'released_after_reconciliation') {
                    $marker = Remember-Retired
                    $late = Read-RetiredAttempt $marker -Poll:($Action -eq 'Status')
                    if ($late) { return $late }
                }
                return (Show-Current 'existing_work')
            }
        }
        if ($Action -eq 'Status') { return [pscustomobject]@{pool=$Pool;state='work_not_found';submitted=$false;workId=$WorkId} }
    }
    if ($current) {
        if ($Action -eq 'Submit' -and $WorkId -and $current['workId'] -ceq $WorkId -and
            $current['requestKey'] -and $current['requestKey'] -cne $requestKey) {
            return [pscustomobject]@{pool=$Pool;state='work_request_conflict';submitted=$false;workId=$WorkId;attempt=$current.attempt}
        }
        $attemptDirectory = Join-Path $root $current.attempt
        $checkpoint = Join-Path $attemptDirectory 'submit.jsonl'
        $resultPath = Join-Path $attemptDirectory 'result.json'
        if ($current.state -eq 'released_after_reconciliation') {
            [void](Remember-Retired)
            $late = Get-SubmitRecord
            if ($late.kind -eq 'invalid') { return (Show-Current 'invalid_submit_journal') }
            if ($late.kind -eq 'positive') {
                Set-SubmitAcceptance $late
                Save-Current
                return (Show-Current 'late_acceptance')
            }
            if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
                if ($late.kind -eq 'invalid') { return (Show-Current 'invalid_submit_journal') }
                try { Save-Observation (Read-LocalResult) -FromDisk }
                catch { return (Show-Current 'local_result_invalid') }
                return (Show-Current 'late_acceptance')
            }
        }
        if ($current.state -eq 'dispatching') {
            $record = Get-SubmitRecord
            if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
                if ($record.kind -eq 'invalid') { return (Show-Current 'invalid_submit_journal') }
                try {
                    $savedWire = Read-LocalResult
                    $saved = Get-OpenAiResponseObservation $savedWire
                    if ($record.kind -eq 'positive' -and $record.responseId -cne $saved.id) {
                        throw 'The stored result conflicts with the submit receipt.'
                    }
                    if ($record.kind -eq 'positive') { Set-SubmitAcceptance $record }
                    Save-Observation $savedWire -Observed $saved -FromDisk
                } catch {
                    return (Show-Current 'local_result_invalid')
                }
                if ($Reconciled) { throw 'The local result establishes that this attempt was accepted.' }
                return (Show-Current $current.state)
            }
            if ($record.kind -eq 'positive') {
                Set-SubmitAcceptance $record
                Save-Current
            } elseif ($record.kind -eq 'error' -and (Save-Rejection $record -FromDisk)) {
                return (Show-Current $current.state)
            } elseif ($Action -eq 'ReleaseUnconfirmed') {
                $current.state = 'released_after_reconciliation'
                [void](Remember-Retired)
                Save-Current
                return (Show-Current $current.state)
            } else { return (Show-Current $(if ($record.kind -eq 'invalid') {'invalid_submit_journal'} else {'reconcile_dispatch'})) }
        }
        if ($Action -eq 'ReleaseUnconfirmed') { throw 'This attempt already has a known response or a resolved dispatch state.' }
        $hasResult = Test-Path -LiteralPath $resultPath -PathType Leaf
        if ($current.state -eq 'active' -or ($current.state -eq 'terminal' -and !$hasResult)) {
            if ($hasResult) {
                try { Save-Observation (Read-LocalResult) -FromDisk }
                catch { return (Show-Current 'local_result_invalid') }
                return (Show-Current $current.state)
            }
            return (Read-KnownResponse)
        }
        if ($Action -eq 'Status') {
            if (!$WorkId) {
                $late = Find-RetiredAcceptance -Poll
                if ($late) { return $late }
            }
            return (Show-Current $current.state)
        }
        if ($WorkId -and $current['workId'] -ceq $WorkId -and
            $current.state -in 'terminal','released_after_reconciliation') {
            return (Show-Current 'existing_work')
        }
        $reviewState = Get-QuotaReviewState $current
        if ($reviewState -and !(Confirm-QuotaReview $reviewState)) { return (Show-Current $reviewState) }
        if ($current.state -eq 'terminal' -and $hasResult) {
            $localResult = Show-Current $current.state
            if ($localResult.resultState -eq 'invalid') { return $localResult }
        }
        if ($current['workId']) {
            Save-LocalText (Get-HistoryPath $current['workId']) ($current | ConvertTo-Json -Compress -Depth 16)
        }
    } else {
        $orphan = Get-ChildItem -LiteralPath $root -Directory |
            Where-Object { $_.Name -cmatch '\A[a-f0-9]{32}\z' } | Select-Object -First 1
        if ($orphan) { return [pscustomobject]@{ pool=$Pool; state='orphaned_pool_state'; submitted=$false } }
        if ($Action -ne 'Submit') { return [pscustomobject]@{ pool=$Pool; state='empty'; submitted=$false } }
    }

    $late = Find-RetiredAcceptance
    if ($late) { return $late }

    $current = [ordered]@{ version = 1; attempt = [Guid]::NewGuid().ToString('N'); state = 'dispatching'
        responseId = $null; responseStatus = $null; providerError = $null; rateHeaders = $null
        observedAt = $null; capacityReview = $false; workId = $WorkId; projectHint = $ProjectHint
        dispatchOutcome = 'effect_unknown'; requestKey=$requestKey; requestKeyVersion=1; clientRequestId=[Guid]::NewGuid().ToString('N') }
    $attemptDirectory = [IO.Directory]::CreateDirectory((Join-Path $root $current.attempt)).FullName
    $checkpoint = Join-Path $attemptDirectory 'submit.jsonl'
    $resultPath = Join-Path $attemptDirectory 'result.json'
    Save-Current
    $arguments = @{ Json = $requestJson; CheckpointPath = $checkpoint; TimeoutSeconds = $TimeoutSeconds; ClientRequestId=$current.clientRequestId }
    if ($StableInstructionsPath) { $arguments.StableInstructionsText = $stableText }
    if ($ProjectHint) { $arguments.ProjectHint = $ProjectHint }
    try {
        $wire = & $api responses.create @arguments
    } catch {
        $wire = $_.Exception.Data['OpenAiLocalApiResult']
        if (!$wire) {
            $rejected = Save-Rejection $_.Exception.Data['OpenAiLocalAgents']
            Write-Warning 'Submission did not return a usable response. Inspect its receipt before resubmitting.'
            $submitted = if ($rejected) { $false }
            return (Show-Current $current.state $submitted)
        }
    }
    $accepted = Get-OpenAiResponseObservation $wire
    if ($accepted.receipt.action -cne 'responses.create') { throw 'Expected a Responses create receipt.' }
    $current.state = 'active'
    Save-Observation $wire -Observed $accepted
    Show-Current $current.state $true
} finally { $lock.Dispose() }
