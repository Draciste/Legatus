function Find-LegatusProgram([string]$Name) {
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and [IO.Path]::IsPathFullyQualified($command.Source)) { return $command.Source }
    return $null
}

function Get-LegatusNode {
    if ($env:LEGATUS_NODE_EXECUTABLE) {
        if (![IO.Path]::IsPathFullyQualified($env:LEGATUS_NODE_EXECUTABLE) -or
            !(Test-Path -LiteralPath $env:LEGATUS_NODE_EXECUTABLE -PathType Leaf)) {
            throw 'LEGATUS_NODE_EXECUTABLE must name an existing absolute Node executable.'
        }
        return $env:LEGATUS_NODE_EXECUTABLE
    }
    if ($IsWindows) {
        $installed = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs/node.exe'
        if (Test-Path -LiteralPath $installed -PathType Leaf) { return $installed }
    }
    $node = Find-LegatusProgram 'node'
    if (!$node) { throw 'Install Node.js 22 or later and make node available on PATH.' }
    return $node
}

function Test-LegatusSdkInstalled([string]$Directory) {
    return (Test-Path -LiteralPath (Join-Path $Directory 'node_modules/openai/package.json') -PathType Leaf)
}

function Get-LegatusStateRoot {
    if ($env:LEGATUS_STATE_DIR) {
        if (![IO.Path]::IsPathFullyQualified($env:LEGATUS_STATE_DIR)) { throw 'LEGATUS_STATE_DIR must be an absolute directory.' }
        return [IO.Path]::GetFullPath($env:LEGATUS_STATE_DIR)
    }
    if ($IsWindows) {
        return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI/Legatus'
    }
    $profileDirectory = [Environment]::GetFolderPath('UserProfile')
    if (![IO.Path]::IsPathFullyQualified($profileDirectory)) { throw 'Could not resolve the user profile directory.' }
    if ($IsMacOS) { return Join-Path $profileDirectory 'Library/Application Support/Legatus' }
    if ($env:XDG_STATE_HOME -and [IO.Path]::IsPathFullyQualified($env:XDG_STATE_HOME)) {
        return Join-Path $env:XDG_STATE_HOME 'legatus'
    }
    return Join-Path $profileDirectory '.local/state/legatus'
}

function New-LegatusStateDirectory([string]$Directory) {
    if ($IsWindows) { return [IO.Directory]::CreateDirectory($Directory) }
    if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'Use PowerShell 7.4 or later on Linux or macOS.' }
    $private = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
    return [IO.Directory]::CreateDirectory($Directory, $private)
}
