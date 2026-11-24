#Requires -Version 7.2
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) { throw $Message }
}

function Assert-LocalApiFailure([scriptblock]$Run, [string]$Kind) {
    try { $null = & $Run } catch {
        Assert-Equal $_.Exception.Data['OpenAiLocalApi'].kind $Kind "Expected local API error $Kind."
        Assert-Equal $_.Exception.Data['OpenAiLocalApi'].outcomeUnconfirmed $false 'Setup failures must precede dispatch.'
        return
    }
    throw "Expected local API error $Kind."
}

$scripts = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $scripts 'openai-api.ps1'
. (Join-Path $scripts 'OpenAiPlatform.ps1')
& {
    # Exercise the installed parser with controlled bodies and no credential or network.
    $tokens = $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
    Assert-Equal $errors.Count 0 'The buffered launcher did not parse.'
    $definitions = $ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -in 'Get-LocalResponseOutputIssue', 'Write-LocalApiResult', 'Stop-LocalApiCall'
    }, $false)
    Assert-Equal $definitions.Count 3 'Missing result handling functions.'
    . ([scriptblock]::Create(($definitions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine))
    function Write-LocalApiCheckpoint {}
    $Transport = 'Http'
    $IncludeReceipt = $true
    $uncertainOnFailure = $true
    $Operation = 'Responses'
    $BatchAction = $null
    $known = '{"object":"response","id":"resp_fixture","status":"completed","output":[]}'
    Assert-Equal (Write-LocalApiResult $known @{} 'application/json' $null).receipt.responseStatus 'completed' 'An empty output array is valid.'
    foreach ($suffix in '', ',"output":1', ',"output":[{"type":"message","content":[{"type":"output_text","text":false}]}]') {
        $body = '{"object":"response","id":"resp_fixture","status":"completed"' + $suffix + '}'
        $failure = $null
        try { $null = Write-LocalApiResult $body @{} 'application/json' $null }
        catch { $failure = $_.Exception }
        Assert-Equal ($null -ne $failure) $true 'Malformed output was accepted.'
        Assert-Equal $failure.Data['OpenAiLocalApi'].responseId 'resp_fixture' 'Malformed output lost the Response ID.'
        Assert-Equal $failure.Data['OpenAiLocalApiResult'] $body 'Malformed output lost its inspectable JSON.'
    }
    $Operation = 'Batch'
    $BatchAction = 'Submit'
    $BatchCompletionWindow = '24h'
    $good = '{"object":"batch","id":"batch_fixture","status":"validating","completion_window":"24h"}'
    Assert-Equal (Write-LocalApiResult $good @{} 'application/json' $null).receipt.batchId 'batch_fixture' 'Matching Batch result failed.'
    foreach ($body in ($good -replace '24h','48h'), ($good -replace 'validating','future_state')) {
        $failure = $null
        try { $null = Write-LocalApiResult $body @{} 'application/json' $null }
        catch { $failure = $_.Exception }
        Assert-Equal ($null -ne $failure) $true 'Inconsistent Batch result was accepted.'
        Assert-Equal $failure.Data['OpenAiLocalApi'].batchId 'batch_fixture' 'The Batch recovery ID was lost.'
    }
}
$doctorFields = 'powershell,transportSource,agentsEntry,cli,codexSecurity,wslExecutable,tokenizer'
if ($IsWindows) {
    $inventory = & $helper -Operation Doctor
    Assert-Equal ($inventory.PSObject.Properties.Name -join ',') $doctorFields 'Windows Doctor changed its output fields.'
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    $expectedState = if ($env:LEGATUS_STATE_DIR) { [IO.Path]::GetFullPath($env:LEGATUS_STATE_DIR) }
        else { Join-Path $localData 'OpenAI/Legatus' }
    Assert-Equal (Get-LegatusStateRoot) $expectedState 'The Windows state path changed.'
    $expectedCli = Test-Path -LiteralPath (Join-Path $localData 'Programs/OpenAI-CLI/bin/openai.exe') -PathType Leaf
    Assert-Equal $inventory.cli $expectedCli 'Windows Doctor no longer checks the installed OpenAI CLI.'
    Assert-LocalApiFailure { & $helper -Operation InputTokens -Transport Cli -Json '{"model":"fixture","input":"text"}' } 'validation'
    'Buffered Windows checks passed.'
    return
}

function Write-FixtureProgram([string]$Path, [string]$Source) {
    [IO.File]::WriteAllText($Path, ($Source -replace '\r\n', "`n") + "`n")
    $mode = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
    [IO.File]::SetUnixFileMode($Path, $mode)
}

$temp = [IO.Directory]::CreateTempSubdirectory('legatus-buffered-test-').FullName
$oldLocation = $PWD
$environment = @{}
foreach ($name in 'PATH', 'XDG_STATE_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CLI_INPUT_MODE',
    'HTTPS_PROXY', 'SSL_CERT_FILE', 'CODEX_SECURITY_STATE_DIR', 'CODEX_SECURITY_PROJECT_CONFIG',
    'CODEX_CLI_PATH', 'LD_LIBRARY_PATH', 'BASH_ENV', 'NODE_OPTIONS', 'LEGATUS_BUFFERED_FIXTURE', 'LEGATUS_STATE_DIR') {
    $environment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PATH = $temp
    $env:XDG_STATE_HOME = Join-Path $temp 'xdg state'
    $env:LEGATUS_BUFFERED_FIXTURE = $temp
    $env:OPENAI_API_KEY = $null
    $env:CODEX_SECURITY_STATE_DIR = $null
    $env:LEGATUS_STATE_DIR = $null
    $expectedState = if ($IsMacOS) {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Library/Application Support/Legatus'
    } else { Join-Path $env:XDG_STATE_HOME 'legatus' }
    Assert-Equal (Get-LegatusStateRoot) $expectedState 'Incorrect platform state location.'
    $env:LEGATUS_STATE_DIR = Join-Path $temp 'explicit root'
    Assert-Equal (Get-LegatusStateRoot) $env:LEGATUS_STATE_DIR 'The explicit Legatus state root was ignored.'
    $env:LEGATUS_STATE_DIR = $null
    if ($IsLinux) {
        $xdgState = $env:XDG_STATE_HOME
        $env:XDG_STATE_HOME = 'relative-state-directory'
        $defaultState = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/state/legatus'
        Assert-Equal (Get-LegatusStateRoot) $defaultState 'Linux accepted a relative XDG_STATE_HOME.'
        $env:XDG_STATE_HOME = $xdgState
    }
    $stateDirectory = New-LegatusStateDirectory (Join-Path $temp 'isolated-state')
    $private = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
    Assert-Equal $stateDirectory.UnixFileMode $private 'A new Unix state directory was not private.'

    $inventory = & $helper -Operation Doctor -CheckReadiness
    Assert-Equal ($inventory.PSObject.Properties.Name -join ',') "$doctorFields,readiness" 'Unix Doctor returned unexpected fields.'
    Assert-Equal $inventory.cli $false 'Doctor reported a CLI missing from PATH.'
    Assert-Equal $inventory.readiness.cli.status 'missing' 'Doctor tried to probe a missing CLI.'
    Assert-Equal $inventory.wslExecutable $false 'Doctor enabled WSL on Unix.'
    Assert-LocalApiFailure { & $helper -Operation Security -Transport Wsl -SecurityArgs @('login', 'status') } 'dependency'
    Assert-LocalApiFailure { & $helper -Operation Models -Transport Cli } 'dependency'
    Assert-LocalApiFailure { & $helper -Operation Models } 'credential'
    Assert-LocalApiFailure { & $helper -Operation InputTokens -Transport Cli -Json '{"model":"fixture","input":"text"}' } 'validation'
    Assert-Equal ('OpenAiWindowsCredentialV2' -as [type]) $null 'Unix loaded the Windows credential code.'

    $openAi = Join-Path $temp 'openai'
    Write-FixtureProgram $openAi @'
#!/bin/sh
set -eu
if [ "$1" = --version ]; then
    test -z "${OPENAI_API_KEY+x}"
    printf '%s\n' 'openai version 1.56.0'
    exit 0
fi
test "$OPENAI_API_KEY" = sk-fixture_only_never_real_1234
test -z "${OPENAI_BASE_URL+x}${OPENAI_CLI_INPUT_MODE+x}${HTTPS_PROXY+x}${SSL_CERT_FILE+x}"
test -z "${LD_LIBRARY_PATH+x}${BASH_ENV+x}${NODE_OPTIONS+x}"
test "$OPENAI_CLI_NO_AUTO_UPDATE" = 1
test "$OPENAI_CLI_NO_UPDATE_CHECK" = 1
case "$*" in
    *'--base-url https://api.openai.com/v1 --format raw --format-error json --header X-Client-Request-Id: '*) ;;
    *) exit 23 ;;
esac
case "$1 $2" in
    'responses create')
        test "$3 $4" = '--request-file -'
        test "$OPENAI_UNTRUSTED_STDIN" = true
        /bin/cat > "$LEGATUS_BUFFERED_FIXTURE/request.json"
        printf '%s\n' '{"object":"response","id":"resp_fixture","status":"completed","output":[]}'
        ;;
    'batches submit')
        test "$3" = --file
        parent=${4%/*}
        if [ "$(/usr/bin/uname -s)" = Darwin ]; then
            test "$(/usr/bin/stat -f '%Lp' "$parent")" = 700
        else
            test "$(/usr/bin/stat -c '%a' "$parent")" = 700
        fi
        printf '%s\n' "$4" > "$LEGATUS_BUFFERED_FIXTURE/snapshot-path"
        /bin/cat "$4" > "$LEGATUS_BUFFERED_FIXTURE/snapshot-contents"
        printf '%s\n' '{"object":"batch","id":"batch_fixture","status":"validating"}'
        ;;
    *) exit 24 ;;
esac
'@
    $security = Join-Path $temp 'codex-security'
    Write-FixtureProgram $security @'
#!/bin/sh
set -eu
test -z "${OPENAI_API_KEY+x}${NODE_OPTIONS+x}"
test -n "$CODEX_SECURITY_STATE_DIR"
printf '%s\n' "$CODEX_SECURITY_STATE_DIR" > "$LEGATUS_BUFFERED_FIXTURE/security-state"
case "$1 $2" in
    'login status')
        test "$OPENAI_BASE_URL" = https://fixture.invalid
        printf '%s\n' '{"authenticated":true}'
        ;;
    'login --with-api-key')
        test -z "${OPENAI_BASE_URL+x}${CODEX_SECURITY_PROJECT_CONFIG+x}${CODEX_CLI_PATH+x}"
        IFS= read -r key
        test "$key" = sk-fixture_only_never_real_1234
        printf '%s\n' "$PWD" > "$LEGATUS_BUFFERED_FIXTURE/security-login-cwd"
        ;;
    *) exit 25 ;;
esac
'@
    Write-FixtureProgram (Join-Path $temp 'node') @'
#!/bin/sh
printf '%s\n' 'v22.1.0'
'@
    $env:OPENAI_API_KEY = 'sk-fixture_only_never_real_1234'
    $env:OPENAI_BASE_URL = 'https://fixture.invalid'
    $env:OPENAI_CLI_INPUT_MODE = 'fixture'
    $env:HTTPS_PROXY = 'https://fixture.invalid'
    $env:SSL_CERT_FILE = Join-Path $temp 'untrusted.pem'
    $env:CODEX_SECURITY_PROJECT_CONFIG = Join-Path $temp 'fixture.json'
    $env:CODEX_CLI_PATH = Join-Path $temp 'fixture-codex'
    $env:LD_LIBRARY_PATH = $temp
    $env:BASH_ENV = Join-Path $temp 'shell-override'
    $env:NODE_OPTIONS = '--fixture-option-must-be-stripped'
    Set-Location -LiteralPath $temp

    Assert-Equal (Find-LegatusProgram 'openai') $openAi 'Unix did not resolve the fixture executable on PATH.'
    Assert-Equal (Get-LegatusNode) (Join-Path $temp 'node') 'Unix did not resolve Node on PATH.'
    $inventory = & $helper -Operation Doctor -CheckReadiness
    Assert-Equal $inventory.readiness.cli.version '1.56.0' 'Doctor did not use an isolated CLI version probe.'
    Assert-Equal $inventory.readiness.node.version '22.1.0' 'Doctor did not probe the PATH Node executable.'
    Assert-Equal $inventory.codexSecurity $true 'Doctor did not discover the PATH Codex Security executable.'

    $result = & $helper -Operation Responses -Transport Cli -Json '{"model":"fixture","input":"text"}' -IncludeReceipt -ClientRequestId 'fixture-check'
    Assert-Equal $result.receipt.clientRequestId 'fixture-check' 'The CLI lost the correlation ID.'
    Assert-Equal $result.receipt.responseId 'resp_fixture' 'The CLI lost the response ID.'
    $request = Get-Content -LiteralPath (Join-Path $temp 'request.json') -Raw | ConvertFrom-Json
    Assert-Equal $request.store $false 'The buffered request changed its default store setting.'

    $batchInput = Join-Path $temp 'batch rows.jsonl'
    [IO.File]::WriteAllText($batchInput, "{`"custom_id`":`"fixture`"}`n")
    $batch = & $helper -Operation Batch -BatchAction Submit -BatchTarget $batchInput -IncludeReceipt
    Assert-Equal $batch.receipt.batchId 'batch_fixture' 'The buffered helper lost the Batch ID.'
    Assert-Equal $batch.receipt.sourceSha256 (Get-FileHash -LiteralPath $batchInput).Hash.ToLowerInvariant() 'Incorrect Batch snapshot digest.'
    $copied = [IO.File]::ReadAllText((Join-Path $temp 'snapshot-contents'))
    Assert-Equal $copied ([IO.File]::ReadAllText($batchInput)) 'The fixture received different Batch input bytes.'
    $snapshot = [IO.File]::ReadAllText((Join-Path $temp 'snapshot-path')).TrimEnd("`n")
    Assert-Equal (Test-Path -LiteralPath (Split-Path -Parent $snapshot)) $false 'A Batch snapshot directory was left behind.'

    $securityResult = & $helper -Operation Security -SecurityArgs @('login', 'status') | ConvertFrom-Json
    Assert-Equal $securityResult.authenticated $true 'The native credential context was not preserved for ordinary Security.'
    $login = & $helper -Operation SecurityLogin
    Assert-Equal $login.status 'native_login_completed' 'The stdin-only Security login receipt changed.'
    $loginCwd = [IO.File]::ReadAllText((Join-Path $temp 'security-login-cwd')).TrimEnd("`n")
    Assert-Equal $loginCwd $HOME 'Security login was launched inside the task directory.'
    $securityState = [IO.File]::ReadAllText((Join-Path $temp 'security-state')).TrimEnd("`n")
    Assert-Equal $securityState (Join-Path $expectedState 'Codex-Security-API') 'The native Security context is not isolated in Legatus state.'
    'Buffered Unix fixture checks passed.'
} finally {
    Set-Location -LiteralPath $oldLocation.ProviderPath
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
    [IO.Directory]::Delete($temp, $true)
}
