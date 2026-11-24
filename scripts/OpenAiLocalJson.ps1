function Assert-OpenAiJsonMembers([Text.Json.JsonElement]$Element, [switch]$Recursive) {
    if ($Element.ValueKind -eq 'Object') {
        $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (!$keys.Add($property.Name)) { throw 'Ambiguous duplicate JSON member.' }
            if ($Recursive) { Assert-OpenAiJsonMembers $property.Value -Recursive }
        }
    } elseif ($Recursive -and $Element.ValueKind -eq 'Array') {
        foreach ($item in $Element.EnumerateArray()) { Assert-OpenAiJsonMembers $item -Recursive }
    }
}

function ConvertFrom-OpenAiJsonObject([string]$Text, [int]$Depth = 16) {
    $document = [Text.Json.JsonDocument]::Parse($Text, [Text.Json.JsonDocumentOptions]@{MaxDepth=$Depth})
    try {
        if ($document.RootElement.ValueKind -ne 'Object') { throw 'Expected a JSON object.' }
        Assert-OpenAiJsonMembers $document.RootElement -Recursive
        ConvertFrom-Json -InputObject $Text -AsHashtable -Depth $Depth
    } finally { $document.Dispose() }
}

function Read-OpenAiLocalBytes([string]$Path, [int]$Limit, [switch]$LiveJournal) {
    $share = if ($LiveJournal) { [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete } else { [IO.FileShare]::Read }
    $file = [IO.File]::Open($Path, 'Open', 'Read', $share)
    try {
        $initialLength = $file.Length
        if ($initialLength -gt $Limit) { throw 'Local evidence exceeds its byte limit.' }
        $bytes = [byte[]]::new([int]$initialLength)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $file.Read($bytes, $offset, $bytes.Length - $offset)
            if (!$count) { break }
            $offset += $count
        }
        if (!$LiveJournal -and ($offset -ne $initialLength -or $file.Length -ne $initialLength)) {
            throw 'Local evidence changed while it was read.'
        }
        @{ bytes = $bytes; length = $offset }
    } finally { $file.Dispose() }
}

function Read-OpenAiLocalText([string]$Path, [int]$Limit) {
    $source = Read-OpenAiLocalBytes $Path $Limit
    [Text.UTF8Encoding]::new($false, $true).GetString($source.bytes).TrimStart([char]0xfeff)
}

function Get-OpenAiZonedTimestamp($Value) {
    if ($Value -is [DateTimeOffset]) {
        if ($Value -le [DateTimeOffset]::UtcNow) { return $Value.ToUniversalTime().ToString('o') }
        return
    }
    if ($Value -is [DateTime] -and $Value.Kind -ne [DateTimeKind]::Unspecified) {
        if ($Value.ToUniversalTime() -le [DateTime]::UtcNow) { return $Value.ToUniversalTime().ToString('o') }
        return
    }
    if ($Value -isnot [string] -or $Value -cnotmatch 'T.+(?:Z|[+-]\d\d:\d\d)\z') { return }
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($Value,[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,[ref]$parsed) -and $parsed -le [DateTimeOffset]::UtcNow) {
        return $parsed.ToUniversalTime().ToString('o')
    }
}
function Read-OpenAiStableInstructions([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
        throw 'Expected a stable instructions text file up to 1 MiB.'
    }
    Read-OpenAiLocalText $item.FullName 1MB
}
