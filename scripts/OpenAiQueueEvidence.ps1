function ConvertTo-OpenAiDelegationRequest([Collections.IDictionary]$Request) {
    $wire = ConvertTo-Json -InputObject $Request -Compress -Depth 100 -WarningAction Stop
    if ([Text.Encoding]::UTF8.GetByteCount($wire) -gt 16MB) { throw 'Request exceeds 16 MiB.' }
    $document = [Text.Json.JsonDocument]::Parse($wire)
    try {
        $root = $document.RootElement
        if ($root.ValueKind -ne 'Object') { throw 'Expected a JSON request object.' }
        Assert-OpenAiJsonMembers $root
        foreach ($property in $root.EnumerateObject()) {
            if ($property.Name -in 'background','store','stream' -and $property.Name -cnotin 'background','store','stream') {
                throw 'Use case-exact JSON members background, store and stream on a delegation request.'
            }
        }
        $field = [Text.Json.JsonElement]::new()
        foreach ($name in 'background','store') {
            if (!$root.TryGetProperty($name, [ref]$field) -or $field.ValueKind -ne 'True') {
                throw 'Submit requires a non-streaming Responses request with background=true and store=true.'
            }
        }
        if ($root.TryGetProperty('stream', [ref]$field) -and $field.ValueKind -ne 'False') {
            throw 'Submit requires stream=false or an omitted stream member.'
        }
    } finally { $document.Dispose() }
    $wire
}

function Get-OpenAiResponseObservation([string]$Wire) {
    $document = [Text.Json.JsonDocument]::Parse($Wire, [Text.Json.JsonDocumentOptions]@{MaxDepth=128})
    try {
        $root = $document.RootElement
        Assert-OpenAiJsonMembers $root
        $data = $root.GetProperty('data')
        Assert-OpenAiJsonMembers $data
        $receipt = ConvertFrom-OpenAiJsonObject ($root.GetProperty('receipt').GetRawText())
        $errorField = [Text.Json.JsonElement]::new()
        $failure = if ($data.TryGetProperty('error', [ref]$errorField) -and $errorField.ValueKind -eq 'Object') {
            ConvertFrom-OpenAiJsonObject ($errorField.GetRawText())
        }
        $id = $data.GetProperty('id').GetString()
        $status = $data.GetProperty('status').GetString()
        if ($data.GetProperty('object').GetString() -cne 'response' -or $id -cnotmatch '\Aresp_[A-Za-z0-9_-]+\z' -or
            $status -cnotmatch '\A[A-Za-z0-9_-]+\z' -or $receipt['action'] -cnotin 'responses.create','responses.retrieve' -or
            ($receipt['requestedId'] -and $receipt['requestedId'] -cne $id) -or
            ($receipt['resourceId'] -and $receipt['resourceId'] -cne $id) -or
            ($receipt['resourceStatus'] -and $receipt['resourceStatus'] -cne $status)) {
            throw 'Response identity or status does not match its receipt.'
        }
        @{ id=$id; status=$status; terminal=$status -cin 'completed','failed','incomplete','cancelled'
           receipt=$receipt; error=$failure }
    } finally { $document.Dispose() }
}

function Read-OpenAiSubmitJournal([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ kind='absent' } }
    try {
        $source = Read-OpenAiLocalBytes $Path 2MB -LiveJournal
        $end = if ($source.length) { [Array]::LastIndexOf($source.bytes, [byte]10, $source.length - 1) } else { -1 }
        $partial = $end -ne ($source.length - 1)
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($source.bytes,0,$end + 1).TrimStart([char]0xfeff)
        $client = $null
        $positive = $null
        $last = $null
        $seenError = $false
        $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($line in $text.Split([char]10)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $row = ConvertFrom-OpenAiJsonObject $line
            if ($row['action'] -cne 'responses.create' -or $row['clientRequestId'] -isnot [string] -or
                $row['clientRequestId'] -cnotmatch '\A[A-Za-z0-9._-]{1,262}\z' -or
                $row['phase'] -cnotin 'dispatch_pending','http_received','response_received','accepted','error' -or
                ($client -and $row['clientRequestId'] -cne $client) -or
                ($row['phase'] -ceq 'error' -and $seenError)) {
                return @{ kind='invalid' }
            }
            $client = $row['clientRequestId']
            if ($row['phase'] -ceq 'error') { $seenError = $true }
            foreach ($field in 'resourceId','responseId') {
                if ($null -eq $row[$field]) { continue }
                if ($row[$field] -isnot [string] -or $row[$field] -cnotmatch '\Aresp_[A-Za-z0-9_-]+\z') {
                    return @{ kind='invalid' }
                }
                [void]$ids.Add($row[$field])
                $positive = $row
            }
            $last = $row
        }
        if ($ids.Count -gt 1) { return @{ kind='invalid' } }
        if ($ids.Count -eq 1) {
            $positive['kind'] = 'positive'
            $positive['responseId'] = @($ids)[0]
            return $positive
        }
        if ($partial) { return @{ kind='partial' } }
        if ($last -and $last['phase'] -ceq 'error') {
            $last['kind'] = 'error'
            return $last
        }
        @{ kind='unconfirmed'; clientRequestId=$client }
    } catch { @{ kind='invalid' } }
}

function Get-OpenAiDelegationRequestFingerprint([string]$Wire, [string]$Stable, [string]$Project) {
    function Write-OrderedJson([Text.Json.Utf8JsonWriter]$Writer, [Text.Json.JsonElement]$Value) {
        switch ($Value.ValueKind) {
            Object {
                $Writer.WriteStartObject()
                $names = [string[]]@($Value.EnumerateObject() | ForEach-Object Name)
                [Array]::Sort($names, [StringComparer]::Ordinal)
                foreach ($name in $names) {
                    $Writer.WritePropertyName($name)
                    Write-OrderedJson $Writer ($Value.GetProperty($name))
                }
                $Writer.WriteEndObject()
            }
            Array {
                $Writer.WriteStartArray()
                foreach ($item in $Value.EnumerateArray()) { Write-OrderedJson $Writer $item }
                $Writer.WriteEndArray()
            }
            default { $Value.WriteTo($Writer) }
        }
    }
    $document = [Text.Json.JsonDocument]::Parse($Wire)
    try {
        $stream = [IO.MemoryStream]::new()
        try {
            $writer = [Text.Json.Utf8JsonWriter]::new($stream)
            try {
                $writer.WriteStartArray()
                Write-OrderedJson $writer $document.RootElement
                $writer.WriteStringValue($Stable)
                $writer.WriteStringValue($Project)
                $writer.WriteEndArray()
                $writer.Flush()
                [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream.ToArray()))
            } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
    } finally { $document.Dispose() }
}
