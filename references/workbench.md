# Legatus workbench

These helpers operate beside the normal API launcher. Discovery, job hints,
Batch planning, audit validation, benchmarking and estimation run locally.
Use local files from your own job when supplying a receipt or benchmark input.

```powershell
$scripts = (Resolve-Path ./scripts).Path
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$workbench = Join-Path $scripts 'openai-workbench.mjs'
$api = Join-Path $scripts 'openai-agents.ps1'
$jobs = Join-Path $scripts 'openai-jobs.ps1'
$delegate = Join-Path $scripts 'openai-delegate.ps1'
& $node $workbench discover 'obnov nedokončenou dávku'
& $jobs $jobDirectory -WithNext
```

## Discover and resume

The search returns up to five matches by default, including the launcher,
credential route, network use, possible remote state changes and job
creation. Provider permissions and charges depend on the actual call.
Common matches include a PowerShell example using the variables above.
Read the [delegation guide](delegation.md) before retiring an unresolved attempt.
Search for an exact action name to get its local contract. For natural-language
search, name the action you want and its subject. A missing or ambiguous match
can include guidance. Use the full catalogue or the official CLI's
`openai explore` for capabilities the search could not match.
For a request for bytes and metadata, a `workflow.actions` hint names both
reads. Discovery only suggests operations.

`-WithNext` adds read-only follow-up hints to checkpoint inventory. It
distinguishes recorded pending or terminal Batch states from unknown and
mixed attempts. Recheck the actual remote state before acting on a hint.
A missing response can occur when `store=false` and does not establish
that a request never ran. Pilot checkpoints contain multiple scoped
attempts. Open the raw checkpoint to inspect their individual IDs.

## Recover a partly completed Batch

1. Collect terminal status and available artifacts with `batches.wait`.
   Save its emitted result object as UTF-8 JSON even when the action
   returns nonzero with `review-required`.
   `artifactsCollected` describes local collection independently of Batch status.
   `artifactVerification.inputError` describes a failed input download.
   Local staging cleanup warnings appear alongside any confirmed result.
2. Use `files.content` on the exact `input_file_id` and save its result
   as a second receipt. If a download was interrupted, collect the
   missing artifact individually and supply that receipt. A fresh
   results directory keeps previous files available for verification.
3. Run the planner on a JSON file with `waitReceiptPath`,
   `inputReceiptPath`, optional `outputReceiptPath` and
   `errorReceiptPath`, and optional fresh `retryPath`.

```powershell
& $node $workbench batch.plan $planJsonPath
```

The planner checks artifact File IDs, byte counts, SHA-256, a matching
nonempty `/v1/...` endpoint and case-sensitive `custom_id` values. It rejects duplicate JSON
members in the plan, receipts, and every input, output and error row.
Successful receipts for the same artifact must agree on byte count and SHA-256.
If the Batch input was
uploaded with `uploads.transfer`, its completed receipt plus
`inputSourcePath` may replace the input download. The original local
bytes must still match the receipt. Legacy receipts without SHA-256
need a fresh download. Check each returned response for application-level
quality even when its HTTP status is successful.

A retry file contains only rows explicitly classified by the server as
`batch_expired` with a literal null `response`, provided the original and all referenced
artifacts reconcile with the terminal Batch and its counts. Conflicting,
missing, or other error rows need review. An expired file can keep both
completed rows and errors. Review the proposed retry file before submitting
it through the normal Batch path. An exact integer is required for decision
counts and status codes. The count check tolerates receipts that include
expired rows in `failed` and receipts that count them separately, provided
the joined rows otherwise reconcile. [Batch expiration](https://developers.openai.com/api/docs/guides/batch#batch-expiration)

## Structured audit findings and benchmark

```powershell
$format = & $node $workbench audit.schema | ConvertFrom-Json -AsHashtable
$request.text = @{ format = $format }
& $node $workbench audit.validate $structuredFindingsFile
& $node $workbench benchmark $benchmarkJsonPath
```

The format is for the Responses `text.format` field. Each finding carries
an ID, title, evidence references, status (`observed`, `inferred`, or
`unverified`) and a statement of uncertainty. Keep the original answer and
artifacts alongside any normalized report. The schema requires evidence for
observed findings. Use it with models that support the stated string and array
constraints. The local validator also checks duplicate IDs. Evidence and
correctness still need review. Inspect API
refusals and incomplete responses before interpreting a findings report.

For the benchmark file use `cases: [{id, expected:[findingId, ...]}]` and
`runs: [{caseId, profile, report, elapsedMs?, usage?, billedUsd?}]`.
Use the same cases and repetition counts per profile, and normalize equivalent
findings to stable reference IDs after reviewing their evidence. The scorer
reports counts by profile and case as `repetitionsByCase`. Its `accepted`
count requires a matching ID, an evidence reference and an observed or inferred
status. Assess whether each reference supports the finding separately. It also
measures misses, false positives, runtime, measured usage when supplied,
and billed USD per accepted finding when a comparable actual cost is known.
`profile` can encode the model, effort and mode. Billing and elapsed time
are supplied by the caller. The benchmark reads local results and sends no jobs.

Start with [three synthetic cases](audit-benchmark-cases.json), including a
clean control. Send only each case's `prompt` to the model, using the same
output schema and comparable settings. Retain the original response, record
usage and elapsed time, and add each reviewed run to `runs` before scoring.
These cases check this workflow. Use more representative cases before making
general model or pricing decisions.

## Advisory forecast and observed usage

```powershell
& $node $workbench estimate $estimateJsonPath
```

Supply `model`, `mode` and `forecast` with total `inputTokens` and
`outputTokens` including reasoning. Optional `cachedInputTokens` and
`cacheWriteTokens` are disjoint subsets of input. Specify `tpm`, `rpm`
and `queuedInputTokens` in the forecast when applicable. For a single
ordinary standard call TPM defaults to input plus output. Set `multiStep:true`
for multiple model rounds and supply an estimated peak `tpm` or
`minuteWindows:[{modelInputTokens,modelOutputTokens},...]` for candidate
rolling 60-second windows. Include repeated context and tool results in
the input tally of the rounds that consume them, and reasoning in output.
If both TPM inputs are supplied, `peakTpm` reports their values, any
disagreement and the larger peak. Optional `tpmHeadroomTokens` adds headroom
to the chosen peak. An unknown multi-step peak stays unknown.
For a closer input count, use the existing InputTokens workflow on the
actual request where supported, including its stable prefix and tools.
Provide a current matching `pricing` object with `model`, `mode`,
`currency`, `source`, `checkedAt` and `perMillion` rates
(`input`, `cachedInput`, `cacheWrite30m`, `cacheWrite12h`, `output`).
Forecast a split with `cacheWriteTokensDetails: {ttl30mTokens,ttl12hTokens}`.
The legacy aggregate forecast can use a single `cacheWrite` rate.
Use the rates and cache semantics of the actual model and mode. Unknown or
incompatible numbers remain unknown. Optional `usage` accepts Responses
token counts including the native nested TTL breakdown. Use rates applicable
to the context size of the request. Missing rates or an unresolved write
breakdown leave the observed cost unknown. A calendar date is accepted for
rate calculations. A zoned `checkedAt` and a
`validUntil` describing the observed price window enable `pricingEvidence.fresh`.
Amounts always use the supplied rates.
If a monetary total falls outside the representable range, that field is
`null` and its name appears in `outOfRange`. Benchmark cost and integer
totals use the same convention. Missing metrics remain `null` without that flag.
The token subtotal excludes separately charged tools. Check actual billed
amounts in the appropriate organization.

Optional `capacity` accepts `tpm`/`tpmUsed`, `rpm`/`rpmUsed` and
`sharedQueueInputTokens`/`sharedQueueUsed`. Each check reports `numericalFit`
from the supplied counters and demand. It also reports `fitsEstimate` when
the capacity evidence applies to the requested scope and is current.
Supply `scope` with `organization`, `project` and optional `limitGroup`.
Match those values in `capacity`, use `project:null` on both sides for an
explicit organization-wide limit, and match `capacity.mode` to `mode`.
Supply `capacity.model` matching `model` when no shared group is selected.
Include a `source`, the actual observation time `checkedAt`, and a
`validUntil` based on the corresponding reset or validity window. Use
timestamps with a time zone. Optional `sourceAction` and `sourceMethod`
identify the request that produced the evidence. For a GET or a known read action,
set `scopeConfirmed:true` only after confirming that the read's quota covers
the next model request. Missing, stale, future-dated, or differently scoped evidence leaves
`fitsEstimate` unknown. This comparison is advisory and uses the supplied
counters, including other active work. Queued input capacity is independent of
TPM and RPM. Account for the documented shared queue where it applies to Batch
and Background.

**A forecast is advisory.** An underestimate must never become a spend cap,
output or reasoning cap, or local timeout on the submitted task. Allow
meaningful completion headroom, including tool use and variance in reasoning.
If an independently configured provider or user limit would make completion
unlikely, surface it before submission and agree on a viable scope, route
or actual limit. Apply the user's explicit limit as instructed. Keep
foreground, Background and Batch execution independent of this calculator.

[API pricing](https://developers.openai.com/api/docs/pricing) ·
[Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) ·
[Background](https://developers.openai.com/api/docs/guides/background)

## Optional read-only MCP

Start the local stdio entry point with the Node executable and absolute path
to `openai-workbench-mcp.mjs`. Its positional arguments are optional absolute
paths for the checkpoint directory, result directory, and PowerShell
executable. An empty directory argument leaves that tool disabled.
On Windows the server prefers `Program Files/PowerShell/7` and then checks
`PATH`. On Linux and macOS it checks `PATH` for `pwsh`. An explicit absolute
executable path takes precedence. If PowerShell is unavailable, the job tool
reports the missing dependency while the other configured tools still work.

```powershell
codex mcp add legatus -- $node (Join-Path $scripts 'openai-workbench-mcp.mjs') $jobDirectory $resultDirectory
```

It offers `find_action`, `list_jobs` when a checkpoint directory is configured,
and `read_result` when a result directory is configured. Choose dedicated
directories that hold only outputs you want the MCP client to be able to
read and whose writers you trust. Use ordinary filesystem permissions to
enforce this boundary. Result access is one regular file by basename up to 32 KiB.
Unicode and spaces are supported. A refused result read can return a structured
code such as `file_not_found`, `file_too_large` with `limitBytes`, or
`invalid_utf8`. Use CLI or file tools for larger evidence. The server reads local data and uses no API key
or remote operations. Register it only when its tool interface is useful.

The stdio server supports the `initialize` handshake for MCP `2024-11-05`,
`2025-03-26`, `2025-06-18` and `2025-11-25`. Supply `clientInfo` and the
`capabilities` object. The two older versions support batches of up to 32
entries. `tools/list` returns one page, so start without a continuation cursor.
A request that explicitly
declares a newer per-request version gets an unsupported-version response
with this list. Use a compatible handshake for the local tools.

When capturing a direct PowerShell child as UTF-8 on Windows, set its console
encoding before running a launcher or inventory. The default follows the
child console. MCP configures its own child for UTF-8.

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& $jobs $jobDirectory -WithNext
```

Ask for “list local jobs” or “recover a local checkpoint” to find the offline
inventory route and its requirements. Use its suggested follow-up to choose
a remote read when you need current server state or the stored result.
Use “file metadata”, “file content” or “list files” to distinguish object
details, a download and a page of results. For remote work, name the API
resource, such as a Batch or an Agents session. For the local inventory use
“list local jobs”. A generic “list jobs” needs one of those scopes.

## Optional paired Responses WebSocket pilot

```powershell
& $api responses.pilot -Request @{ model = $model; turns = 2 } -TimeoutSeconds 120 -CheckpointPath $newPilotReceipt
```

This is a metered experiment with built-in synthetic prompts, two to five
turns per arm and a deliberate 256-output-token limit per turn for the tiny
expected response. The bound includes reasoning and applies only to the
pilot. The request takes `model`, optional `turns` and `order`. Local options
are `checkpointPath`, `projectHint` and `timeoutSeconds` (1–3600).
Choose an appropriate model. An incomplete turn is a failed trial,
and its partial evidence remains visible. The pilot uses `store=false`,
the standard service tier, no tools and one WebSocket. HTTP/SSE sends
full replayable context. The WebSocket uses the same connection and last
confirmed response ID with each new input. A lost connection or unknown
result stops that run. Examine the checkpoint before considering a fresh
trial. Reversing order with `order = 'websocket-first'` helps check warmup.

Compare application JSON bytes, local latency including separate connection
setup, matched outputs and API-reported input, cached and output tokens.
Application bytes exclude transport framing and compression. See the
response usage and actual billing before attributing savings. The regular
Responses launcher retains its existing transport.
[Responses WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode)
