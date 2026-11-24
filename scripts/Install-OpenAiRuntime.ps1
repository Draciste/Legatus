[CmdletBinding()]
param(
    [string]$ManifestDirectory = (Join-Path $PSScriptRoot 'agents-sdk'),
    [switch]$Activate,
    [switch]$Offline,
    [string]$CacheDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'OpenAiChildEnvironment.ps1')
. (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
. (Join-Path $PSScriptRoot 'OpenAiPlatform.ps1')
$runtime = & (Join-Path $PSScriptRoot 'Get-OpenAiRuntime.ps1') -ManifestDirectory $ManifestDirectory
$candidatePackageHash = (Get-FileHash -LiteralPath $runtime.Package).Hash
$candidate = ConvertFrom-OpenAiJsonObject (Read-OpenAiLocalText $runtime.Package 1MB)
if ($candidate['dependencies']['openai'] -cne $runtime.Version) {
    throw 'Candidate package.json does not match its OpenAI SDK lock.'
}
$node = Get-LegatusNode
$npm = if ($IsWindows) { Join-Path ([IO.Path]::GetDirectoryName($node)) 'node_modules/npm/bin/npm-cli.js' }
    else { Find-LegatusProgram 'npm' }
$entry = Join-Path $PSScriptRoot 'openai-agents.mjs'
$expectedChecks = 'exact-json','multipart-bytes','split-utf8-sse','partial-sse','unknown-write-once','blocked-preflight','daybreak-session-json','svg-validation'
$loadLock = [string]::Intern('OpenAiLocalApi.TypeLoad.V4')
[Threading.Monitor]::Enter($loadLock)
try {
    if (!('OpenAiLocalTransportV6' -as [type])) { Add-Type -LiteralPath (Join-Path $PSScriptRoot 'OpenAiLocalTransport.cs') }
} finally { [Threading.Monitor]::Exit($loadLock) }

function Invoke-RuntimeProcess([string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$InputText) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.RedirectStandardOutput = [bool]$InputText
    $start.RedirectStandardError = [bool]$InputText
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    if ($InputText) {
        Clear-OpenAiChildEnvironment $start -Offline
    } else {
        Clear-OpenAiChildEnvironment $start -Sdk
        foreach ($name in @($start.Environment.Keys)) {
            if ($name -match '^NPM_(?:CONFIG_|TOKEN$)') { [void]$start.Environment.Remove($name) }
        }
    }
    $process = [Diagnostics.Process]::Start($start)
    try {
        if ($InputText) {
            $budget = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(45))
            try {
                $capture = [OpenAiLocalTransportV6+NativeCapture]::new()
                $payload = [Text.Encoding]::UTF8.GetBytes($InputText)
                $pending = [OpenAiLocalTransportV6]::ReadNativeAsync($process, $payload, 64KB, $budget.Token, $capture)
                $result = $pending.WaitAsync($budget.Token).GetAwaiter().GetResult()
                return [pscustomobject]@{ exitCode = $result.ExitCode; output = $result.Output }
            } catch { throw "Runtime qualification exceeded its local budget or failed to produce a report. Directory: $Directory" }
            finally { $budget.Cancel(); $budget.Dispose() }
        }
        $process.StandardInput.Close()
        if (!$process.WaitForExit(600000)) { throw "Runtime npm installation exceeded its local deadline. Stage: $Directory" }
        [pscustomobject]@{ exitCode = $process.ExitCode }
    } finally {
        try { if (!$process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(1500) } }
        catch { Write-Warning "Could not confirm termination of the local runtime maintenance process. Directory: $Directory" }
        finally { $process.Dispose() }
    }
}

function Test-LocalRuntime([string]$Directory) {
    if (!(Test-LegatusSdkInstalled $Directory)) { throw 'SDK installation metadata is missing.' }
    $run = Invoke-RuntimeProcess $node @($entry, $Directory) $Directory '{"action":"doctor"}'
    if ($run.exitCode -ne 0) { throw 'Runtime contract check failed.' }
    $report = ConvertFrom-OpenAiJsonObject $run.output
    if (!$report.ready -or $report.sdk -ne $runtime.Version -or !$report.liveWebSocket) {
        throw 'Runtime contract check did not confirm the expected SDK and Live transport.'
    }
    $qualification = Invoke-RuntimeProcess $node @($entry, $Directory) $Directory '{"action":"qualify"}'
    if ($qualification.exitCode -ne 0) { throw 'Offline runtime fixture qualification failed.' }
    $evidence = ConvertFrom-OpenAiJsonObject $qualification.output
    $passed = $evidence['passed']
    if ($evidence.sdk -ne $runtime.Version -or $evidence.networkUsed -cne $false -or $evidence['syntheticRequests'] -ne 8 -or
        $passed -isnot [array] -or $passed.Count -ne $expectedChecks.Count -or
        @($expectedChecks | Where-Object { $_ -cnotin $passed }).Count) {
        throw 'Missing evidence for the candidate runtime fixture qualification.'
    }
    $report['offlineQualification'] = $evidence['passed']
    $report
}

$report = $null
$unusedStage = $null
$retainedRuntime = $null
function Test-ExistingRuntime([string]$Directory) {
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) { return }
    $lock = Join-Path $Directory 'package-lock.json'
    $package = Join-Path $Directory 'package.json'
    if (!(Test-Path -LiteralPath $lock -PathType Leaf) -or
        !(Test-Path -LiteralPath $package -PathType Leaf) -or
        (Get-FileHash -LiteralPath $lock).Hash -ne $runtime.Hash -or
        (Get-FileHash -LiteralPath $package).Hash -ne $candidatePackageHash) { return }
    try { Test-LocalRuntime $Directory }
    catch { Write-Verbose "Existing runtime requires repair: $($_.Exception.Message)" }
}
$report = Test-ExistingRuntime $runtime.Runtime
if (!$report) {
    if (!$npm -or !(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'Install npm with the selected Node.js runtime.' }
    [void](New-LegatusStateDirectory $runtime.Root)
    $stage = Join-Path $runtime.Root ('.staging-' + [guid]::NewGuid().ToString('N'))
    [void](New-LegatusStateDirectory $stage)
    Copy-Item -LiteralPath $runtime.Package,$runtime.Lock -Destination $stage
    $stagedLock = Join-Path $stage 'package-lock.json'
    if ((Get-FileHash -LiteralPath $stagedLock).Hash -ne $runtime.Hash) {
        throw 'The candidate lock changed before staging.'
    }
    if ((Get-FileHash -LiteralPath (Join-Path $stage 'package.json')).Hash -ne $candidatePackageHash) {
        throw 'The candidate package manifest changed before staging.'
    }
    $npmArguments = @('ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund',
        '--registry', 'https://registry.npmjs.org', '--userconfig=.legatus-user.npmrc',
        '--globalconfig=.legatus-global.npmrc')
    if ($Offline) { $npmArguments += '--offline' }
    if ($CacheDirectory) { $npmArguments += @('--cache', [IO.Path]::GetFullPath($CacheDirectory, $PWD.ProviderPath)) }
    if ($IsWindows) { $install = Invoke-RuntimeProcess $node (@($npm) + $npmArguments) $stage }
    else { $install = Invoke-RuntimeProcess $npm $npmArguments $stage }
    if ($install.exitCode -ne 0) { throw "npm ci failed. The existing selection is intact. Stage: $stage" }
    if ((Get-FileHash -LiteralPath $stagedLock).Hash -ne $runtime.Hash) {
        throw 'Installation changed the candidate lock.'
    }
    $stageTest = Test-LocalRuntime $stage
    $gateKey = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($runtime.Root))
    $installGate = [Threading.Mutex]::new($false, 'Legatus.RuntimeInstall.' + [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($gateKey)))
    $installHeld = $false
    try {
        try { $installHeld = $installGate.WaitOne([TimeSpan]::FromSeconds(60)) }
        catch [Threading.AbandonedMutexException] { $installHeld = $true }
        if (!$installHeld) { throw 'Another Legatus runtime publication is in progress.' }
        $report = Test-ExistingRuntime $runtime.Runtime
        if ($report) {
            $unusedStage = $stage
        } else {
            if (Test-Path -LiteralPath $runtime.Runtime) {
                $retainedRuntime = Join-Path $runtime.Root ('.invalid-runtime-' + [guid]::NewGuid().ToString('N'))
                [IO.Directory]::Move($runtime.Runtime, $retainedRuntime)
            }
            try { [IO.Directory]::Move($stage, $runtime.Runtime) }
            catch {
                if ($retainedRuntime) { [IO.Directory]::Move($retainedRuntime, $runtime.Runtime) }
                throw
            }
            $report = $stageTest
        }
    } finally {
        if ($installHeld) { $installGate.ReleaseMutex() }
        $installGate.Dispose()
    }
}
if ((Get-FileHash -LiteralPath (Join-Path $runtime.Runtime 'package-lock.json')).Hash -ne $runtime.Hash) {
    throw 'The selected runtime differs from its lock.'
}
$qualifiedPackage = Join-Path $runtime.Runtime 'package.json'
if ((Get-FileHash -LiteralPath $qualifiedPackage).Hash -ne $candidatePackageHash) {
    throw 'Candidate package.json differs from the qualified manifest for this lock.'
}
if ($unusedStage) {
    $stagePath = [IO.Path]::GetFullPath($unusedStage)
    $runtimeRoot = [IO.Path]::GetFullPath($runtime.Root)
    if ([IO.Path]::GetDirectoryName($stagePath) -eq $runtimeRoot -and
        [IO.Path]::GetFileName($stagePath) -cmatch '\A\.staging-[a-f0-9]{32}\z') {
        try { [IO.Directory]::Delete($stagePath, $true) }
        catch { Write-Warning "Could not remove the unused qualified stage: $stagePath" }
    }
}
$active = Join-Path $PSScriptRoot 'agents-sdk'
$changed = $false
$manifestRepaired = $false
$activeLock = Join-Path $active 'package-lock.json'
$activePackage = Join-Path $active 'package.json'
if ($Activate) {
    $gateName = if ($IsWindows) { 'Local\OpenAiLocalApi.RuntimeActivation' } else {
        'Legatus.RuntimeActivation.' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($active)))
    }
    $gate = [Threading.Mutex]::new($false, $gateName)
    $held = $false
    try {
        try { $held = $gate.WaitOne([TimeSpan]::FromSeconds(15)) }
        catch [Threading.AbandonedMutexException] { $held = $true }
        if (!$held) { throw 'Another runtime activation is in progress.' }
        $lockChanged = !(Test-Path -LiteralPath $activeLock -PathType Leaf) -or
            (Get-FileHash -LiteralPath $activeLock).Hash -ne $runtime.Hash
        $packageChanged = !(Test-Path -LiteralPath $activePackage -PathType Leaf) -or
            (Get-FileHash -LiteralPath $activePackage).Hash -ne (Get-FileHash -LiteralPath $qualifiedPackage).Hash
        if ($lockChanged -or $packageChanged) {
            $suffix = '.candidate-' + [guid]::NewGuid().ToString('N')
            $newPackage = Join-Path $active ('package.json' + $suffix)
            $newLock = $activeLock + $suffix
            [IO.File]::Copy($qualifiedPackage, $newPackage)
            [IO.File]::Copy((Join-Path $runtime.Runtime 'package-lock.json'), $newLock)
            if ((Get-FileHash -LiteralPath $newLock).Hash -ne $runtime.Hash) {
                throw 'The qualified runtime lock changed before activation.'
            }
            # Readers select the runtime from the lock. Publish that single selector last.
            [IO.File]::Move($newPackage, $activePackage, $true)
            if ($lockChanged) {
                [IO.File]::Move($newLock, $activeLock, $true)
                $changed = $true
            } else {
                [IO.File]::Delete($newLock)
                $manifestRepaired = $true
            }
        }
        if ((Get-FileHash -LiteralPath $activeLock).Hash -ne $runtime.Hash) {
            throw 'The active lock did not select the intended runtime.'
        }
    } finally {
        if ($held) { $gate.ReleaseMutex() }
        $gate.Dispose()
    }
}
[pscustomobject]@{ sdk = $report.sdk; actions = $report.actionCount; runtime = $runtime.Runtime;
    node = $report.node; nodeExecutable = $report.nodeExecutable; retainedInvalidRuntime = $retainedRuntime;
    offlineQualification = $report.offlineQualification;
    lockSha256 = $runtime.Hash; selected = ((Test-Path -LiteralPath $activeLock -PathType Leaf) -and
        (Get-FileHash -LiteralPath $activeLock).Hash -eq $runtime.Hash);
    selectionChanged = $changed; manifestRepaired = $manifestRepaired }
