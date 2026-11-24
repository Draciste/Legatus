[CmdletBinding()]
param(
    [Parameter(Mandatory, Position=0)]
    [ValidatePattern('\A[A-Za-z0-9.]{1,100}\z')]
    [string]$Action,
    [string]$Id,
    [System.Collections.IDictionary]$Request,
    [string]$Json,
    [string]$RequestPath,
    [string]$InputFile,
    [string]$InputMediaType,
    [string]$MarkupFile,
    [string]$StableInstructionsPath,
    [Parameter(DontShow = $true)][string]$StableInstructionsText,
    [string]$OutputFile,
    [string]$OutputDirectory,
    [string]$EventFile,
    [string]$CheckpointPath,
    [ValidatePattern('\A[A-Za-z0-9._-]{1,120}\z')]
    [string]$ProjectHint,
    [switch]$IncludeApiMessage,
    [Security.SecureString]$WorkspaceToken,
    [ValidateSet('Auto','Environment','WindowsCredentialManager')][string]$CredentialSource = 'Auto',
    [string]$RuntimeManifestDirectory,
    [string]$IdempotencyKey,
    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\z')][string]$ClientRequestId,
    [switch]$StopOnTurn,
    [switch]$VerifyInputIds,
    [string]$TurnId,
    [ValidateRange(1, 300)]
    [int]$PollSeconds,
    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OpenAiChildEnvironment.ps1')
. (Join-Path $PSScriptRoot 'OpenAiPlatform.ps1')
$launcherStarted = $false
try {
if ($PSVersionTable.PSVersion -lt [version]'7.2') { throw 'Use PowerShell 7.2 or later.' }
if (!$IsWindows -and $CredentialSource -eq 'WindowsCredentialManager') { throw 'Windows Credential Manager is unavailable on this platform.' }
if ($PWD.Provider.Name -ne 'FileSystem') { throw 'Select a filesystem working directory.' }
$actionName = $Action.ToLowerInvariant()
$offline = $actionName -in 'catalog', 'doctor', 'qualify'
if ($ClientRequestId -and $actionName -notin 'responses.create','responses.multiagent.create','responses.steer') {
    throw 'ClientRequestId applies to creation or steering of a Response.'
}
$hasStableText = $PSBoundParameters.ContainsKey('StableInstructionsText')
if ($StableInstructionsPath -and $hasStableText) { throw 'Supply stable instructions by path or as an existing snapshot.' }
$workspace = $actionName -in 'workspace.trigger', 'workspace.status'
$admin = $actionName -in 'admin.usage.completions','admin.usage.costs'
if ($admin -and $CredentialSource -eq 'WindowsCredentialManager') {
    throw 'Admin usage reads require OPENAI_ADMIN_KEY in the process environment.'
}
$inputs = @('Request', 'Json', 'RequestPath' | Where-Object { $PSBoundParameters.ContainsKey($_) })
if ($inputs.Count -gt 1) { throw 'Supply one of -Request, -Json, or -RequestPath.' }
if ($offline -and ($Id -or $inputs.Count -or $InputFile -or $OutputFile -or $OutputDirectory -or $EventFile -or
        $CheckpointPath -or $ProjectHint -or $IdempotencyKey -or $StopOnTurn -or $VerifyInputIds -or $TurnId -or $TimeoutSeconds -or
        $PollSeconds -or $IncludeApiMessage -or $InputMediaType -or $MarkupFile -or $StableInstructionsPath -or $hasStableText -or $WorkspaceToken)) {
    throw 'Catalog, Doctor and Qualify take only an action name.'
}
if ($WorkspaceToken -and !$workspace) { throw 'Use -WorkspaceToken only with a Workspace Agents operation.' }
if ($RuntimeManifestDirectory -and !$offline) { throw 'Alternate runtime manifests are for offline qualification.' }
if ($actionName -eq 'responses.pilot' -and ($Id -or $InputFile -or $InputMediaType -or $StableInstructionsPath -or $hasStableText -or
        $OutputFile -or $OutputDirectory -or $EventFile -or $IdempotencyKey -or $StopOnTurn -or $TurnId -or $PollSeconds -or
        $IncludeApiMessage -or $TimeoutSeconds -gt 3600)) {
    throw 'The synthetic pilot takes model/turns/order, optional checkpoint/project, and a local timeout up to 3600 seconds.'
}
$maxRequestBytes = 16MB
$rawRequest = $null
if ($PSBoundParameters.ContainsKey('RequestPath')) {
    $source = Get-Item -LiteralPath $RequestPath
    if ($source.PSIsContainer -or $source.Length -gt $maxRequestBytes) { throw 'Expected a JSON file up to 16 MiB.' }
    $stream = [IO.File]::Open($source.FullName, 'Open', 'Read', 'Read')
    try {
        if ($stream.Length -gt $maxRequestBytes) { throw 'Request exceeds 16 MiB.' }
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
        try { $Json = $reader.ReadToEnd().TrimStart([char]0xfeff) }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}
if ($PSBoundParameters.ContainsKey('Json') -or $PSBoundParameters.ContainsKey('RequestPath')) {
    if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt $maxRequestBytes) { throw 'Request exceeds 16 MiB.' }
    $rawRequest = $Json
    try { $jsonDocument = [System.Text.Json.JsonDocument]::Parse($rawRequest) }
    catch { throw 'Expected a valid JSON request object.' }
    try {
        if ($jsonDocument.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
            throw 'Expected a JSON request object.'
        }
        $fields = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($field in $jsonDocument.RootElement.EnumerateObject()) {
            if (!$fields.Add($field.Name)) { throw 'Request contains a duplicate top-level JSON field.' }
        }
    } finally { $jsonDocument.Dispose() }
}
if ($null -eq $Request) { $Request = @{} }
if (!$TimeoutSeconds) {
    $TimeoutSeconds = if ($actionName -eq 'responses.pilot') { 120 } elseif ($actionName -in 'sessions.events.stream', 'sessions.create', 'responses.create',
        'responses.retrieve', 'responses.multiagent.create', 'responses.multiagent.retrieve', 'responses.steer', 'batches.wait', 'images.generate', 'images.edit', 'audio.transcriptions.create', 'audio.speech.create',
        'uploads.transfer', 'live.audio') { 600 } else { 60 }
}

function Resolve-PathArgument([string]$Value) {
    if ($Value) { return [IO.Path]::GetFullPath($Value, $PWD.ProviderPath) }
}
$stableInstructions = if ($hasStableText) { $StableInstructionsText }
if ($StableInstructionsPath) {
    . (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
    $stableInstructions = Read-OpenAiStableInstructions $StableInstructionsPath
}
if (($StableInstructionsPath -or $hasStableText) -and
    ([string]::IsNullOrWhiteSpace($stableInstructions) -or [Text.Encoding]::UTF8.GetByteCount($stableInstructions) -gt 1MB)) {
    throw 'Expected nonempty stable instructions up to 1 MiB.'
}
$context = [ordered]@{
    action = $actionName
    id = $Id
    request = $Request
    rawRequest = $rawRequest
    inputFile = Resolve-PathArgument $InputFile
    inputMediaType = $InputMediaType
    markupFile = Resolve-PathArgument $MarkupFile
    stableInstructions = $stableInstructions
    outputFile = Resolve-PathArgument $OutputFile
    outputDirectory = Resolve-PathArgument $OutputDirectory
    eventFile = Resolve-PathArgument $EventFile
    checkpointPath = Resolve-PathArgument $CheckpointPath
    projectHint = $ProjectHint
    includeApiMessage = $IncludeApiMessage.IsPresent
    idempotencyKey = $IdempotencyKey
    clientRequestId = $ClientRequestId
    stopOnTurn = $StopOnTurn.IsPresent
    verifyInputIds = $VerifyInputIds.IsPresent
    turnId = $TurnId
    pollSeconds = $PollSeconds
    timeoutSeconds = $TimeoutSeconds
}
$payload = ConvertTo-Json -InputObject $context -Depth 64 -Compress -WarningAction Stop
$payloadBytes = [Text.Encoding]::UTF8.GetByteCount($payload)
if ($payloadBytes -gt 36MB) { throw 'Encoded SDK invocation exceeds the 36 MiB local transport limit.' }
if (!$rawRequest -and $payloadBytes -gt $maxRequestBytes) {
    $requestOnly = ConvertTo-Json -InputObject $Request -Depth 64 -Compress -WarningAction Stop
    if ([Text.Encoding]::UTF8.GetByteCount($requestOnly) -gt $maxRequestBytes) { throw 'Request exceeds 16 MiB.' }
}

$sdk = ''
if (!$workspace) {
    $manifestDir = if ($RuntimeManifestDirectory) { Resolve-PathArgument $RuntimeManifestDirectory } else { Join-Path $PSScriptRoot 'agents-sdk' }
    $runtime = & (Join-Path $PSScriptRoot 'Get-OpenAiRuntime.ps1') -ManifestDirectory $manifestDir
    $sdk = $runtime.Runtime
    if (!(Test-Path -LiteralPath $sdk) -and (Test-LegatusSdkInstalled $manifestDir)) {
        $sdk = $manifestDir
    }
    $runtimeLock = Join-Path $sdk 'package-lock.json'
    if (!(Test-Path -LiteralPath $runtimeLock -PathType Leaf) -or
        (Get-FileHash -LiteralPath $runtimeLock).Hash -ne $runtime.Hash) {
        throw 'The SDK runtime is missing or its lock differs. See the runtime-maintenance guide.'
    }
}
$node = Get-LegatusNode
$entry = Join-Path $PSScriptRoot 'openai-agents.mjs'
if ((!$workspace -and !(Test-LegatusSdkInstalled $sdk)) -or
    !(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The optional Agents API runtime is missing. See references/agents-api.md.'
}

$start = [Diagnostics.ProcessStartInfo]::new($node)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $PWD.ProviderPath
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$start.ArgumentList.Add($entry)
$start.ArgumentList.Add($sdk)
Clear-OpenAiChildEnvironment $start -Sdk
if (!$offline) {
    $useWindowsStore = !$admin -and $IsWindows -and ($CredentialSource -eq 'WindowsCredentialManager' -or
        ($CredentialSource -eq 'Auto' -and (!$workspace -or (!$WorkspaceToken -and !$env:OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN))))
    if ($useWindowsStore) {
        $loadLock = [string]::Intern('OpenAiLocalApi.TypeLoad.V4')
        [Threading.Monitor]::Enter($loadLock)
        try {
            if (!('OpenAiWindowsCredentialV2' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalCredential.cs') }
        } finally { [Threading.Monitor]::Exit($loadLock) }
    }
    if ($admin) {
        $key = $env:OPENAI_ADMIN_KEY
        if (!$key -or $key -cnotmatch '\Ask-[A-Za-z0-9_-]{16,}\z') {
            throw 'A separate OPENAI_ADMIN_KEY is required in the process environment.'
        }
        $start.Environment['OPENAI_ADMIN_KEY'] = $key
    } elseif ($workspace) {
        $key = if ($WorkspaceToken) { [Net.NetworkCredential]::new('', $WorkspaceToken).Password }
            elseif ($CredentialSource -eq 'WindowsCredentialManager') { [OpenAiWindowsCredentialV2]::LoadWorkspaceAgent() }
            elseif ($env:OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN) { $env:OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN }
            elseif ($useWindowsStore) { [OpenAiWindowsCredentialV2]::LoadWorkspaceAgent() }
        if (!$key -or $key -cmatch '\Ask-') { throw 'A separate Workspace Agents access token is required.' }
        $start.Environment['OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN'] = $key
    } else {
        $key = if ($useWindowsStore) { [OpenAiWindowsCredentialV2]::Load() } else { $env:OPENAI_API_KEY }
        if (!$key -or $key -cnotmatch '\Ask-[A-Za-z0-9_-]{16,}\z') {
            if ($useWindowsStore) { throw 'Saved OpenAI API key unavailable.' }
            throw 'A usable OPENAI_API_KEY is required in the process environment.'
        }
        $start.Environment['OPENAI_API_KEY'] = $key
    }
    $key = $null
}

$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$watchdog = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds + 15))
$started = $false
$errorLine = $null
$resultLine = $null
try {
    if (!$process.Start()) { throw 'Could not start the OpenAI API client.' }
    $started = $true
    $launcherStarted = $true
    [void]$start.Environment.Remove('OPENAI_ADMIN_KEY')
    [void]$start.Environment.Remove('OPENAI_API_KEY')
    [void]$start.Environment.Remove('OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN')
    [void]$process.StandardInput.WriteAsync($payload).WaitAsync($watchdog.Token).GetAwaiter().GetResult()
    [void]$process.StandardInput.FlushAsync().WaitAsync($watchdog.Token).GetAwaiter().GetResult()
    $process.StandardInput.Close()
    while ($null -ne ($line = $process.StandardOutput.ReadLineAsync().WaitAsync($watchdog.Token).GetAwaiter().GetResult())) {
        # Classify structured lines independently of property order. Stream events
        # use a fixed local encoder, so avoid decoding their potentially large body.
        if (!$line.StartsWith('{"kind":"event",', [StringComparison]::Ordinal)) {
            try { $parsedLine = [System.Text.Json.JsonDocument]::Parse($line,[System.Text.Json.JsonDocumentOptions]@{MaxDepth=128}) }
            catch { $parsedLine = $null }
            if ($parsedLine) {
                try {
                    $root = $parsedLine.RootElement
                    if ($root.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                        $kind = [System.Text.Json.JsonElement]::new()
                        $name = if ($root.TryGetProperty('kind',[ref]$kind) -and
                            $kind.ValueKind -eq [System.Text.Json.JsonValueKind]::String) { $kind.GetString() }
                        if ($name -eq 'error') { $errorLine = $line }
                        elseif ($name -eq 'result' -or ($root.TryGetProperty('receipt',[ref]$kind) -and
                            $root.TryGetProperty('data',[ref]$kind))) { $resultLine = $line }
                    }
                } finally { $parsedLine.Dispose() }
            }
        }
        Write-Output $line
    }
    [void]$process.WaitForExitAsync($watchdog.Token).GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        $failure = [InvalidOperationException]::new('OpenAI API action failed or did not complete. Inspect its output and checkpoint before any replay.')
        if ($errorLine) { $failure.Data['OpenAiLocalAgents'] = ConvertFrom-Json $errorLine -AsHashtable }
        if ($resultLine) { $failure.Data['OpenAiLocalApiResult'] = $resultLine }
        throw $failure
    }
} catch [OperationCanceledException] {
    $failure = [TimeoutException]::new('The local OpenAI SDK process exceeded its watchdog deadline. Check the checkpoint before retrying.')
    $failure.Data['OpenAiLocalAgents'] = @{
        kind = 'error'; stage = 'launcher'; category = 'local_watchdog'
        localDeadlineReached = $true; outcomeUnconfirmed = ($started -and !$offline)
    }
    if ($resultLine) { $failure.Data['OpenAiLocalApiResult'] = $resultLine }
    if ($errorLine) { $failure.Data['OpenAiLocalApiPreviousError'] = $errorLine }
    throw $failure
} finally {
    $watchdog.Dispose()
    [void]$start.Environment.Remove('OPENAI_ADMIN_KEY')
    [void]$start.Environment.Remove('OPENAI_API_KEY')
    [void]$start.Environment.Remove('OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN')
    if ($started -and !$process.HasExited) {
        try { $process.Kill($true) } catch {}
    }
    $process.Dispose()
}
} catch {
    if (!$launcherStarted -and !$_.Exception.Data['OpenAiLocalAgents']) {
        $_.Exception.Data['OpenAiLocalAgents'] = @{
            kind='error'; stage='preflight'; dispatch='not-attempted'; outcomeUnconfirmed=$false
        }
    }
    throw
}
