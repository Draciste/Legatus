#Requires -Version 7.2
param(
    [ValidateSet('Models', 'Responses', 'RetrieveResponse', 'InputTokens', 'Batch', 'Security', 'SecurityLogin', 'Doctor')]
    [string]$Operation = 'Models',

    [string]$Json,

    [string]$ResponseId,

    [ValidateSet('Http', 'Cli', 'Wsl')]
    [string]$Transport = 'Http',

    [string[]]$SecurityArgs,

    [ValidateSet('Submit', 'List', 'Get', 'Cancel', 'File')]
    [string]$BatchAction,

    [string]$BatchTarget,

    [string]$BatchAfter,

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds,

    [ValidateRange(1, 512)]
    [int]$MaxOutputMiB = 64,

    [ValidateRange(1, 256)]
    [int]$MaxInputMiB = 32,

    [switch]$IncludeReceipt,

    [string]$BatchCompletionWindow,

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\z')]
    [string]$ClientRequestId,

    [string]$CheckpointPath,

    [ValidatePattern('\Aproj_[A-Za-z0-9_-]{1,128}\z')]
    [string]$CheckpointProject,

    [switch]$IncludeNativeDiagnostics,

    [switch]$CheckReadiness
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OpenAiChildEnvironment.ps1')
. (Join-Path $PSScriptRoot 'OpenAiFailureClassification.ps1')
. (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
. (Join-Path $PSScriptRoot 'OpenAiPlatform.ps1')
$checkpointFile = $null
$batchInputEvidence = $null

function Write-LocalApiCheckpoint {
    param([string]$State, [System.Collections.IDictionary]$Details)
    if (!$checkpointFile) { return }
    $entry = [ordered]@{ version = 2; state = $State; utc = [DateTimeOffset]::UtcNow.ToString('o');
        operation = $Operation; transport = $Transport; attemptId = $attemptId }
    if ($Operation -eq 'Batch') { $entry.batchAction = $BatchAction }
    if ($Operation -eq 'Batch' -and $BatchAction -eq 'Cancel') { $entry.batchId = $BatchTarget }
    if ($CheckpointProject) { $entry.projectHint = $CheckpointProject }
    if ($effectiveClientRequestId) { $entry.clientRequestId = $effectiveClientRequestId }
    if ($batchInputEvidence) {
        $entry.sourceBytes = $batchInputEvidence.bytes
        $entry.sourceSha256 = $batchInputEvidence.sha256
    }
    foreach ($name in 'kind', 'requestId', 'responseId', 'responseStatus', 'batchId', 'batchStatus',
        'observedBatchStatus', 'observedResponseStatus', 'resourceStatusClassification', 'responseOutputIssue',
        'inputFileId', 'batchCreateState', 'scanId', 'scanStatus') {
        if ($Details -and $Details[$name] -is [string] -and $Details[$name] -cmatch '\A[A-Za-z0-9_-]{1,240}\z') {
            $entry[$name] = $Details[$name]
        }
    }
    foreach ($name in 'outcomeUnconfirmed', 'checkNativeState', 'localExitConfirmed', 'localIoSettled') {
        if ($Details -and $Details[$name] -is [bool]) { $entry[$name] = $Details[$name] }
    }
    foreach ($name in 'headers', 'headerMethod', 'headerObservedAt', 'headerScope') {
        if ($Details -and $Details[$name]) { $entry[$name] = $Details[$name] }
    }
    foreach ($name in 'status', 'errorCode', 'errorType', 'retryAfterSeconds') {
        if ($Details -and $null -ne $Details[$name]) { $entry[$name] = $Details[$name] }
    }
    foreach ($name in 'recoveryConflictFields','recoveryEvidence') {
        if ($Details -and $Details[$name]) { $entry[$name] = $Details[$name] }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($entry | ConvertTo-Json -Compress -Depth 5) + "`n")
    try {
        $checkpointFile.Write($bytes, 0, $bytes.Length)
        $checkpointFile.Flush($true)
    } catch {
        if ($State -eq 'dispatch_pending') { throw }
        if ($Details) { $Details.checkpointWriteFailed = $true }
        Write-Warning 'Could not persist the post-dispatch checkpoint. Reconcile using the returned receipt before replaying.'
    }
}

function Start-LocalApiCheckpoint {
    if (!$CheckpointPath) { return }
    try {
        $path = [IO.Path]::GetFullPath($CheckpointPath, $PWD.ProviderPath)
        $script:checkpointFile = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::Read)
        Write-LocalApiCheckpoint 'dispatch_pending' $null
    } catch {
        Close-LocalApiCheckpoint
        Stop-LocalApiSetup 'Could not create and flush a new local checkpoint. Request was not dispatched.' 'checkpoint'
    }
}

function Close-LocalApiCheckpoint {
    if (!$checkpointFile) { return }
    try { $checkpointFile.Dispose() }
    catch { Write-Warning 'The local checkpoint could not be closed cleanly.' }
    finally { $script:checkpointFile = $null }
}

function Stop-LocalApiCall {
    param(
        [string]$Message,
        [System.Collections.IDictionary]$Details,
        [string]$Result
    )
    Write-LocalApiCheckpoint 'error' $Details
    $errorDetails = [InvalidOperationException]::new($Message)
    $errorDetails.Data['OpenAiLocalApi'] = $Details
    if ($Result) { $errorDetails.Data['OpenAiLocalApiResult'] = $Result }
    throw $errorDetails
}

function Stop-LocalApiSetup {
    param([string]$Message, [string]$Kind = 'validation')
    Stop-LocalApiCall $Message ([ordered]@{
        kind = $Kind
        operation = $Operation
        transport = $Transport
        outcomeUnconfirmed = $false
    })
}

function Read-LocalApiResult {
    param(
        [System.Threading.Tasks.Task]$Task,
        [System.Threading.CancellationToken]$Token
    )
    while (!$Task.IsCompleted) {
        $Token.ThrowIfCancellationRequested()
        Start-Sleep -Milliseconds 40
    }
    return $Task.GetAwaiter().GetResult()
}

function New-LocalApiBatchSnapshot {
    param([string]$Path, [long]$Limit)
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('openai-batch-' + [Guid]::NewGuid().ToString('N'))
    $snapshotPath = Join-Path $directory ([IO.Path]::GetFileName($Path))
    $ownsDirectory = $false
    try {
        $source = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ($source.Length -le 0 -or $source.Length -gt $Limit) {
                Stop-LocalApiSetup 'Batch input is empty or exceeds the selected byte limit.' 'input_limit'
            }
            if ($IsWindows) {
                $null = New-Item -ItemType Directory -Path $directory
            } else {
                $directory = [IO.Directory]::CreateTempSubdirectory('openai-batch-').FullName
                $snapshotPath = Join-Path $directory ([IO.Path]::GetFileName($Path))
            }
            $ownsDirectory = $true
            $target = [IO.File]::Open($snapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
            try {
                $buffer = [byte[]]::new(64KB)
                while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($target.Position + $count -gt $Limit) {
                        Stop-LocalApiSetup 'Batch input exceeds the selected byte limit.' 'input_limit'
                    }
                    $target.Write($buffer, 0, $count)
                    $hash.AppendData($buffer, 0, $count)
                }
                if (!$target.Length) { Stop-LocalApiSetup 'Batch input is empty.' 'input_limit' }
                $evidence = @{bytes = $target.Length; sha256 = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()}
                $target.Flush($true)
            } finally { $target.Dispose(); $hash.Dispose() }
            return @{ handle = [IO.File]::OpenRead($snapshotPath); evidence = $evidence }
        } finally { $source.Dispose() }
    } catch {
        if ($ownsDirectory) { Remove-LocalApiBatchSnapshot $snapshotPath }
        if ($_.Exception.Data.Contains('OpenAiLocalApi')) { throw }
        Stop-LocalApiSetup 'Could not prepare a bounded Batch input snapshot.' 'input_read'
    }
}

function Remove-LocalApiBatchSnapshot {
    param([string]$Path)
    try {
        [IO.File]::Delete($Path)
        [IO.Directory]::Delete([IO.Path]::GetDirectoryName($Path))
    } catch { Write-Warning 'The temporary Batch input snapshot could not be removed.' }
}

function Invoke-LocalApiReadinessProbe {
    param([string]$Executable, [string[]]$Arguments, [string]$Expected)
    if (!$Executable -or !(Test-Path -LiteralPath $Executable -PathType Leaf)) { return [pscustomobject]@{ status = 'missing' } }
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $nativeHome
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    Clear-OpenAiChildEnvironment $start -Offline
    $start.Environment['OPENAI_CLI_NO_AUTO_UPDATE'] = '1'
    $start.Environment['OPENAI_CLI_NO_UPDATE_CHECK'] = '1'
    $budget = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(8))
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($start)
        $capture = [OpenAiLocalTransportV6+NativeCapture]::new()
        $pending = [OpenAiLocalTransportV6]::ReadNativeAsync($process, $null, 16KB, $budget.Token, $capture)
        $result = Read-LocalApiResult $pending $budget.Token
        $match = [regex]::Match($result.Output.Trim(), $Expected)
        if ($result.ExitCode -eq 0 -and $match.Success) {
            return [pscustomobject]@{ status = 'passed'; version = $match.Groups['version'].Value }
        }
        return [pscustomobject]@{ status = 'failed'; exitCode = $result.ExitCode }
    } catch {
        return [pscustomobject]@{ status = if ($budget.IsCancellationRequested) { 'timeout' } else { 'failed' } }
    } finally {
        $budget.Cancel()
        if ($process) {
            try {
                if (!$process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(1500) }
            } catch {} finally { $process.Dispose() }
        }
        $budget.Dispose()
    }
}

function Test-LocalApiReadiness {
    $lock = [string]::Intern('OpenAiLocalApi.TypeLoad.V4')
    [Threading.Monitor]::Enter($lock)
    try {
        if (!('OpenAiLocalTransportV6' -as [type])) {
            Add-Type -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalTransport.cs')
        }
    } finally { [Threading.Monitor]::Exit($lock) }
    if (!$IsWindows) {
        return [pscustomobject]@{
            scope = 'offline executable checks'
            cli = Invoke-LocalApiReadinessProbe $openAiCli @('--version') '\Aopenai version (?<version>[A-Za-z0-9.+-]+)\z'
            node = Invoke-LocalApiReadinessProbe (Find-LegatusProgram 'node') @('--version') '\Av(?<version>\d+\.\d+\.\d+)\z'
            tokenizerO200kBase = [pscustomobject]@{ status = 'missing' }
            codexSecurityWindowsBuild = $false
        }
    }
    $python = Join-Path $programs 'OpenAI-Tiktoken/.venv/Scripts/python.exe'
    $cache = Join-Path $programs 'OpenAI-Tiktoken/encodings'
    $knownAnswer = @'
import os, sys
os.environ["TIKTOKEN_CACHE_DIR"] = sys.argv[1]
from unittest.mock import patch
import tiktoken
with patch("tiktoken.load.read_file", side_effect=RuntimeError("Offline cache required")):
    enc = tiktoken.get_encoding("o200k_base")
    assert enc.encode_ordinary("hello") == [24912]
print("tiktoken " + tiktoken.__version__)
'@
    $nodeProbe = Invoke-LocalApiReadinessProbe $node @('--version') '\Av(?<version>\d+\.\d+\.\d+)\z'
    [pscustomobject]@{
        scope = 'offline executable checks, build entrypoints and one cached tokenizer known answer'
        cli = Invoke-LocalApiReadinessProbe $openAiCli @('--version') '\Aopenai version (?<version>[A-Za-z0-9.+-]+)\z'
        node = $nodeProbe
        tokenizerO200kBase = Invoke-LocalApiReadinessProbe $python @('-I', '-c', $knownAnswer, $cache) '\Atiktoken (?<version>[A-Za-z0-9.+-]+)\z'
        codexSecurityWindowsBuild = $nodeProbe.status -eq 'passed' -and
            (Test-Path -LiteralPath $securityEntry -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $securityRoot 'dist/cli.js') -PathType Leaf)

    }
}

function ConvertFrom-LocalApiJson {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    try {
        ConvertFrom-OpenAiJsonObject $Text 64
    } catch {
        # Unusable diagnostics must not replace the original failure.
    }
}

function Get-LocalApiScanEvidence {
    param([string]$Body)
    $parsed = ConvertFrom-LocalApiJson $Body
    if ($parsed -isnot [System.Collections.IDictionary]) { return }
    $envelopeAccepted = $true
    if ($parsed.Contains('ok')) {
        $envelopeAccepted = $parsed['ok'] -is [bool] -and $parsed['ok']
        if ($parsed['data'] -is [System.Collections.IDictionary]) { $parsed = $parsed['data'] }
    }
    $manifest = $parsed['manifest']
    if ($manifest -isnot [System.Collections.IDictionary]) { return }
    $scan = $manifest['scan']
    if ($scan -isnot [System.Collections.IDictionary] -or
        $scan['status'] -isnot [string] -or $scan['status'] -cnotmatch '\A[a-z][a-z0-9_-]{0,79}\z') { return }
    [pscustomobject]@{
        status = $scan['status']
        id = if ($scan['id'] -is [string] -and $scan['id'] -cmatch '\A[A-Za-z0-9_-]{1,200}\z') { $scan['id'] }
        completed = $envelopeAccepted -and $scan['status'] -ceq 'completed'
    }
}

function Add-LocalApiErrorFields {
    param([System.Collections.IDictionary]$Details, $Parsed)
    if ($Parsed -isnot [System.Collections.IDictionary]) { return }
    $statusCode = $Parsed['status_code']
    if (!$Details['status'] -and $statusCode -is [long] -and $statusCode -ge 400 -and $statusCode -le 599) {
        $Details.status = $statusCode
    }
    $apiError = $Parsed['error']
    if ($apiError -is [System.Collections.IDictionary] -and $apiError['error'] -is [System.Collections.IDictionary]) {
        $apiError = $apiError['error']
    }
    if ($apiError -is [System.Collections.IDictionary]) {
        if ($apiError['code'] -is [string] -and $apiError['code'] -cmatch '\A[a-z][a-z0-9_]{0,79}\z') {
            $Details.errorCode = $apiError['code']
        }
        if ($apiError['type'] -is [string] -and $apiError['type'] -cmatch '\A[a-z][a-z0-9_]{0,79}\z') {
            $Details.errorType = $apiError['type']
        }
    } elseif ($Parsed['message'] -is [string] -and $Parsed['message'].StartsWith('Could not connect to the API.', [StringComparison]::Ordinal)) {
        $Details.kind = 'connection'
    }
    $quotaCategory = Get-OpenAiQuotaCategory $Details['errorCode'] $Details['errorType'] $Details['status']
    if ($quotaCategory -eq 'billing') {
        $Details.kind = 'quota'
    } elseif ($quotaCategory) {
        $Details.kind = 'rate_limit'
    } elseif ($Details['status'] -eq 401 -or $Details['errorCode'] -ceq 'invalid_api_key') {
        $Details.kind = 'authentication'
    } elseif ($Details['status'] -eq 403) {
        $Details.kind = 'access_denied'
    } elseif ($Details['status'] -eq 404) {
        $Details.kind = 'not_found'
    } elseif ($Details['status'] -in 400, 422 -or $Details['errorType'] -ceq 'invalid_request_error') {
        $Details.kind = 'api_validation'
    }
}

function Add-LocalApiHttpFields {
    param([System.Collections.IDictionary]$Details, $Response)
    if ($Response.Status) { $Details.status = $Response.Status }
    if ($Response.Headers.Count) {
        $Details.headers = $Response.Headers
        $Details.headerMethod = $Response.Method
        $Details.headerObservedAt = $Response.ObservedAt
        $Details.headerScope = 'request-only'
    }
    if ($Response.RequestId -cmatch '\Areq_[A-Za-z0-9_-]{1,120}\z') { $Details.requestId = $Response.RequestId }
    if ($null -ne $Response.RetryAfterSeconds -and $Response.RetryAfterSeconds -le [int]::MaxValue) {
        $Details.retryAfterSeconds = [int]$Response.RetryAfterSeconds
    }
}

function Add-LocalApiRecoveryEvidence {
    param([System.Collections.IDictionary]$Details, [System.Collections.IDictionary]$Sources)
    $isResponse = $Operation -eq 'Responses'
    if (!$isResponse -and !($Operation -eq 'Batch' -and $BatchAction -eq 'Submit')) { return }

    $fields = if ($isResponse) {
        [ordered]@{ responseId = '\Aresp_[A-Za-z0-9_-]{1,200}\z'; responseStatus = '\A[a-z][a-z0-9_]{0,79}\z' }
    } else {
        [ordered]@{ stage = '\A(?:preparation|upload|create|receipt|wait)\z'; input_file_id = '\Afile[-_][A-Za-z0-9_-]{1,200}\z'; batch_id = '\Abatch_[A-Za-z0-9_-]{1,200}\z' }
    }
    $recovery = [ordered]@{}
    $evidence = [ordered]@{}
    $conflicts = [Collections.Generic.HashSet[string]]::new()
    foreach ($name in $Sources.Keys) {
        $source = $Sources[$name]
        if (!$source -or $source.Length -gt 256KB -or [Text.Encoding]::UTF8.GetByteCount($source) -gt 256KB) { continue }
        $parsed = ConvertFrom-LocalApiJson $source
        if ($parsed -isnot [System.Collections.IDictionary]) { continue }
        $receipts = if ($isResponse) {
            if ((!$parsed.Contains('object') -or $parsed['object'] -ceq 'response') -and
                $parsed['id'] -is [string] -and $parsed['id'] -cmatch $fields['responseId']) {
                @{ responseId = $parsed['id']; responseStatus = $parsed['status'] }
            }
        } else {
            if ($parsed['batch_submission'] -is [System.Collections.IDictionary]) { $parsed['batch_submission'] }
            if ($parsed['object'] -is [string] -and $parsed['object'] -ceq 'batch') {
                @{ stage = 'receipt'; batch_id = $parsed['id']; input_file_id = $parsed['input_file_id'] }
            }
        }
        foreach ($receipt in $receipts) {
            foreach ($field in $fields.Keys) {
                $value = $receipt[$field]
                if ($value -isnot [string] -or $value -cnotmatch $fields[$field]) { continue }
                if (!$evidence.Contains($field)) { $evidence[$field] = @() }
                if ($name -notin $evidence[$field]) { $evidence[$field] += $name }
                if ($conflicts.Contains($field)) { continue }
                if ($recovery.Contains($field) -and $recovery[$field] -cne $value) {
                    $recovery.Remove($field)
                    [void]$conflicts.Add($field)
                } else { $recovery[$field] = $value }
            }
        }
    }
    if ($isResponse -and $recovery['responseId']) {
        $Details.responseId = $recovery['responseId']
        if ($recovery['responseStatus']) { $Details.responseStatus = $recovery['responseStatus'] }
    } elseif (!$isResponse -and $recovery.Count) {
        $Details.recovery = $recovery
        if ($recovery['input_file_id']) { $Details.inputFileId = $recovery['input_file_id'] }
        if ($recovery['batch_id']) { $Details.batchId = $recovery['batch_id'] }
        if ($conflicts.Count -eq 0 -and !$recovery['batch_id'] -and $recovery['stage'] -in 'preparation', 'upload') {
            $Details.batchCreateState = 'not-dispatched'
            $Details.outcomeUnconfirmed = $recovery['stage'] -eq 'upload'
        } else {
            $Details.batchCreateState = if ($recovery['batch_id']) { 'id-observed' } else { 'unknown' }
        }
    }
    if ($evidence.Count) { $Details.recoveryEvidence = $evidence }
    if ($conflicts.Count) { $Details.recoveryConflictFields = @($conflicts) }
}

function Get-LocalApiCapturedSources {
    param([System.Collections.IDictionary]$Details, $Capture, [switch]$Http)
    $stdout = $Capture.Snapshot($false)
    if ($stdout.Item2) { $Details.stdoutTruncated = $true }
    if ($Http) { return [ordered]@{ http = $stdout.Item1 } }
    $stderr = $Capture.Snapshot($true)
    if ($stderr.Item2) { $Details.diagnosticTruncated = $true }
    return [ordered]@{ stdout = $stdout.Item1; stderr = $stderr.Item1 }
}

function Get-LocalResponseOutputIssue([System.Text.Json.JsonElement]$Root, [string]$Status) {
    $output = [System.Text.Json.JsonElement]::new()
    if (!$Root.TryGetProperty('output', [ref]$output)) {
        if ($Status -ceq 'completed') { return 'output-array' }
        return
    }
    if ($output.ValueKind -ne 'Array') { return 'output-array' }
    foreach ($item in $output.EnumerateArray()) {
        $type = [System.Text.Json.JsonElement]::new()
        if ($item.ValueKind -ne 'Object' -or !$item.TryGetProperty('type', [ref]$type) -or
            $type.ValueKind -ne 'String' -or [string]::IsNullOrWhiteSpace($type.GetString())) { return 'output-item' }
        if ($type.GetString() -ceq 'message') {
            $content = [System.Text.Json.JsonElement]::new()
            if (!$item.TryGetProperty('content', [ref]$content) -or $content.ValueKind -ne 'Array') { return 'output-message-content' }
            foreach ($part in $content.EnumerateArray()) {
                if ($part.ValueKind -ne 'Object' -or !$part.TryGetProperty('type', [ref]$type) -or
                    $type.ValueKind -ne 'String' -or [string]::IsNullOrWhiteSpace($type.GetString())) { return 'output-message-content' }
                $field = switch -CaseSensitive ($type.GetString()) { 'output_text' { 'text' } 'refusal' { 'refusal' } }
                if ($field -and (!$part.TryGetProperty($field, [ref]$type) -or $type.ValueKind -ne 'String')) {
                    return 'output-message-content'
                }
            }
        }
    }
}

function Write-LocalApiResult {
    param([string]$Body, [System.Collections.IDictionary]$Receipt, [string]$ContentType, $Capture)
    $expectsJson = $Operation -in 'Models', 'Responses', 'RetrieveResponse', 'InputTokens' -or
        ($Operation -eq 'Batch' -and $BatchAction -ne 'File')
    if ($expectsJson) {
        $document = $null
        try {
            if ($Transport -eq 'Http' -and ($ContentType -notmatch '^application/(json|[a-z0-9.+-]+\+json)$')) {
                throw 'Unexpected media type.'
            }
            $document = [System.Text.Json.JsonDocument]::Parse($Body)
            $root = $document.RootElement
            $value = [System.Text.Json.JsonElement]::new()
            if ($root.ValueKind -ne 'Object') { throw 'Expected a JSON object.' }
            $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($property in $root.EnumerateObject()) {
                if ($property.Name -iin 'object', 'id', 'status', 'data', 'input_tokens', 'output', 'completion_window',
                    'input_file_id' -and !$seen.Add($property.Name)) {
                    throw 'Ambiguous response fields.'
                }
            }
            $valid = switch ($Operation) {
                'Models' { $root.TryGetProperty('data', [ref]$value) -and $value.ValueKind -eq 'Array' }
                'InputTokens' {
                    $count = 0L
                    $root.TryGetProperty('input_tokens', [ref]$value) -and $value.ValueKind -eq 'Number' -and
                        $value.TryGetInt64([ref]$count) -and $count -ge 0
                }
                'Batch' {
                    if ($BatchAction -eq 'List') { $root.TryGetProperty('data', [ref]$value) -and $value.ValueKind -eq 'Array' }
                    else {
                        $root.TryGetProperty('object', [ref]$value) -and $value.ValueKind -eq 'String' -and $value.GetString() -ceq 'batch' -and
                            $root.TryGetProperty('id', [ref]$value) -and $value.ValueKind -eq 'String' -and $value.GetString() -cmatch '\Abatch_[A-Za-z0-9_-]{1,200}\z' -and
                            $root.TryGetProperty('status', [ref]$value) -and $value.ValueKind -eq 'String' -and $value.GetString() -cmatch '\A[a-z][a-z0-9_]{0,79}\z'
                    }
                }
                default {
                    (!$root.TryGetProperty('object', [ref]$value) -or
                        ($value.ValueKind -eq 'String' -and $value.GetString() -ceq 'response')) -and
                        $root.TryGetProperty('id', [ref]$value) -and $value.ValueKind -eq 'String' -and
                        $value.GetString() -cmatch '\Aresp_[A-Za-z0-9_-]{1,200}\z' -and
                        $root.TryGetProperty('status', [ref]$value) -and $value.ValueKind -eq 'String' -and
                        $value.GetString() -cmatch '\A[a-z][a-z0-9_]{0,79}\z'
                }
            }
            if (!$valid) { throw 'Unexpected JSON shape.' }
            if ($Operation -eq 'RetrieveResponse' -and $root.GetProperty('id').GetString() -cne $ResponseId) {
                $Receipt.identityMismatch = $true
                throw 'The returned response ID does not match the requested response ID.'
            }
            if ($Operation -eq 'Batch' -and $BatchAction -in 'Get', 'Cancel' -and $root.GetProperty('id').GetString() -cne $BatchTarget) {
                $Receipt.identityMismatch = $true
                throw 'The returned batch ID does not match the requested batch ID.'
            }
            if ($Operation -in 'Responses', 'RetrieveResponse') {
                $Receipt.responseId = $root.GetProperty('id').GetString()
                $responseStatus = $root.GetProperty('status').GetString()
                if ($responseStatus -cin 'completed','failed','in_progress','cancelled','queued','incomplete') {
                    $Receipt.responseStatus = $responseStatus
                } else {
                    $Receipt.responseStatusClassification = 'unknown'
                    $Receipt.resourceStatusClassification = 'unknown'
                    if ($responseStatus -cmatch '\A[A-Za-z0-9_.-]{1,120}\z') {
                        $Receipt.observedResponseStatus = $responseStatus
                    }
                }
                $issue = Get-LocalResponseOutputIssue $root $responseStatus
                if ($issue) {
                    $Receipt.responseOutputIssue = $issue
                    throw 'The Response output is unverified.'
                }
            } elseif ($Operation -eq 'Batch' -and $BatchAction -ne 'List') {
                $Receipt.batchId = $root.GetProperty('id').GetString()
                $batchStatus = $root.GetProperty('status').GetString()
                if ($BatchAction -eq 'Submit') { $Receipt.batchCreateState = 'id-observed' }
                if ($batchStatus -cnotin 'validating','failed','in_progress','finalizing','completed','expired','cancelling','cancelled') {
                    $Receipt.observedBatchStatus = $batchStatus
                    $Receipt.resourceStatusClassification = 'unknown'
                    throw 'The Batch status is unrecognized.'
                }
                $Receipt.batchStatus = $batchStatus
                if ($BatchAction -eq 'Submit' -and $BatchCompletionWindow -and
                    (!$root.TryGetProperty('completion_window', [ref]$value) -or $value.ValueKind -ne 'String' -or
                        $value.GetString() -cne $BatchCompletionWindow)) {
                    throw 'The returned Batch completion window differs from the requested value.'
                }
                if ($root.TryGetProperty('input_file_id', [ref]$value) -and $value.ValueKind -eq 'String' -and
                    $value.GetString() -cmatch '\Afile[-_][A-Za-z0-9_-]{1,200}\z') { $Receipt.inputFileId = $value.GetString() }
            }
        } catch {
            $Receipt.kind = 'protocol'
            if (($_.Exception.InnerException ?? $_.Exception) -is [System.Text.Json.JsonException]) { $Receipt.jsonMaxDepth = 64 }
            $Receipt.outcomeUnconfirmed = $uncertainOnFailure
            if ($Capture -and ($Transport -ne 'Http' -or $ContentType -match '^application/(json|[a-z0-9.+-]+\+json)$')) {
                Add-LocalApiRecoveryEvidence $Receipt (Get-LocalApiCapturedSources $Receipt $Capture -Http:($Transport -eq 'Http'))
            }
            $retainedBody = if ($Receipt['responseOutputIssue']) { $Body }
            Stop-LocalApiCall "$Operation returned an invalid response body. Inspect the receipt before repeating a paid or state-changing request." $Receipt $retainedBody
        } finally {
            if ($null -ne $document) { $document.Dispose() }
        }
    }
    Write-LocalApiCheckpoint 'result' $Receipt
    if ($IncludeReceipt) {
        return [pscustomobject]@{ body = $Body; receipt = [pscustomobject]$Receipt }
    }
    return $Body
}

function Get-LocalApiFailureKind {
    param([Exception]$Exception)
    while ($null -ne $Exception) {
        if ($Exception.GetType().Name -eq 'OpenAiLocalOutputLimitException') { return 'output_limit' }
        if ($Exception -is [Text.DecoderFallbackException]) { return 'protocol' }
        if ($Exception -is [OperationCanceledException] -or $Exception -is [TimeoutException]) { return 'timeout' }
        if ($Exception -is [System.Security.Authentication.AuthenticationException]) { return 'tls' }
        if ($Exception -is [System.Net.Sockets.SocketException]) {
            if ($Exception.SocketErrorCode -in 'HostNotFound', 'TryAgain', 'NoData', 'NoRecovery') { return 'dns' }
            return 'connection'
        }
        $Exception = $Exception.InnerException
    }
    return 'transport'
}

$usesJson = $Operation -in 'Responses', 'InputTokens'
$background = $false
if ($usesJson) {
    if ([string]::IsNullOrWhiteSpace($Json)) {
        Stop-LocalApiSetup "$Operation requires a JSON request object in -Json."
    }
    if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt $MaxInputMiB * 1MB) {
        Stop-LocalApiSetup "$Operation input exceeds -MaxInputMiB ($MaxInputMiB)." 'input_limit'
    }
    try {
        $document = [System.Text.Json.JsonDocument]::Parse($Json)
    } catch {
        Stop-LocalApiSetup "$Operation request must be valid JSON within the parser maximum nesting depth of 64."
    }
    try {
        if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
            Stop-LocalApiSetup "$Operation request must be a JSON object."
        }
        $fields = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $storeNull = $false
        foreach ($property in $document.RootElement.EnumerateObject()) {
            if (!$fields.Add($property.Name)) { Stop-LocalApiSetup "$Operation request contains a duplicate top-level JSON field." }
            if ($Operation -ne 'Responses') { continue }
            if ($property.Name -cin 'stream', 'background', 'store' -and $property.Value.ValueKind -notin 'True', 'False', 'Null') {
                Stop-LocalApiSetup "Responses field '$($property.Name)' must be a boolean or null."
            }
            if ($property.Name -ceq 'stream' -and $property.Value.ValueKind -eq 'True') {
                Stop-LocalApiSetup 'Responses streaming requires a streaming client. This helper returns buffered results.'
            }
            if ($property.Name -ceq 'background' -and $property.Value.ValueKind -eq 'True') { $background = $true }
            if ($property.Name -ceq 'store' -and $property.Value.ValueKind -eq 'Null') { $storeNull = $true }
        }
        if ($Operation -eq 'Responses' -and !$background -and ($storeNull -or !$fields.Contains('store'))) {
            if ($storeNull) {
                $objectNode = [System.Text.Json.Nodes.JsonNode]::Parse($Json)
                $objectNode['store'] = [System.Text.Json.Nodes.JsonNode]::Parse('false')
                $Json = $objectNode.ToJsonString()
            } else {
                $objectText = $document.RootElement.GetRawText()
                $separator = if ($fields.Count -gt 0) { ',' } else { '' }
                $Json = '{"store":false' + $separator + $objectText.Substring(1)
            }
            if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt $MaxInputMiB * 1MB) {
                Stop-LocalApiSetup "$Operation normalized input exceeds -MaxInputMiB ($MaxInputMiB)." 'input_limit'
            }
        }
    } finally {
        $document.Dispose()
    }
} elseif ($PSBoundParameters.ContainsKey('Json')) {
    Stop-LocalApiSetup 'Only Responses and InputTokens accept -Json.'
}
if ($Operation -eq 'RetrieveResponse') {
    if ($ResponseId -cnotmatch '\Aresp_[A-Za-z0-9_-]{1,200}\z') {
        Stop-LocalApiSetup 'RetrieveResponse requires -ResponseId with a response ID.'
    }
} elseif ($PSBoundParameters.ContainsKey('ResponseId')) {
    Stop-LocalApiSetup '-ResponseId requires RetrieveResponse.'
}

if ($Operation -eq 'Security' -and !$SecurityArgs) {
    Stop-LocalApiSetup 'Security requires -SecurityArgs with a Codex Security command.'
}
if ($Operation -ne 'Security' -and $PSBoundParameters.ContainsKey('SecurityArgs')) {
    Stop-LocalApiSetup 'Only Security accepts -SecurityArgs.'
}
if ($PSBoundParameters.ContainsKey('Transport')) {
    if ($Transport -eq 'Wsl' -and $Operation -notin 'Security', 'SecurityLogin') {
        Stop-LocalApiSetup 'The WSL route is available for Codex Security.'
    }
    if ($Operation -eq 'Doctor' -or ($Transport -eq 'Http' -and $Operation -in 'Batch', 'Security', 'SecurityLogin')) {
        Stop-LocalApiSetup "$Operation does not support that transport. Omit -Transport or select a supported route."
    }
} elseif ($Operation -in 'Batch', 'Security', 'SecurityLogin') {
    $Transport = 'Cli'
}
if ($Operation -ne 'Batch' -and ($PSBoundParameters.ContainsKey('BatchAction') -or
    $PSBoundParameters.ContainsKey('BatchTarget') -or $PSBoundParameters.ContainsKey('BatchAfter'))) {
    Stop-LocalApiSetup 'Batch parameters require -Operation Batch.'
}
if ($PSBoundParameters.ContainsKey('BatchAfter') -and ($BatchAction -ne 'List' -or $BatchAfter -cnotmatch '\Abatch_[A-Za-z0-9_-]{1,200}\z')) {
    Stop-LocalApiSetup '-BatchAfter requires Batch List and a Batch ID cursor.'
}
if ($PSBoundParameters.ContainsKey('BatchCompletionWindow') -and
    ($Operation -ne 'Batch' -or $BatchAction -ne 'Submit' -or [string]::IsNullOrWhiteSpace($BatchCompletionWindow))) {
    Stop-LocalApiSetup '-BatchCompletionWindow requires Batch Submit and a nonempty completion window.'
}
if (!$PSBoundParameters.ContainsKey('TimeoutSeconds')) {
    $TimeoutSeconds = if ($Operation -eq 'Security') { 3600 } else { 600 }
}
if ($PSBoundParameters.ContainsKey('MaxInputMiB') -and !$usesJson -and !($Operation -eq 'Batch' -and $BatchAction -eq 'Submit')) {
    Stop-LocalApiSetup '-MaxInputMiB applies to Responses, InputTokens or Batch Submit.'
}

$canCheckpoint = $Operation -eq 'Responses' -or
    ($Operation -eq 'Batch' -and $BatchAction -in 'Submit', 'Cancel') -or
    ($Operation -eq 'Security' -and $SecurityArgs.Count -ge 1 -and $SecurityArgs[0] -ceq 'scan' -and
        ($SecurityArgs.Count -eq 1 -or $SecurityArgs[1] -cne 'import') -and
        '--dry-run' -cnotin $SecurityArgs -and '--help' -cnotin $SecurityArgs -and '-h' -cnotin $SecurityArgs)
if (($PSBoundParameters.ContainsKey('CheckpointPath') -and
    (!$canCheckpoint -or [string]::IsNullOrWhiteSpace($CheckpointPath) -or $PWD.Provider.Name -ne 'FileSystem')) -or
    ($CheckpointProject -and !$CheckpointPath)) {
    Stop-LocalApiSetup 'A new filesystem checkpoint path is supported for Responses, Batch Submit/Cancel or a native Security scan.'
}
if ($ClientRequestId -and $Operation -notin 'Models', 'Responses', 'RetrieveResponse', 'InputTokens', 'Batch') {
    Stop-LocalApiSetup 'This route cannot forward -ClientRequestId to OpenAI.'
}
if ($IncludeNativeDiagnostics -and (!$IncludeReceipt -or $Operation -ne 'Security')) {
    Stop-LocalApiSetup '-IncludeNativeDiagnostics requires native Security and -IncludeReceipt.'
}
if ($CheckReadiness -and $Operation -ne 'Doctor') {
    Stop-LocalApiSetup '-CheckReadiness requires Doctor.'
}
if (!$IsWindows) {
    if (!$IsLinux -and !$IsMacOS) { Stop-LocalApiSetup 'This helper supports Windows, Linux and macOS.' 'dependency' }
    if ($Transport -eq 'Wsl') {
        Stop-LocalApiSetup 'The local WSL transport requires Windows.' 'dependency'
    }
    if ($PSVersionTable.PSVersion -lt [version]'7.4') {
        Stop-LocalApiSetup 'This helper requires PowerShell 7.4 or later on Linux and macOS.' 'dependency'
    }
}

if ($Operation -eq 'InputTokens' -and $Transport -eq 'Cli') {
    Stop-LocalApiSetup 'Native input-tokens count may omit delayed piped input. Use the default Http route or SDK responses.inputtokens.'
}
$apiBaseUrl = 'https://api.openai.com/v1'
$cli = $null
$usesCredential = $Operation -ne 'Security'
$needsWindowsCredential = $IsWindows -and $usesCredential
$usesOpenAiCli = $Operation -eq 'Batch' -or ($Transport -eq 'Cli' -and $Operation -in 'Models', 'Responses', 'RetrieveResponse')
$securityCommand = if ($Operation -eq 'Security') { $SecurityArgs[0] }
$attemptId = [Guid]::NewGuid().ToString('N')
$effectiveClientRequestId = if ($Operation -in 'Models', 'Responses', 'RetrieveResponse', 'InputTokens', 'Batch') {
    if ($ClientRequestId) { $ClientRequestId } else { $attemptId }
}
$openAiCli = $null
$nativeSecurity = $null
if ($IsWindows) {
    $nativeHome = [Environment]::GetFolderPath('LocalApplicationData')
    $programs = Join-Path $nativeHome 'Programs'
    $openAiCli = Join-Path $programs 'OpenAI-CLI/bin/openai.exe'
    $node = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs/node.exe'
    $securityRoot = Join-Path $programs 'Codex-Security/node_modules/@openai/codex-security'
    $securityEntry = Join-Path $securityRoot 'bin/codex-security.mjs'
    $wsl = Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
} else {
    $nativeHome = $HOME
    if ($usesOpenAiCli -or $Operation -eq 'Doctor') { $openAiCli = Find-LegatusProgram 'openai' }
    if ($Operation -in 'Doctor', 'Security', 'SecurityLogin') { $nativeSecurity = Find-LegatusProgram 'codex-security' }
}
if ($Operation -eq 'Doctor') {
    $inventory = [ordered]@{
        powershell = $PSVersionTable.PSVersion.ToString()
        transportSource = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalTransport.cs') -PathType Leaf
        agentsEntry = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'openai-agents.ps1') -PathType Leaf
        cli = $openAiCli -and (Test-Path -LiteralPath $openAiCli -PathType Leaf)
        codexSecurity = if ($IsWindows) {
            (Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $securityEntry -PathType Leaf)
        } else { [bool]$nativeSecurity }
        wslExecutable = $IsWindows -and (Test-Path -LiteralPath $wsl -PathType Leaf)
        tokenizer = $IsWindows -and (Test-Path -LiteralPath (Join-Path $programs 'OpenAI-Tiktoken/.venv/Scripts/python.exe') -PathType Leaf)
    }
    if ($CheckReadiness) { $inventory.readiness = Test-LocalApiReadiness }
    return [pscustomobject]$inventory
}
if ($Operation -eq 'SecurityLogin') {
    $SecurityArgs = @('login', '--with-api-key')
}
if ($Operation -eq 'Batch') {
    $cli = $openAiCli
    switch ($BatchAction) {
        'Submit' {
            if ([string]::IsNullOrWhiteSpace($BatchTarget)) { Stop-LocalApiSetup 'Submit requires a local JSONL file in -BatchTarget.' }
            $file = Get-Item -LiteralPath $BatchTarget -ErrorAction SilentlyContinue
            if ($file -isnot [IO.FileInfo]) { Stop-LocalApiSetup 'Submit requires a local JSONL file.' }
            if ($file.Length -eq 0) { Stop-LocalApiSetup 'Batch Submit requires a nonempty JSONL file.' }
            $arguments = @('batches', 'submit', '--file', $file.FullName)
            if ($PSBoundParameters.ContainsKey('BatchCompletionWindow')) {
                $arguments += "--completion-window=$BatchCompletionWindow"
            }
        }
        'List' {
            if ($PSBoundParameters.ContainsKey('BatchTarget')) { Stop-LocalApiSetup 'List takes no batch target.' }
            $arguments = @('batches', 'list', '--limit', '20', '--max-items', '20')
            if ($BatchAfter) { $arguments += @('--after', $BatchAfter) }
        }
        { $_ -in 'Get', 'Cancel' } {
            if ($BatchTarget -cnotmatch '\Abatch_[A-Za-z0-9_-]{1,200}\z') { Stop-LocalApiSetup "$BatchAction requires a Batch ID in -BatchTarget." }
            $verb = if ($_ -eq 'Get') { 'retrieve' } else { 'cancel' }
            $arguments = @('batches', $verb, '--batch-id', $BatchTarget)
        }
        'File' {
            if ($BatchTarget -cnotmatch '\Afile[-_][A-Za-z0-9_-]{1,200}\z') { Stop-LocalApiSetup 'File requires a Batch output or error file ID in -BatchTarget.' }
            $arguments = @('files', 'content', '--file-id', $BatchTarget)
        }
        default { Stop-LocalApiSetup 'Batch requires -BatchAction Submit, List, Get, Cancel or File.' }
    }
} elseif ($Operation -in 'Security', 'SecurityLogin' -and $Transport -eq 'Wsl') {
    $cli = $wsl
    $cleanEnvironment = @('/usr/bin/env', '-u', 'OPENAI_API_KEY', '-u', 'OPENAI_ADMIN_KEY',
        '-u', 'OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN', '-u', 'CODEX_API_KEY', '-u', 'NODE_OPTIONS', '-u', 'NODE_PATH')
    if ($Operation -eq 'SecurityLogin') {
        $cleanEnvironment += @('-u', 'CODEX_CLI_PATH', '-u', 'OPENAI_BASE_URL', '-u', 'CODEX_SECURITY_PROJECT_CONFIG')
    }
    $arguments = @('--distribution', 'Inquisitor-DevAiAye-Debian', '--user', 'node', '--cd', '/home/node', '--exec',
        '/usr/bin/timeout', '--kill-after=5s', "${TimeoutSeconds}s") + $cleanEnvironment +
        @('/home/node/.local/opt/codex-security/run-codex-security') + $SecurityArgs
} elseif ($Operation -in 'Security', 'SecurityLogin') {
    if ($IsWindows) {
        $cli = $node
        if (!(Test-Path -LiteralPath $securityEntry -PathType Leaf)) {
            Stop-LocalApiSetup 'The user-scoped Codex Security installation is missing.' 'dependency'
        }
        $arguments = @($securityEntry) + $SecurityArgs
    } else {
        if (!$nativeSecurity) { Stop-LocalApiSetup 'The Codex Security executable was not found on PATH.' 'dependency' }
        $cli = $nativeSecurity
        $arguments = $SecurityArgs
    }
} elseif ($Transport -eq 'Cli') {
    $cli = $openAiCli
    $arguments = switch ($Operation) {
        'Models' { @('models', 'list') }
        'Responses' { @('responses', 'create', '--request-file', '-') }
        'RetrieveResponse' { @('responses', 'retrieve', '--response-id', $ResponseId) }
    }
}
if ($usesOpenAiCli) {
    if (!$openAiCli) { Stop-LocalApiSetup 'The OpenAI CLI executable was not found on PATH.' 'dependency' }
    $arguments += @('--base-url', $apiBaseUrl, '--format', 'raw', '--format-error', 'json',
        '--header', "X-Client-Request-Id: $effectiveClientRequestId")
}
if ($cli -and !(Test-Path -LiteralPath $cli -PathType Leaf)) {
    Stop-LocalApiSetup 'The requested CLI runtime is missing.' 'dependency'
}

if (($needsWindowsCredential -and -not ('OpenAiWindowsCredentialV2' -as [type])) -or
    (-not ('OpenAiLocalTransportV6' -as [type]))) {
    $loadLock = [string]::Intern('OpenAiLocalApi.TypeLoad.V4')
    [Threading.Monitor]::Enter($loadLock)
    try {
        if ($needsWindowsCredential -and -not ('OpenAiWindowsCredentialV2' -as [type])) {
            Add-Type -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalCredential.cs')
        }
        if (-not ('OpenAiLocalTransportV6' -as [type])) {
            Add-Type -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalTransport.cs')
        }
    } catch {
        Stop-LocalApiSetup 'The local API runtime could not be loaded. Check PowerShell and the installed helper files.' 'dependency'
    } finally {
        [Threading.Monitor]::Exit($loadLock)
    }
}

$key = $null
if ($needsWindowsCredential) {
    try {
        $key = [OpenAiWindowsCredentialV2]::Load()
    } catch {
        Stop-LocalApiSetup 'Windows Credential Manager could not read the saved OpenAI credential.' 'credential'
    }
    if (!$key -or ![regex]::IsMatch($key, '\Ask-[A-Za-z0-9_-]{16,}\z')) {
        Stop-LocalApiSetup 'A usable OpenAI API pro Codex generic text credential was not found in Windows Credential Manager.' 'credential'
    }
} elseif ($usesCredential) {
    $key = $env:OPENAI_API_KEY
    if (!$key -or ![regex]::IsMatch($key, '\Ask-[A-Za-z0-9_-]{16,}\z')) {
        Stop-LocalApiSetup 'Set a usable OPENAI_API_KEY in the launching process environment.' 'credential'
    }
}

[byte[]]$payload = $null
if ($usesJson) { $payload = [Text.Encoding]::UTF8.GetBytes($Json) }
if ($Operation -eq 'SecurityLogin') { $payload = [Text.Encoding]::UTF8.GetBytes($key + "`n") }
$outputLimit = $MaxOutputMiB * 1MB
$uncertainOnFailure = $canCheckpoint -or $Operation -in 'Security','SecurityLogin'

if ($cli) {
    $start = [Diagnostics.ProcessStartInfo]::new($cli)
    if ($PWD.Provider.Name -ne 'FileSystem') {
        Stop-LocalApiSetup 'Native commands require a filesystem working directory.'
    }
    $start.WorkingDirectory = $PWD.ProviderPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in $arguments) {
        $start.ArgumentList.Add($argument)
    }
    Clear-OpenAiChildEnvironment $start -CredentialProcess:$usesCredential
    if ($usesOpenAiCli -and $usesJson) { $start.Environment['OPENAI_UNTRUSTED_STDIN'] = 'true' }
    if ($usesOpenAiCli) {
        $start.Environment['OPENAI_CLI_NO_AUTO_UPDATE'] = '1'
        $start.Environment['OPENAI_CLI_NO_UPDATE_CHECK'] = '1'
        [void]$start.Environment.Remove('OPENAI_CLI_INPUT_MODE')
    }
    if ($Operation -in 'Security', 'SecurityLogin') {
        foreach ($variable in 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE') {
            [void]$start.Environment.Remove($variable)
        }
    }
    if ($usesCredential -and $Operation -ne 'SecurityLogin') { $start.Environment['OPENAI_API_KEY'] = $key }
    if ($Operation -in 'Security', 'SecurityLogin') {
        if ($Transport -eq 'Wsl') {
            $start.Environment['WSLENV'] = ''
        } elseif (!$start.Environment['CODEX_SECURITY_STATE_DIR']) {
            $start.Environment['CODEX_SECURITY_STATE_DIR'] = if ($IsWindows) {
                Join-Path $nativeHome 'OpenAI/Codex-Security-API'
            } else {
                Join-Path (Get-LegatusStateRoot) 'Codex-Security-API'
            }
        }
        if ($Operation -eq 'SecurityLogin') {
            foreach ($variable in 'CODEX_CLI_PATH', 'OPENAI_BASE_URL', 'CODEX_SECURITY_PROJECT_CONFIG') {
                [void]$start.Environment.Remove($variable)
            }
            if ($Transport -eq 'Cli') { $start.WorkingDirectory = $nativeHome }
        }
    }
    $process = $null
    $budget = $null
    $capture = [OpenAiLocalTransportV6+NativeCapture]::new()
    $batchSnapshot = $null
    $details = [ordered]@{ operation = $Operation; transport = $Transport }
    if ($Operation -eq 'Batch' -and $BatchAction -eq 'Submit') { $details.batchCreateState = 'unknown' }
    if ($usesOpenAiCli) { $details.clientRequestId = $effectiveClientRequestId }
    if ($Operation -eq 'Responses') { $details.retryPolicy = 'cli_managed' }
    try {
        if ($Operation -eq 'Batch' -and $BatchAction -eq 'Submit') {
            $limit = if ($PSBoundParameters.ContainsKey('MaxInputMiB')) { $MaxInputMiB * 1MB } else { [long]::MaxValue }
            $snapshot = New-LocalApiBatchSnapshot $file.FullName $limit
            $batchSnapshot = $snapshot.handle
            $batchInputEvidence = $snapshot.evidence
            $details.sourceBytes = $batchInputEvidence.bytes
            $details.sourceSha256 = $batchInputEvidence.sha256
            $start.ArgumentList[3] = $batchSnapshot.Name
        }
        Start-LocalApiCheckpoint
        try { $process = [Diagnostics.Process]::Start($start) } catch {
            Stop-LocalApiSetup 'The requested local process could not start.' 'start'
        }
        [void]$start.Environment.Remove('OPENAI_API_KEY')
        Remove-Variable key
        $grace = if ($Transport -eq 'Wsl') { 8 } else { 0 }
        $budget = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds + $grace))
        try {
            $pending = [OpenAiLocalTransportV6]::ReadNativeAsync($process, $payload, $outputLimit, $budget.Token, $capture)
            $result = Read-LocalApiResult $pending $budget.Token
        } catch {
            $kind = Get-LocalApiFailureKind $_.Exception
            $details.kind = $kind
            $details.outcomeUnconfirmed = $uncertainOnFailure
            if ($Operation -in 'Security', 'SecurityLogin') { $details.checkNativeState = $true }
            $budget.Cancel()
            try { if (!$process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(1500) } } catch {}
            $io = $capture.IoCompletion
            if ($io -and !$io.IsCompleted) {
                try { [void]$io.Wait(750) } catch [AggregateException] {}
            }
            Add-LocalApiRecoveryEvidence $details (Get-LocalApiCapturedSources $details $capture)
            $message = "$Operation failed while waiting for the local CLI ($kind)."
            if ($details['outcomeUnconfirmed']) { $message += ' Reconcile the remote outcome before repeating the request.' }
            Stop-LocalApiCall $message $details
        }
        if ($result.ExitCode -ne 0) {
            $toolName = if ($Operation -in 'Security', 'SecurityLogin') { 'Codex Security' } else { 'OpenAI CLI' }
            $details.kind = 'cli_exit'
            $details.exitCode = $result.ExitCode
            $details.outcomeUnconfirmed = $uncertainOnFailure
            if ($Operation -in 'Security', 'SecurityLogin') { $details.checkNativeState = $true }
            $sources = Get-LocalApiCapturedSources $details $capture
            if ($Transport -eq 'Wsl' -and $result.ExitCode -in 124, 137) {
                $details.checkNativeState = $true
                $details.kind = 'wsl_termination'
            }
            $message = "$toolName failed (exit $($result.ExitCode))."
            if ($usesOpenAiCli) {
                foreach ($source in $sources.Values) { Add-LocalApiErrorFields $details (ConvertFrom-LocalApiJson $source) }
                if ($details['kind'] -ne 'cli_exit') { $message += " Category: $($details['kind'])." }
            }
            if ($Operation -eq 'Security' -and $result.ExitCode -eq 1) {
                if ($securityCommand -ceq 'login' -and $SecurityArgs.Count -ge 2 -and $SecurityArgs[1] -ceq 'status') {
                    $loginStatus = ConvertFrom-LocalApiJson $sources['stdout']
                    if ($loginStatus -and $loginStatus['authenticated'] -is [bool] -and !$loginStatus['authenticated']) {
                        $details.kind = 'native_signed_out'
                        $details.checkNativeState = $false
                        Stop-LocalApiCall 'Codex Security reported that this native context is signed out.' $details $result.Output
                    }
                }
                $scan = if ($securityCommand -ceq 'scan') { Get-LocalApiScanEvidence $result.Output }
                if ($scan) { $details.scanId = $scan.id; $details.scanStatus = $scan.status }
                if ($scan.completed) {
                    $details.kind = 'completed_nonzero'
                    $details.checkNativeState = $false
                    $details.outcomeUnconfirmed = $false
                    Stop-LocalApiCall 'Codex Security returned a completed scan with exit 1. The JSON result is available on the exception.' $details $result.Output
                }
            }
            Add-LocalApiRecoveryEvidence $details $sources
            if ($details['outcomeUnconfirmed']) {
                $message += ' Reconcile the remote outcome before repeating the request.'
            }
            Stop-LocalApiCall $message $details
        }
        $details.exitCode = $result.ExitCode
        if ($Operation -eq 'Security' -and $securityCommand -ceq 'scan' -and ($IncludeReceipt -or $checkpointFile)) {
            $scan = Get-LocalApiScanEvidence $result.Output
            if ($scan) { $details.scanId = $scan.id; $details.scanStatus = $scan.status }
        }
        if ($IncludeNativeDiagnostics) {
            $snapshot = $capture.Snapshot($true)
            $details.nativeDiagnostic = $snapshot.Item1
            $details.diagnosticTruncated = $snapshot.Item2
        }
        if ($Operation -eq 'SecurityLogin') { return [pscustomobject]@{ status = 'native_login_completed'; transport = $Transport; exitCode = 0 } }
        return Write-LocalApiResult $result.Output $details -Capture $capture
    } finally {
        if ($null -ne $budget) {
            $budget.Cancel()
            $budget.Dispose()
        }
        [void]$start.Environment.Remove('OPENAI_API_KEY')
        Remove-Variable key -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            try {
                if (!$process.HasExited) {
                    $process.Kill($true)
                    if (!$process.WaitForExit(1500)) { Write-Warning 'The local CLI exit is still unconfirmed.' }
                }
            } catch {
                if (!$process.HasExited) { Write-Warning 'The local CLI could not be stopped. Check its process state before retrying.' }
            } finally {
                if ($details.Contains('kind')) {
                    $details.localExitConfirmed = $process.HasExited
                    $details.nativeTreeExitConfirmed = $null
                    $io = if ($capture) { $capture.IoCompletion }
                    if ($io) {
                        try { [void]$io.Wait(750) } catch [AggregateException] {}
                        $details.localIoSettled = $io.IsCompleted
                    }
                    Write-LocalApiCheckpoint 'local_cleanup' $details
                }
                $process.Dispose()
            }
        }
        if ($batchSnapshot) {
            $batchSnapshot.Dispose()
            Remove-LocalApiBatchSnapshot $batchSnapshot.Name
        }
        Close-LocalApiCheckpoint
        if ($Operation -eq 'SecurityLogin' -and $null -ne $payload) { [Array]::Clear($payload, 0, $payload.Length) }
    }
}

$resource = switch ($Operation) {
    'Models' { 'models' }
    'InputTokens' { 'responses/input_tokens' }
    'Responses' { 'responses' }
    'RetrieveResponse' { "responses/$ResponseId" }
}

$response = [OpenAiLocalTransportV6+HttpResult]::new()
$response.ClientRequestId = $effectiveClientRequestId
$details = [ordered]@{ operation = $Operation; transport = 'Http'; clientRequestId = $effectiveClientRequestId }
$pending = $null
try {
    Start-LocalApiCheckpoint
    $budget = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        $pending = [OpenAiLocalTransportV6]::RequestAsync("$apiBaseUrl/$resource", $key, $payload, $outputLimit, $budget.Token, $response)
        Remove-Variable key
        $null = Read-LocalApiResult $pending $budget.Token
    } catch {
        $kind = Get-LocalApiFailureKind $_.Exception
        $budget.Cancel()
        if ($pending -and !$pending.IsCompleted) {
            try { [void]$pending.Wait(500) } catch [AggregateException] {}
        }
        $details.kind = $kind
        Add-LocalApiHttpFields $details $response
        $details.outcomeUnconfirmed = $uncertainOnFailure -and (!$details['status'] -or $details['status'] -in 408,409,425 -or
            $details['status'] -lt 400 -or $details['status'] -ge 500)
        if ($response.Status -ge 200 -and $response.Status -lt 300 -and $response.ContentType -match '^application/(json|[a-z0-9.+-]+\+json)$') {
            Add-LocalApiRecoveryEvidence $details (Get-LocalApiCapturedSources $details $response.BodyCapture -Http)
        }
        $message = "$Operation failed while calling api.openai.com ($kind)."
        if ($details['outcomeUnconfirmed']) { $message += ' Reconcile the outcome before repeating the request.' }
        Stop-LocalApiCall $message $details
    } finally {
        $budget.Cancel()
        if ($pending -and !$pending.IsCompleted) {
            try { [void]$pending.Wait(500) } catch [AggregateException] {}
        }
        $budget.Dispose()
        Remove-Variable key -ErrorAction SilentlyContinue
    }

    $status = $response.Status
    Add-LocalApiHttpFields $details $response
    if ($status -lt 200 -or $status -ge 300) {
        $details.kind = 'http_status'
        Add-LocalApiErrorFields $details (ConvertFrom-LocalApiJson $response.Output)
        $details.outcomeUnconfirmed = $uncertainOnFailure -and ($status -in 408,409,425 -or $status -ge 500)
        $message = "OpenAI API returned HTTP $status."
        if ($details['requestId']) {
            $message = "OpenAI API returned HTTP $status (request $($details['requestId']))."
        }
        if ($details.outcomeUnconfirmed) { $message += ' Reconcile the outcome before repeating the request.' }
        Stop-LocalApiCall $message $details
    }
    Write-LocalApiResult $response.Output $details $response.ContentType -Capture $response.BodyCapture
} finally {
    Close-LocalApiCheckpoint
}
