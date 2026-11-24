# Large Responses delegations

Split an audit into coherent parts. Keep peak load in mind across the full
execution, including tool output, replayed context and later model turns.
Use current applicable rate data and [advisory estimates](workbench.md) when
you have them. Serial submission reduces overlap when shared headroom is
uncertain. Treat the actual provider capacity separately. Check the queued
input limit for applicable Background tiers and Batch.

For optional local coordination, use one pool for clients sharing a quota.
The default `openai-shared` covers callers using the default directory on
the same local account and machine. Use the same pool and directory when sharing
a limit. Use separate pools only for known separate quotas. Other hosts,
direct CLI/SDK calls and unrelated organization jobs are outside this local lock.

```powershell
$delegate = (Resolve-Path ./scripts/openai-delegate.ps1).Path
# $request is an ordinary Responses hashtable with background=$true and store=$true.
& $delegate Submit -Request $request -StableInstructionsPath $stableInstructions -WorkId 'audit-cli-v2'
& $delegate Status -WorkId 'audit-cli-v2'
```

`Submit` reports `submitted=true` only for a new accepted Response. If a
previous job still owns the slot, it checks that job and returns its status
with `submitted=false`. Review terminal output before making a new Submit
call. Each attempt has a durable submit journal and its own result path.
Use the exact JSON names `background` and `store` with boolean `true`.
Omit `stream` or use boolean `false`.
Choose a stable `-WorkId` for a logical task so a lost acknowledgement
can be recovered without sending it again. A completed or otherwise
terminal Response is returned for a repeated work ID, including after
the pool moves on. An explicitly retired uncertain work ID stays retired.
Use a fresh work ID for newly authorized remaining work.
The versioned request fingerprint uses the same stable instructions snapshot
as submission. The receipt records the fingerprint without the instructions.
Relative instruction paths resolve from the caller's PowerShell filesystem
location.
Optional `-ProjectHint` records the caller's expected identity for recovery.
Use the same effective project key when retrieving the Response.
The full terminal response is kept even when `failed` or `incomplete`.
`resultPath` identifies a published envelope whose Response ID and terminal
status match. New envelopes also record `resultSha256`. Older envelopes may
report `resultIntegrity=identity-only`. For `local_result_pending`, use
`Status` with the same work ID to retrieve the known Response. A conflicting
destination or `local_result_invalid` needs local reconciliation first. Keep
the suspect file at `unverifiedResultPath` and save any separately retrieved
result to a fresh path. `observationPersistence=reconcile-local-state` means
the current observation could not be saved completely. Check the existing
attempt before another submission.
Inspect it for inline text, refusal, missing deliverables and available usage.
Retrieve needed cited files promptly by their actual container and file IDs.
[Container artifacts](extended-workflows.md#responses-containers-and-agent-artifacts)

After `review_shared_capacity` or an unclassified `review_rate_limit`,
inspect the provider code, scope and reset timing before
`-CapacityReviewed -ExpectedAttempt $priorAttempt`. For `review_billing`,
confirm balance, project and authorization before
`-BillingReviewed -ExpectedAttempt $priorAttempt`. Both switches apply
to a new Submit carrying the ID of the reviewed prior attempt. The pool
records each review against its attempt before checking other outstanding
reviews. Resolve each named attempt when the current and a retired attempt
both report quota observations.
Fill only remaining work and preserve the recovered output. Provider
limit, current remaining capacity, queued input, usage and actual charges
are separate. `headerAction` identifies which call supplied the latest
headers. `headerMethod` and `headerScope` preserve their context when known.
Submit headers and their method, scope and time have separate fields.
`observedAt` remains the original measurement time when known. `recoveredAt`
records when local recovery found it. A recovered timestamp may be absent.

After interruption use `Status`. A unique matching checkpoint ID lets it
retrieve the existing response. A complete negative receipt can establish
an explicit rejection or a preflight failure. A retrieval error retains the
slot and keeps its HTTP status and safe API codes in `retrievalFailure`.
`review_retrieval` calls for checking the effective project, access or
availability before using `Status` again on the same Response. A 404 can have
several causes. If dispatch is uncertain and no trustworthy ID can be recovered, reconcile the
attempt before `ReleaseUnconfirmed -Reconciled -ExpectedAttempt $priorAttempt`. This retires the local
attempt without creating or cancelling remote work. Confirm that the prior
submitter has stopped. A subsequently found Response ID is reported as
`late_acceptance` for reconciliation. Released attempts remain on a local
watch list even after rotation and even without a WorkId. Before another
submission, the coordinator checks just those recorded attempts for new
acceptance evidence. Use `Status` without a WorkId to collect a detected
late response once the current job is terminal. With a WorkId, `Status`
can collect that specific archived response. Older archived releases enter
the watch list when accessed. A missing current record alongside attempt
directories requires manual reconciliation (`orphaned_pool_state`). Keep the receipt and
partial files as evidence. For intentional concurrency with sufficient
headroom or another supported route, use the ordinary API workflow explicitly.

[Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) ·
[Background mode](https://developers.openai.com/api/docs/guides/background)
