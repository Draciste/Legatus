param([string]$CacheDirectory)

$ErrorActionPreference = 'Stop'
$scripts = Split-Path $PSScriptRoot
$installer = Join-Path $scripts 'Install-OpenAiRuntime.ps1'
$launcher = Join-Path $scripts 'openai-agents.ps1'
$previousState = $env:LEGATUS_STATE_DIR
$workspace = Join-Path ([IO.Path]::GetTempPath()) ('legatus-repair-fixture-' + [guid]::NewGuid().ToString('N'))
$env:LEGATUS_STATE_DIR = $workspace
try {
    $parameters = @{ Activate = $true }
    if ($CacheDirectory) {
        $parameters.Offline = $true
        $parameters.CacheDirectory = $CacheDirectory
    }
    $initial = & $installer @parameters
    $metadata = Join-Path $initial.runtime 'node_modules/openai/package.json'
    [IO.File]::Move($metadata, ($metadata + '.unavailable'))
    $failedBefore = $false
    try { $null = & $launcher doctor } catch { $failedBefore = $true }
    if (!$failedBefore) { throw 'Damaged runtime fixture did not fail launcher validation.' }
    $repaired = & $installer @parameters
    $selected = & $launcher doctor | ConvertFrom-Json
    if (!$repaired.selected -or !$selected.ready -or !$repaired.retainedInvalidRuntime -or
        $repaired.lockSha256 -ne $initial.lockSha256 -or $repaired.node -ne $selected.node -or
        $repaired.nodeExecutable -ne $selected.nodeExecutable -or !(Test-Path -LiteralPath $metadata -PathType Leaf)) {
        throw 'Runtime repair and launcher do not agree on a qualified installation.'
    }
    $parser = Join-Path $repaired.runtime 'node_modules/saxes/saxes.js'
    [IO.File]::WriteAllText($parser, 'module.exports = {};')
    $missingParserBlocked = $false
    try { $null = & $launcher doctor } catch { $missingParserBlocked = $true }
    if (!$missingParserBlocked) { throw 'Doctor accepted a runtime missing the SVG parser.' }
    [IO.File]::WriteAllText($parser, 'exports.SaxesParser = class { on() {} write() { return this; } close() {} };')
    $brokenParserDoctorBlocked = $false
    try { $null = & $launcher doctor } catch { $brokenParserDoctorBlocked = $true }
    if (!$brokenParserDoctorBlocked) { throw 'Doctor accepted a parser that cannot validate an SVG.' }
    $brokenParserBlocked = $false
    try { $null = & $launcher qualify } catch { $brokenParserBlocked = $true }
    if (!$brokenParserBlocked) { throw 'Qualification accepted a parser that cannot validate an SVG.' }
    $parserRepaired = & $installer @parameters
    if (!$parserRepaired.selected -or !$parserRepaired.retainedInvalidRuntime -or
        'svg-validation' -cnotin $parserRepaired.offlineQualification) {
        throw 'Installer did not recover the SVG validation route.'
    }
    $fixtureScripts = Join-Path $workspace 'missing-selector'
    $fixtureManifest = Join-Path $fixtureScripts 'agents-sdk'
    [void][IO.Directory]::CreateDirectory($fixtureManifest)
    Get-ChildItem -LiteralPath $scripts -File | Copy-Item -Destination $fixtureScripts
    $manifestDirectory = Join-Path $scripts 'agents-sdk'
    $recovered = & (Join-Path $fixtureScripts 'Install-OpenAiRuntime.ps1') @parameters -ManifestDirectory $manifestDirectory
    $fixtureLauncher = Join-Path $fixtureScripts 'openai-agents.ps1'
    $confirmed = & $fixtureLauncher doctor | ConvertFrom-Json
    if (!$recovered.selectionChanged -or !$recovered.selected -or !$confirmed.ready -or $confirmed.sdk -ne $selected.sdk) {
        throw 'Activation did not restore the missing selector and select the qualified runtime.'
    }
    [pscustomobject]@{ repaired = $true; node = $selected.node; nodeExecutable = $selected.nodeExecutable; sdk = $selected.sdk;
        lockPreserved = $true; missingSelectorRestored = $true; damagedInstanceRetainedUntilCleanup = $true;
        missingParserBlocked = $missingParserBlocked; brokenParserBlocked = $brokenParserBlocked; svgRuntimeRecovered = $true } | ConvertTo-Json -Compress
} finally {
    $env:LEGATUS_STATE_DIR = $previousState
    if (Test-Path -LiteralPath $workspace -PathType Container) {
        $absolute = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $workspace).Path)
        if ($absolute -eq [IO.Path]::GetFullPath($workspace)) {
            [IO.Directory]::Delete($absolute, $true)
        }
    }
}
