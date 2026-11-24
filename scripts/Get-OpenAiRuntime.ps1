param([Parameter(Mandatory)][string]$ManifestDirectory)

. (Join-Path $PSScriptRoot 'OpenAiLocalJson.ps1')
. (Join-Path $PSScriptRoot 'OpenAiPlatform.ps1')
if ($PWD.Provider.Name -ne 'FileSystem') { throw 'Select a filesystem working directory.' }
$manifest = [IO.Path]::GetFullPath($ManifestDirectory, $PWD.ProviderPath)
$sourceLock = Join-Path $manifest 'package-lock.json'
$sourcePackage = Join-Path $manifest 'package.json'
$lockBytes = (Read-OpenAiLocalBytes $sourceLock 4MB).bytes
$lockText = [Text.UTF8Encoding]::new($false, $true).GetString($lockBytes).TrimStart([char]0xfeff)
$lock = ConvertFrom-OpenAiJsonObject $lockText 64
$version = $lock['packages']['node_modules/openai']['version']
if ($version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\z' -or
    $lock['packages']['']['dependencies']['openai'] -cne $version) {
    throw 'The runtime lock must pin an exact OpenAI SDK version.'
}
foreach ($entry in $lock['packages'].GetEnumerator()) {
    if (!$entry.Key) { continue }
    $resolved = $entry.Value['resolved']
    if ($resolved -cnotmatch '\Ahttps://registry\.npmjs\.org/[^?#]+\z' -or
        $entry.Value['integrity'] -cnotmatch '\Asha(?:256|384|512)-[A-Za-z0-9+/=]+\z') {
        throw 'Runtime lock dependencies must be pinned to registry.npmjs.org with integrity metadata.'
    }
}
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($lockBytes))
$root = if ($IsWindows -and !$env:LEGATUS_STATE_DIR) {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/OpenAI-Local-API/AgentsSdk'
} else { Join-Path (Get-LegatusStateRoot) 'AgentsSdk' }
$target = Join-Path $root ($version + '-' + $hash.Substring(0, 16))
$legacy = Join-Path $root $version
$legacyLock = Join-Path $legacy 'package-lock.json'
if (!(Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $legacyLock -PathType Leaf) -and
    (Get-FileHash -LiteralPath $legacyLock).Hash -eq $hash) { $target = $legacy }

[pscustomobject]@{ Root = $root; Runtime = $target; Version = $version; Hash = $hash;
    Lock = $sourceLock; Package = $sourcePackage }
