function Clear-OpenAiChildEnvironment {
    param(
        [Parameter(Mandatory)][Diagnostics.ProcessStartInfo]$StartInfo,
        [switch]$Sdk,
        [switch]$Offline,
        [switch]$CredentialProcess
    )
    foreach ($name in @($StartInfo.Environment.Keys)) {
        if ($name -match '^(OPENAI_(?:.*(?:KEY|TOKEN|SECRET)(?:_|$)|ADMIN_|CUSTOM_HEADERS$|ORG_ID$|PROJECT_ID$|LOG$)|CODEX_API_KEY$)' -or
            (($Sdk -or $Offline) -and $name -match '^(OPENAI_|NODE_|SSLKEYLOGFILE$|SSL_CERT_(FILE|DIR)$)') -or
            (!$IsWindows -and ($Sdk -or $Offline -or $CredentialProcess) -and $name -match '^(LD_|DYLD_|BASH_ENV$|ENV$)') -or
            (($Offline -or $CredentialProcess) -and $name -match '^PYTHON(?:PATH|HOME|STARTUP|USERBASE)$') -or
            ($CredentialProcess -and $name -match '^(OPENAI_|NODE_|SSLKEYLOGFILE$|SSL_CERT_(FILE|DIR)$|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|(?:ALL|HTTP|HTTPS)_PROXY$|RUST_LOG(?:_STYLE)?$|OTEL_)')) {
            [void]$StartInfo.Environment.Remove($name)
        }
    }
}
