#Requires -Version 7.2
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Equals($Actual, $Expected, [string]$Description) {
    if ($Actual -cne $Expected) { throw "$Description. Expected <$Expected>, got <$Actual>." }
}

$rootName = 'legatus-delegation-' + [Guid]::NewGuid().ToString('N')
$root = [IO.Directory]::CreateDirectory((Join-Path ([IO.Path]::GetTempPath()) $rootName)).FullName
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
    foreach ($name in 'openai-delegate.ps1','openai-jobs.ps1','OpenAiFailureClassification.ps1','OpenAiLocalJson.ps1','OpenAiQueueEvidence.ps1','OpenAiPlatform.ps1') {
        Copy-Item -LiteralPath (Join-Path $scripts $name) -Destination $root
    }
    $fixture = @'
param($Action, $Json, $CheckpointPath, $Id, $TimeoutSeconds, $StableInstructionsPath, $StableInstructionsText, $ProjectHint, $ClientRequestId)
$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot 'fixture-state.txt'
$mode = if (Test-Path -LiteralPath $state) { (Get-Content -LiteralPath $state -Raw).Trim() }
if ($Action -eq 'responses.create') {
    if ($StableInstructionsPath) { throw 'Fixture launcher must not reopen the instructor path.' }
    if ($StableInstructionsText) {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'stable.txt'), 'Replacement instructions')
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'stable-observed.txt'), $StableInstructionsText)
    }
    $request = [Text.Json.JsonDocument]::Parse($Json)
    try {
        if (!$request.RootElement.GetProperty('background').GetBoolean() -or
            !$request.RootElement.GetProperty('store').GetBoolean()) { throw 'Fixture saw an incorrect request.' }
    } finally { $request.Dispose() }
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'creates.txt') -Value 'POST'
    if ($mode -eq 'publish-blocked') {
        [void][IO.Directory]::CreateDirectory((Join-Path (Split-Path -Parent $CheckpointPath) 'result.json'))
    }
    if ($mode -in 'rejected','billing-http','unknown') {
        $status = if ($mode -eq 'rejected') {400} elseif ($mode -eq 'billing-http') {429}
        $code = if ($mode -eq 'rejected') {'invalid_request_error'} elseif ($mode -eq 'billing-http') {'credit_balance_exhausted'}
        $failure = @{
            action=$Action; phase='error'; clientRequestId=$ClientRequestId; httpStatus=$status
            dispatch='attempted'; apiCode=$code; outcomeUnconfirmed=($mode -eq 'unknown')
            at='2001-01-01T00:00:00Z'; headerObservedAt='2000-01-01T00:00:00Z'
            sourceMethod='POST'; headerScope='failure-observation'; headers=@{ 'x-ratelimit-remaining-tokens' = '33' }
        }
        $failure | ConvertTo-Json -Compress | Set-Content -LiteralPath $CheckpointPath
        $exception = [InvalidOperationException]::new('Fixture dispatch error')
        $exception.Data['OpenAiLocalAgents'] = $failure
        throw $exception
    }
    $Id = 'resp_fixture_' + @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'creates.txt')).Count
    @{
        action = $Action; phase = 'response_received'; clientRequestId = $ClientRequestId
        resourceId = $Id; resourceStatus = 'queued'
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $CheckpointPath
} else {
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'reads.txt') -Value 'GET'
    if ($mode -eq 'unavailable') { throw 'Fixture unavailable' }
    if ($mode -eq 'missing') {
        $exception = [InvalidOperationException]::new('Fixture Response unavailable')
        $exception.Data['OpenAiLocalAgents'] = @{ httpStatus = 404; apiCode = 'not_found'; outcomeUnconfirmed = $false }
        throw $exception
    }
}
$status = if ($mode -in 'fail','billing-terminal') { 'failed' }
    elseif ($mode -in 'complete','late','publish-blocked') { 'completed' }
    elseif ($Action -eq 'responses.create') { 'queued' } else { 'in_progress' }
$envelope = @{
    receipt = @{ action = $Action; clientRequestId = $ClientRequestId; headers = @{ 'x-request-id' = 'req_fixture' }; resourceId = $Id;
        headerObservedAt = '2002-01-01T00:00:00Z'; sourceMethod = if ($Action -eq 'responses.create') { 'POST' } else { 'GET' };
        headerScope = 'response-observation' }
    data = @{ object = 'response'; id = $Id; status = $status; output = @(@{ text = 'partial finding' }) }
}
if ($status -eq 'failed') { $envelope.data.error = @{ code = 'rate_limit_exceeded' } }
if ($mode -eq 'billing-terminal') { $envelope.data.error.code = 'credit_balance_exhausted' }
$payload = $envelope | ConvertTo-Json -Depth 8 -Compress
if ($mode -eq 'late') {
    $exception = [InvalidOperationException]::new('Fixture late exit')
    $exception.Data['OpenAiLocalApiResult'] = $payload
    throw $exception
}
$payload
'@
    Set-Content -LiteralPath (Join-Path $root 'openai-agents.ps1') -Value $fixture
    $delegate = Join-Path $root 'openai-delegate.ps1'
    $directory = Join-Path $root 'queue'
    $request = @{ model = 'fixture'; background = $true; store = $true; input = 'fixture' }
    $badNames = @{ model = 'fixture'; Background = $true; Store = $true; input = 'fixture' }
    $variant = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
    foreach ($field in $request.Keys) { $variant.Add($field, $request[$field]) }
    $variant.Add('Background', $false)
    foreach ($badRequest in $badNames,$variant) {
        $errorThrown = $null
        try { & $delegate Submit -Directory $directory -Request $badRequest } catch { $errorThrown = $_ }
        if (!$errorThrown -or $errorThrown.Exception.Message -notmatch 'case-exact') { throw 'Expected case-exact admission failure.' }
    }
    Assert-Equals (Test-Path -LiteralPath (Join-Path $root 'creates.txt')) $false 'Bad wire keys were rejected before sends'
    $start = & $delegate Submit -Directory $directory -Request $request -WorkId 'first'
    Assert-Equals $start.submitted $true 'First request was accepted'
    $busy = & $delegate Submit -Directory $directory -Request $request
    Assert-Equals $busy.submitted $false 'An active pool did not admit another request'
    Assert-Equals $busy.responseStatus 'in_progress' 'The existing response was retrieved'
    $currentPath = Join-Path $directory 'openai-shared/current.json'
    $current = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json -AsHashtable
    $current.state = 'dispatching'
    $current.responseId = $null
    $current | ConvertTo-Json | Set-Content -LiteralPath $currentPath
    $recovered = & $delegate Status -Directory $directory
    Assert-Equals $recovered.responseId $start.responseId 'Recovery used the checkpoint Response ID'
    Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count 1 'Only one POST happened'

    $fixtureState = Join-Path $root 'fixture-state.txt'
    Set-Content -LiteralPath $fixtureState -Value 'fail'
    $failed = & $delegate Status -Directory $directory
    Assert-Equals $failed.responseStatus 'failed' 'The provider failure is retained'
    $result = Get-Content -LiteralPath $failed.resultPath -Raw | ConvertFrom-Json
    Assert-Equals $result.data.output[0].text 'partial finding' 'Failed response kept partial content'
    $review = & $delegate Submit -Directory $directory -Request $request
    Assert-Equals $review.state 'review_shared_capacity' 'TPM failure triggered capacity review'
    Assert-Equals $review.submitted $false 'Capacity review did not send anything'

    $current = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json -AsHashtable
    $current.state = 'active'
    $current | ConvertTo-Json | Set-Content -LiteralPath $currentPath
    Set-Content -LiteralPath $fixtureState -Value 'unavailable'
    $reads = @(Get-Content -LiteralPath (Join-Path $root 'reads.txt')).Count
    $fromDisk = & $delegate Status -Directory $directory
    Assert-Equals $fromDisk.responseStatus 'failed' 'Recovery reused the saved terminal result'
    Assert-Equals ([DateTimeOffset]$fromDisk.observedAt) ([DateTimeOffset]$failed.observedAt) 'Local recovery retained the original header observation time'
    Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'reads.txt')).Count $reads 'Saved recovery needed no GET'

    Set-Content -LiteralPath $fixtureState -Value 'complete'
    $next = & $delegate Submit -Directory $directory -Request $request -CapacityReviewed -ExpectedAttempt $failed.attempt -WorkId 'second'
    Assert-Equals $next.submitted $true 'After capacity review a new request was accepted'
    Assert-Equals $next.state 'terminal' 'An immediate terminal response was saved without waiting for a GET'
    Assert-Equals (Test-Path -LiteralPath $next.resultPath) $true 'The response envelope is present'
    $repeat = & $delegate Submit -Directory $directory -Request $request -WorkId 'second'
    Assert-Equals $repeat.submitted $false 'A repeated logical work ID did not POST again'
    $archived = & $delegate Status -Directory $directory -WorkId 'first'
    Assert-Equals $archived.attempt $start.attempt 'Rotated work is still available by ID'
    $goodResult = Get-Content -LiteralPath $archived.resultPath -Raw
    Copy-Item -LiteralPath $next.resultPath -Destination $archived.resultPath -Force
    $invalidArchive = & $delegate Status -Directory $directory -WorkId 'first'
    Assert-Equals $invalidArchive.state 'local_result_invalid' 'An archived file for a different ID is not reported as a valid result'
    Assert-Equals $invalidArchive.resultPath $null 'Archived result mismatch preserves the file without delivering it as valid'
    Set-Content -LiteralPath $archived.resultPath -Value $goodResult -NoNewline
    [IO.File]::Move($archived.resultPath, ($archived.resultPath + '.fixture-old'))
    Set-Content -LiteralPath $fixtureState -Value 'fail'
    $archiveRepair = & $delegate Status -Directory $directory -WorkId 'first'
    Assert-Equals $archiveRepair.responseStatus 'failed' 'A missing archived file was restored by its Response ID'
    Assert-Equals (& $delegate Status -Directory $directory).attempt $next.attempt 'Archive recovery did not replace current work'
    $stale = & $delegate Submit -Directory $directory -Request $request -CapacityReviewed -ExpectedAttempt $failed.attempt
    Assert-Equals $stale.state 'attempt_changed' 'A stale quota acknowledgement cannot be used'
    $poolLock = [IO.File]::Open((Join-Path $directory 'openai-shared/pool.lock'), 'Open', 'ReadWrite', 'None')
    try {
        $locked = & $delegate Status -Directory $directory
        Assert-Equals $locked.state 'busy' 'An actual file-share lock enforces one caller'
    } finally { $poolLock.Dispose() }

    foreach ($mode in 'billing-http','billing-terminal') {
        $quotaDirectory = Join-Path $root $mode
        Set-Content -LiteralPath $fixtureState -Value $mode
        $quota = & $delegate Submit -Directory $quotaDirectory -Request $request -WarningAction SilentlyContinue
        $held = & $delegate Submit -Directory $quotaDirectory -Request $request
        Assert-Equals $quota.providerError 'credit_balance_exhausted' 'Original billing code is retained'
        Assert-Equals $held.state 'review_billing' 'Billing requires review in both phases'
        Set-Content -LiteralPath $fixtureState -Value 'complete'
        $admitted = & $delegate Submit -Directory $quotaDirectory -Request $request -BillingReviewed -ExpectedAttempt $quota.attempt
        Assert-Equals $admitted.submitted $true 'Current billing review allows new work'
    }

    $repairDirectory = Join-Path $root 'rejection'
    Set-Content -LiteralPath $fixtureState -Value 'rejected'
    $reject = & $delegate Submit -Directory $repairDirectory -Request $request -WarningAction SilentlyContinue
    Assert-Equals $reject.dispatchOutcome 'explicitly_rejected' 'HTTP 400 is a resolved attempt'
    $rejectionPath = Join-Path $repairDirectory 'openai-shared/current.json'
    $rejectionState = Get-Content -LiteralPath $rejectionPath -Raw | ConvertFrom-Json -AsHashtable
    $rejectionState.state = 'dispatching'
    $rejectionState | ConvertTo-Json | Set-Content -LiteralPath $rejectionPath
    $rejectionRecovered = & $delegate Status -Directory $repairDirectory
    Assert-Equals $rejectionRecovered.state 'not_accepted' 'The negative journal survives interruption'
    Assert-Equals $rejectionRecovered.providerError 'invalid_request_error' 'The journal retains rejection reason'
    Assert-Equals ([DateTimeOffset]::Parse($rejectionRecovered.observedAt).UtcDateTime.Year) 2000 'Recovered rejection retains original header time'
    Assert-Equals $rejectionRecovered.rateHeaders.'x-ratelimit-remaining-tokens' '33' 'Recovered header and observation came from the same row'
    Assert-Equals $rejectionRecovered.headerMethod 'POST' 'Recovery keeps the request method'
    if (!$rejectionRecovered.recoveredAt) { throw 'Expected recovery time as separate metadata.' }
    Set-Content -LiteralPath $fixtureState -Value 'late'
    $late = & $delegate Submit -Directory $repairDirectory -Request $request -ProjectHint 'proj_fixture'
    Assert-Equals $late.state 'terminal' 'Late complete result survived a launcher failure'
    Assert-Equals $late.projectHint 'proj_fixture' 'Caller project hint remains attached to the attempt'
    Assert-Equals (Test-Path -LiteralPath $late.resultPath) $true 'Late result was persisted'
    $pendingDirectory = Join-Path $root 'pending-publication'
    Set-Content -LiteralPath $fixtureState -Value 'publish-blocked'
    $pendingResult = & $delegate Submit -Directory $pendingDirectory -Request $request -WorkId 'publish-pending'
    Assert-Equals $pendingResult.state 'local_result_pending' 'A terminal response remains known when publication fails'
    Assert-Equals $pendingResult.remoteTerminal $true 'Publication failure does not erase remote completion'
    $createsBefore = @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count
    $blocked = Join-Path (Split-Path -Parent $pendingResult.receiptPath) 'result.json'
    [IO.Directory]::Delete($blocked, $false)
    Set-Content -LiteralPath $fixtureState -Value 'complete'
    $repaired = & $delegate Status -Directory $pendingDirectory -WorkId 'publish-pending'
    Assert-Equals $repaired.responseId $pendingResult.responseId 'The same Response is used to recover the local result'
    Assert-Equals $repaired.resultState 'verified' 'Recovery published the missing local result'
    Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count $createsBefore 'Publication recovery did not send another create'

    $exactDirectory = Join-Path $root 'result-integrity'
    $exact = & $delegate Submit -Directory $exactDirectory -Request $request -WorkId 'exact-publication'
    Assert-Equals $exact.resultIntegrity 'sha256' 'New terminal files carry a digest'
    $otherText = [IO.File]::ReadAllText($exact.resultPath).Replace('partial finding', 'changed finding')
    [IO.File]::WriteAllText($exact.resultPath, $otherText)
    $changedResult = & $delegate Status -Directory $exactDirectory -WorkId 'exact-publication'
    Assert-Equals $changedResult.state 'local_result_invalid' 'Changed content is detected even with its Response ID and status intact'

    $snapshotDirectory = Join-Path $root 'stable-snapshot'
    $snapshotFile = Join-Path $root 'stable.txt'
    [IO.File]::WriteAllText($snapshotFile, 'Original stable instructions')
    $processDirectory = [Environment]::CurrentDirectory
    [Environment]::CurrentDirectory = [IO.Directory]::CreateDirectory((Join-Path $root 'separate-process-directory')).FullName
    Push-Location -LiteralPath $root
    try { $captured = & $delegate Submit -Directory $snapshotDirectory -Request $request -StableInstructionsPath 'stable.txt' -WorkId 'stable' }
    finally { Pop-Location; [Environment]::CurrentDirectory = $processDirectory }
    Assert-Equals $captured.requestFingerprintVersion 1 'New attempts identify their fingerprint recipe'
    Assert-Equals ((Get-Content -LiteralPath (Join-Path $root 'stable-observed.txt') -Raw).Trim()) 'Original stable instructions' 'The launcher received the fingerprinted snapshot'
    $changedStable = & $delegate Submit -Directory $snapshotDirectory -Request $request -StableInstructionsPath $snapshotFile -WorkId 'stable'
    Assert-Equals $changedStable.state 'work_request_conflict' 'Changed instructions require a different work identity'
    $sameWorkDirectory = Join-Path $root 'work-fingerprint'
    Set-Content -LiteralPath $fixtureState -Value 'complete'
    $work = & $delegate Submit -Directory $sameWorkDirectory -Request $request -WorkId 'fixed'
    $changed = [ordered]@{ model='gpt-6.2-astra'; input='different request'; background=$true; store=$true }
    $reused = & $delegate Submit -Directory $sameWorkDirectory -Request $changed -WorkId 'fixed'
    Assert-Equals $reused.state 'work_request_conflict' 'Known work requires the original input'
    Assert-Equals $reused.attempt $work.attempt 'Different input leaves the original work intact'

    $interrupted = Get-Content -LiteralPath $rejectionPath -Raw | ConvertFrom-Json -AsHashtable
    $interrupted.state = 'dispatching'
    $interrupted.responseId = $null
    $interrupted | ConvertTo-Json | Set-Content -LiteralPath $rejectionPath
    [IO.File]::Move($late.receiptPath, ($late.receiptPath + '.fixture-old'))
    $knownAfterInterruption = & $delegate Status -Directory $repairDirectory
    Assert-Equals $knownAfterInterruption.responseId $late.responseId 'The saved result recovered the ID without its journal'
    Assert-Equals $knownAfterInterruption.state 'terminal' 'The saved result prevented an uncertain release'

    $unknownDirectory = Join-Path $root 'unknown'
    Set-Content -LiteralPath $fixtureState -Value 'unknown'
    $unknown = & $delegate Submit -Directory $unknownDirectory -Request $request -WorkId 'retire-test' -WarningAction SilentlyContinue
    $reconcile = & $delegate Status -Directory $unknownDirectory
    Assert-Equals $reconcile.state 'reconcile_dispatch' 'Uncertain dispatch stays blocked'
    $oldRelease = & $delegate ReleaseUnconfirmed -Directory $unknownDirectory -Reconciled -ExpectedAttempt ('0' * 32)
    Assert-Equals $oldRelease.state 'attempt_changed' 'Stale release cannot modify a later attempt'
    $released = & $delegate ReleaseUnconfirmed -Directory $unknownDirectory -Reconciled -ExpectedAttempt $unknown.attempt
    Assert-Equals $released.state 'released_after_reconciliation' 'Expected attempt can be manually released'
    $retired = & $delegate Submit -Directory $unknownDirectory -Request $request -WorkId 'retire-test'
    Assert-Equals $retired.submitted $false 'A retired ambiguous work ID cannot be replayed by Submit'
    @{
        action='responses.create'; phase='response_received'
        clientRequestId=(Get-Content -LiteralPath $unknown.receiptPath -TotalCount 1 | ConvertFrom-Json).clientRequestId
        resourceId='resp_fixture'; resourceStatus='queued'
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $unknown.receiptPath
    $lateAfterRelease = & $delegate Submit -Directory $unknownDirectory -Request $request -WorkId 'another-task'
    Assert-Equals $lateAfterRelease.state 'late_acceptance' 'Delayed acceptance after release is explicit'
    Assert-Equals $lateAfterRelease.submitted $false 'Delayed acceptance is reconciled without a fresh POST'

    $rotatedDirectory = Join-Path $root 'rotated'
    Set-Content -LiteralPath $fixtureState -Value 'unknown'
    $noWorkId = & $delegate Submit -Directory $rotatedDirectory -Request $request -WarningAction SilentlyContinue
    $null = & $delegate ReleaseUnconfirmed -Directory $rotatedDirectory -Reconciled -ExpectedAttempt $noWorkId.attempt
    Set-Content -LiteralPath $fixtureState -Value 'complete'
    $middle = & $delegate Submit -Directory $rotatedDirectory -Request $request -WorkId 'middle'
    Assert-Equals $middle.state 'terminal' 'Initial release permits other work while acceptance is still unknown'
    @{
        action='responses.create'; phase='response_received'
        clientRequestId=(Get-Content -LiteralPath $noWorkId.receiptPath -TotalCount 1 | ConvertFrom-Json).clientRequestId
        resourceId='resp_retired_fixture'; resourceStatus='queued'
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $noWorkId.receiptPath
    $lateRotated = & $delegate Submit -Directory $rotatedDirectory -Request $request -WorkId 'after-middle'
    Assert-Equals $lateRotated.state 'late_acceptance' 'A late acceptance is seen before unrelated work is sent'
    Assert-Equals $lateRotated.responseId 'resp_retired_fixture' 'Retired attempt identity does not require a WorkId'
    Set-Content -LiteralPath $fixtureState -Value 'billing-terminal'
    $completedRetired = & $delegate Status -Directory $rotatedDirectory
    Assert-Equals $completedRetired.remoteTerminal $true 'Status can collect the retired response without changing the current slot'
    Assert-Equals (& $delegate Status -Directory $rotatedDirectory -WorkId 'middle').attempt $middle.attempt 'Current slot survived retirement collection'
    $review = & $delegate Submit -Directory $rotatedDirectory -Request $request -WorkId 'after-middle'
    Assert-Equals $review.state 'review_billing' 'Late terminal billing evidence blocks the next admission'
    Assert-Equals $review.attempt $noWorkId.attempt 'Quota review names the retired attempt'
    Set-Content -LiteralPath $fixtureState -Value 'complete'
    Assert-Equals (& $delegate Submit -Directory $rotatedDirectory -Request $request -WorkId 'after-middle' -BillingReviewed -ExpectedAttempt $noWorkId.attempt).submitted $true 'Review of the specific retired attempt releases admission'

    foreach ($firstReview in 'current','retired') {
        $dualDirectory = Join-Path $root "both-quota-$firstReview"
        Set-Content -LiteralPath $fixtureState -Value 'unknown'
        $old = & $delegate Submit -Directory $dualDirectory -Request $request -WarningAction SilentlyContinue
        $null = & $delegate ReleaseUnconfirmed -Directory $dualDirectory -Reconciled -ExpectedAttempt $old.attempt
        Set-Content -LiteralPath $fixtureState -Value 'fail'
        $recent = & $delegate Submit -Directory $dualDirectory -Request $request -WorkId 'recent'
        @{ action='responses.create'; phase='response_received'
           clientRequestId=(Get-Content -LiteralPath $old.receiptPath -TotalCount 1 | ConvertFrom-Json).clientRequestId
           resourceId='resp_older_quota_fixture'; resourceStatus='queued' } |
           ConvertTo-Json -Compress | Add-Content -LiteralPath $old.receiptPath
        Set-Content -LiteralPath $fixtureState -Value 'billing-terminal'
        $retiredResult = & $delegate Status -Directory $dualDirectory
        Assert-Equals $retiredResult.responseId 'resp_older_quota_fixture' 'Late Response is collected with its original identity'
        Set-Content -LiteralPath $fixtureState -Value 'complete'
        $beforeReview = @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count
        if ($firstReview -eq 'current') {
            $blocked = & $delegate Submit -Directory $dualDirectory -Request $request -CapacityReviewed -ExpectedAttempt $recent.attempt
            Assert-Equals $blocked.attempt $old.attempt 'Current review exposes the pending retired review'
            Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count $beforeReview 'One review admits no work'
            $admitted = & $delegate Submit -Directory $dualDirectory -Request $request -BillingReviewed -ExpectedAttempt $old.attempt
        } else {
            $blocked = & $delegate Submit -Directory $dualDirectory -Request $request -BillingReviewed -ExpectedAttempt $old.attempt
            Assert-Equals $blocked.attempt $recent.attempt 'Retired review exposes the pending current review'
            Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count $beforeReview 'One review admits no work'
            $admitted = & $delegate Submit -Directory $dualDirectory -Request $request -CapacityReviewed -ExpectedAttempt $recent.attempt
        }
        Assert-Equals $admitted.submitted $true 'The two independently recorded reviews admit a fresh request'
        Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count ($beforeReview + 1) 'Only the fresh request was dispatched'
    }

    $missingDirectory = Join-Path $root 'response-unavailable'
    Set-Content -LiteralPath $fixtureState -Value 'pending'
    $pending = & $delegate Submit -Directory $missingDirectory -Request $request -WorkId 'retrieval-fixture'
    Set-Content -LiteralPath $fixtureState -Value 'missing'
    $beforeRetrieval = @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count
    $missing = & $delegate Submit -Directory $missingDirectory -Request $request -WorkId 'other-fixture' -WarningAction SilentlyContinue
    Assert-Equals $missing.state 'review_retrieval' '404 returns a scoped review without releasing the slot'
    Assert-Equals $missing.retrievalFailure.httpStatus 404 'Response retrieval status is retained'
    Assert-Equals $missing.responseId $pending.responseId 'Retrieval review retains the original Response ID'
    Set-Content -LiteralPath $fixtureState -Value 'complete'
    $found = & $delegate Status -Directory $missingDirectory -WorkId 'retrieval-fixture'
    Assert-Equals $found.responseId $pending.responseId 'Status recovered the known Response'
    Assert-Equals $found.retrievalFailure $null 'Successful recovery clears the retrieval failure'
    Assert-Equals @(Get-Content -LiteralPath (Join-Path $root 'creates.txt')).Count $beforeRetrieval 'Recovery did not dispatch another request'

    $ambiguousDirectory = Join-Path $root 'ambiguous'
    Set-Content -LiteralPath $fixtureState -Value 'unknown'
    $ambiguous = & $delegate Submit -Directory $ambiguousDirectory -Request $request -WarningAction SilentlyContinue
    '{"action":"responses.create","phase":"error","clientRequestId":"fixture","outcomeUnconfirmed":false}' |
        Add-Content -LiteralPath $ambiguous.receiptPath
    $resolved = & $delegate Status -Directory $ambiguousDirectory
    Assert-Equals $resolved.state 'invalid_submit_journal' 'Separate rows cannot be combined into negative dispatch evidence'

    $conflictDirectory = [IO.Directory]::CreateDirectory((Join-Path $root 'conflict')).FullName
    foreach ($id in 'batch_first','batch_second') {
        @{ action='batches.retrieve'; phase='response_received'; clientRequestId='fixture'; resourceId=$id } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $conflictDirectory 'batch.jsonl')
    }
    $conflicts = & (Join-Path $root 'openai-jobs.ps1') -Directory $conflictDirectory -WithNext | ConvertFrom-Json
    Assert-Equals $conflicts[0].state 'conflicting_resource_ids' 'Conflicting identity is surfaced for Batch'
    Assert-Equals $conflicts[0].next.action $null 'Conflicting IDs do not give a recovery action'
    @{ action='responses.retrieve'; phase='response_received'; clientRequestId='fixture';
       requestedId='resp_first'; resourceId='resp_second' } |
       ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $conflictDirectory 'retrieve.jsonl')
    '{"action":"responses.create","action":"responses.create"}' |
       Set-Content -LiteralPath (Join-Path $conflictDirectory 'invalid.jsonl')
    foreach ($state in @(
        @{ state='contiguous-observed'; lastDurableContiguousSequence=4; origin='creation-observed' },
        @{ state='incomplete-history' }
    )) {
        @{ action='responses.retrieve'; phase='stream_progress'; clientRequestId='fixture';
           resourceId='resp_stream'; sequenceNumber=7; streamIntegrity=$state } |
           ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $conflictDirectory 'stream.jsonl')
    }
    Set-Content -LiteralPath (Join-Path $conflictDirectory 'partial.jsonl') -NoNewline -Value '{"action":"responses.create"'
    $nativeCheckpoint = Join-Path $conflictDirectory 'native.jsonl'
    @{ version=2; operation='Batch'; state='error'; attemptId='fixture_native'; status=429;
       errorCode='credit_balance_exhausted'; errorType='billing_error'; utc='2001-01-01T00:00:00Z';
       headerObservedAt='2000-01-01T00:00:00Z'; headerMethod='POST'; headerScope='failure-observation';
       outcomeUnconfirmed=$true; recoveryConflictFields=@('batch_id'); recoveryEvidence=@{batch_id=@('stdout','stderr')} } |
       ConvertTo-Json -Compress -Depth 5 | Set-Content -LiteralPath $nativeCheckpoint
    @{ version=2; operation='Batch'; state='local_cleanup'; attemptId='fixture_native'; localExitConfirmed=$true;localIoSettled=$false } |
       ConvertTo-Json -Compress | Add-Content -LiteralPath $nativeCheckpoint
    $directoryStates = & (Join-Path $root 'openai-jobs.ps1') -Directory $conflictDirectory -WithNext | ConvertFrom-Json
    Assert-Equals ($directoryStates | Where-Object checkpoint -Like '*retrieve.jsonl').state 'conflicting_response_ids' 'Requested and returned identities must agree'
    Assert-Equals ($directoryStates | Where-Object checkpoint -Like '*invalid.jsonl').state 'invalid_checkpoint_lines' 'A file with only invalid rows remains visible'
    $streamInventory = $directoryStates | Where-Object checkpoint -Like '*stream.jsonl'
    Assert-Equals $streamInventory.streamIntegrity 'incomplete-history' 'Reports the latest stream integrity'
    Assert-Equals $streamInventory.sequenceNumber 7 'Retains the observed sequence for diagnostics'
    Assert-Equals ($null -eq $streamInventory.PSObject.Properties['lastDurableContiguousSequence']) $true 'Inventory drops a withdrawn resume cursor'
    Assert-Equals ($directoryStates | Where-Object checkpoint -Like '*partial.jsonl').state 'partial_checkpoint' 'A truncated first record remains visible'
    $nativeInventory = $directoryStates | Where-Object checkpoint -Like '*native.jsonl'
    Assert-Equals $nativeInventory.httpStatus 429 'Legacy-style buffered HTTP fields map to the SDK inventory'
    Assert-Equals $nativeInventory.apiCode 'credit_balance_exhausted' 'Buffered failure code is retained'
    Assert-Equals ([DateTimeOffset]$nativeInventory.errorObservedAt).Year 2000 'Header time is separate from checkpoint time'
    Assert-Equals $nativeInventory.localExitConfirmed $true 'Cleanup record retains process-exit observation'
    Assert-Equals $nativeInventory.localIoSettled $false 'Incomplete cleanup remains distinct from confirmed exit'
    Assert-Equals $nativeInventory.recoveryConflictFields[0] 'batch_id' 'Receipt conflict is carried into inventory'
    Assert-Equals $nativeInventory.next.action $null 'Receipt conflict provides no automatic recovery hint'

    . (Join-Path $scripts 'OpenAiChildEnvironment.ps1')
    $child = [Diagnostics.ProcessStartInfo]::new()
    $child.Environment['OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN'] = 'fixture'
    $child.Environment['CODEX_API_KEY'] = 'fixture'
    $child.Environment['OPENAI_BASE_URL'] = 'fixture'
    Clear-OpenAiChildEnvironment $child
    Assert-Equals $child.Environment.ContainsKey('OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN') $false 'Workspace token removed'
    Assert-Equals $child.Environment.ContainsKey('CODEX_API_KEY') $false 'Codex token removed'
    Assert-Equals $child.Environment.ContainsKey('OPENAI_BASE_URL') $true 'Native configuration is preserved'
    Clear-OpenAiChildEnvironment $child -Sdk
    Assert-Equals $child.Environment.ContainsKey('OPENAI_BASE_URL') $false 'SDK route owns the endpoint'
    $child.Environment['SSLKEYLOGFILE'] = 'fixture'
    $child.Environment['HTTPS_PROXY'] = 'fixture'
    $child.Environment['CODEX_SECURITY_STATE_DIR'] = 'fixture'
    Clear-OpenAiChildEnvironment $child -CredentialProcess
    Assert-Equals $child.Environment.ContainsKey('SSLKEYLOGFILE') $false 'Credential process strips TLS capture settings'
    Assert-Equals $child.Environment.ContainsKey('HTTPS_PROXY') $false 'Credential process strips inherited proxy overrides'
    Assert-Equals $child.Environment.ContainsKey('CODEX_SECURITY_STATE_DIR') $true 'Security login keeps its selected native store'

    . (Join-Path $scripts 'OpenAiLocalJson.ps1')
    $nativeAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $scripts 'openai-api.ps1'), [ref]$null, [ref]$null)
    foreach ($name in 'ConvertFrom-LocalApiJson','Get-LocalApiScanEvidence','New-LocalApiBatchSnapshot','Remove-LocalApiBatchSnapshot') {
        $definition = $nativeAst.Find({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
        }, $false)
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $scan = Get-LocalApiScanEvidence '{"ok":false,"data":{"manifest":{"scan":{"id":"scan_fixture","status":"completed"}}}}'
    Assert-Equals $scan.id 'scan_fixture' 'A contradictory envelope retains the scan identity'
    Assert-Equals $scan.completed $false 'An unsuccessful envelope cannot confirm scan completion'
    Assert-Equals (Get-LocalApiScanEvidence '{"ok":true,"data":{"manifest":{"scan":{"id":"scan_fixture","status":"completed"}}}}').completed $true 'A successful envelope can establish completion evidence'
    Assert-Equals (Get-LocalApiScanEvidence '{"manifest":{"scan":{"status":"completed","status":"completed"}}}') $null 'Duplicate diagnostic members invalidate completion evidence'
    $snapshotSource = Join-Path $root 'source.jsonl'
    [IO.File]::WriteAllText($snapshotSource, "{`"text`":`"Příliš`"}`n")
    $batchSnapshot = New-LocalApiBatchSnapshot $snapshotSource ([long]::MaxValue)
    try {
        Assert-Equals $batchSnapshot.evidence.bytes ([IO.FileInfo]::new($snapshotSource).Length) 'Uncapped Batch snapshots record input length'
        Assert-Equals $batchSnapshot.evidence.sha256 (Get-FileHash -LiteralPath $snapshotSource).Hash.ToLowerInvariant() 'Batch snapshot records digest from the copied bytes'
        Assert-Equals (Get-FileHash -LiteralPath $batchSnapshot.handle.Name).Hash (Get-FileHash -LiteralPath $snapshotSource).Hash 'The CLI-facing snapshot has the same bytes'
    } finally {
        $batchSnapshot.handle.Dispose()
        Remove-LocalApiBatchSnapshot $batchSnapshot.handle.Name
    }

    if ($IsWindows -or $PSVersionTable.PSVersion -ge [version]'7.4') {
        Copy-Item -LiteralPath (Join-Path $scripts 'openai-agents.ps1') -Destination (Join-Path $root 'test-sdk-envelope.ps1')
        Copy-Item -LiteralPath (Join-Path $scripts 'OpenAiChildEnvironment.ps1') -Destination $root
        Copy-Item -LiteralPath (Join-Path $scripts 'OpenAiPlatform.ps1') -Destination $root
        Set-Content -LiteralPath (Join-Path $root 'Get-OpenAiRuntime.ps1') -Value 'throw "Fixture runtime must not start"'
        $largeRaw = '{"input":"' + (([string][char]92) * (16MB - 12)) + '"}'
        $largeStable = ([string][char]1) * 1MB
        try {
            & (Join-Path $root 'test-sdk-envelope.ps1') responses.create -Json $largeRaw -StableInstructionsText $largeStable
            throw 'Expected local encoded size validation.'
        } catch {
            if ($_.Exception.Message -notmatch 'Encoded SDK invocation exceeds the 36 MiB') { throw }
            Assert-Equals $_.Exception.Data['OpenAiLocalAgents'].dispatch 'not-attempted' 'Encoded input size is checked before dispatch'
        }
    }
    'Delegation queue, recovery, TPM review, child-environment and native receipt fixtures passed.'
} finally {
    if ([IO.Path]::GetDirectoryName($root) -eq [IO.Path]::GetTempPath().TrimEnd('\','/') -and
        [IO.Path]::GetFileName($root).StartsWith('legatus-delegation-')) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
