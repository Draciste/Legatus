---
name: legatus
description: Use an OpenAI project key for Responses, Decisions, files, managed Agents sessions, deferred jobs, and other API workflows on Linux, macOS or Windows. Includes token counting and optional integrations.
---

# LEGATVS NATVS

> Ten kdo deleguje a vrací se s výsledky.

Legatus submits work through the OpenAI API, tracks it, and brings the results
back to Codex. Invoke it as `$legatus`.

## Choose the local entry

Follow the [installation guide](README.md#install-from-source) for a fresh
checkout. Include the official OpenAI CLI as a fallback and diagnostic client,
and install OpenAI Developers in Codex for its OpenAI Platform app. Only the
user decides whether to connect the app. The shared Node.js entry
`scripts/openai-agents.mjs` accepts a UTF-8 JSON invocation
on stdin. `doctor`, `catalog` and `qualify` can be passed as arguments and
work offline. Live calls read `OPENAI_API_KEY` from the process environment.

The PowerShell launchers, local queue and job inventory are available on
Linux, macOS and Windows. Use PowerShell 7.4+ on Linux/macOS and 7.2+ on
Windows. Windows keeps the saved credential by default. For the portable
PowerShell setup, see [runtime maintenance](references/runtime-maintenance.md).

This skill's rules apply only when using its workflows to call the OpenAI API.
Codex sessions and subagents follow the user's Codex settings and global
routing rules.

Unless the user directs otherwise, prefer a suitable API route that can
apply available free or promotional credits. If credits are unavailable
or no eligible route can meet the task, choose the best suitable authorized
route under the usual cost, quality and timing criteria.

For incidental live API checks the AI initiates to validate its own tooling
or workflow, prefer an eligible daily complimentary-token model only if it
can adequately perform the check. User-requested testing or artifact audits
follow the task's normal model selection and quality requirements. Check
current model and project eligibility when it matters.

When the user has connected OpenAI Platform, use its account information as
needed for routing, cost planning and diagnosis. It is the available in-Codex
source for directly observing remaining API credit without opening a separate
signed-in browser. Match its organization and project scope to the selected
API credential. For balance checks, report amount, currency and observation
time. See [Platform billing and diagnostics](references/platform-billing.md)
for browser fallbacks and key setup.

For these API calls, use global adaptive routing to choose the model family,
version and supported reasoning effort based on task demands, expected quality
and total cost. Reuse valid API pricing evidence. Moderately prefer the newest
suitable Sol with `high` effort. Choose otherwise when task fit or cost warrants it.

For API task handling, reuse normal project materials and workflows. The API
route alone requires no separate staging, anonymization, security screening or
reapproval. Apply ordinary Codex safety, privacy, authorization and applicable
data-handling requirements. When the user requests the API, use it wherever
comparable results are expected.

## Plan remote work and rate limits

Before delegating, compare local execution cost with preparation, remote
execution and local review costs for comparable results. Prefer local work if
preparation alone likely costs more than completing it locally. Account for the
model each route needs, pricing and eligible credits. The API can still be a
better choice for expensive reasoning such as Astra or a material quality gain.

Split substantial work into coherent chunks that can be reviewed, merged or
resumed independently. Keep related evidence together. Avoid tiny requests that
repeat context and increase request overhead. Plan for the peak minute of
all model rounds, including repeated context, tool output, reasoning and
other work sharing the same TPM/RPM pool. If peak load or current headroom
is uncertain, normally finish one heavy part before submitting another.
Use the optional [delegation queue](references/delegation.md) for local
coordination and recovery. Parallel work is useful with sufficient capacity.
Treat cost and token forecasts as advisory. Allow enough headroom to finish.
Never turn an estimate into an automatic spend, output, reasoning or time cap.
If an actual user or provider limit threatens completion, surface it before
dispatch and choose a workable scope or route within the requested limits.

Reuse verified rate ceilings like pricing evidence. Cache them with the
organization and its usage tier, project, model or shared limit group, request
mode and time checked. Refresh when the tier, project limits, model or mode
changes, or when current limit information contradicts the cache. Use current
response headers with a known matching scope for remaining capacity and reset
timing. A cached limit does not describe current occupancy. For
Batch and eligible Background modes, check the applicable queued-token budget.
[OpenAI API rate limits](https://developers.openai.com/api/docs/guides/rate-limits)

## Optional deferred work

When the user asks for deferred processing, use the [deferred work guide](references/deferred-work.md)
to check current OpenAI options and effective project limits, then report the
recommended route, timing and estimated cost. Check the shared Batch/Background
queued input-token budget independently of TPM. Use deferred processing only when
it fits the user's request. Keep ordinary API calls on their existing path.

## Optional managed Agents API

For remotely managed multi-step work, use the [Agents API guide](references/agents-api.md)
and the [local launcher](scripts/openai-agents.ps1). It uses the selected project
credential and supports submission, streaming, recovery, and file transfers.
Use `catalog` to discover operations. Choose the environment, model, scope,
and billing according to the task. For approved defensive work, see the optional
[Daybreak path](references/agents-api.md#optional-daybreak). Check project and
model eligibility before dispatch. Preserve structured policy outcomes and
recover uncertain jobs by their original IDs.

## Additional API workflows

Use the [API workflow guide](references/api-workflows.md) when useful for
Decisions triage, Responses streams, structured results, files and search,
background and Batch recovery, media, or evaluation. The SDK launcher covers
these operations with the same selected project credential. Use `catalog` to discover
actions. Keep local receipts for work that may need resuming. Read the local
inventory or check the remote ID before repeating a request with unknown outcome.

For Responses container artifacts, provenance, multipart uploads, GPT-Live,
and separate Workspace Agents authentication, see [extended workflows](references/extended-workflows.md).
For optional cache diagnosis, mid-turn steering, and remote Multi-agent, see
[Responses controls](references/api-workflows.md#on-demand-responses-controls).
For recorded charges, see [Admin usage and costs](references/platform-billing.md#optional-admin-usage-and-costs).
Apply [Agents session budgets](references/agents-api.md#optional-session-spend-limits)
when an explicit budget is requested. For repeated GPT-6.2 audits, see the prompt-prefix
recipe. Prefer the current
qualified runtime and maintain versions through the [runtime guide](references/runtime-maintenance.md).

Use the optional [workbench](references/workbench.md) for targeted action
discovery, job recovery, partial Batch reconciliation, audit schemas and
benchmarks, advisory estimates, read-only MCP, or paired Responses transport tests.

## Buffered API calls

Use the [PowerShell helper](scripts/openai-api.ps1) with PowerShell 7.4+
on Linux/macOS or 7.2+ on Windows. In the examples, set `$helper` to its absolute path. Use `&` to
invoke it, and start a fresh `pwsh` after upgrading the helper if your current
process has loaded a previous version of its compiled types.
The standalone local shell verified for this installation is
`%LOCALAPPDATA%\Programs\OpenAI-Local-API\PowerShell\7.7.0\pwsh.exe`.

Use an authorized project key. For optional guided creation and local setup
with OpenAI Developers, see [key setup](references/platform-billing.md#optional-key-setup).
On Linux and macOS provide `OPENAI_API_KEY` in the process environment. On
Windows store it as a generic text credential named `OpenAI API pro Codex` in Windows Credential
Manager under the Windows account running the helper. The OpenAI CLI receives that credential in the child environment. Keep the
key out of command lines and transcripts. The helper clears inherited
endpoint, proxy, trust and diagnostic overrides from native processes that
receive the saved key. Ordinary Security retains its native configuration.
The local launcher still depends on the installed applications and system trust.

HTTP is the default for Models, Responses, RetrieveResponse and InputTokens.
Use the official native CLI with `-Transport Cli` as a fallback or to compare
read-only results, such as a model list, when diagnosing the primary transport.
Check whether the provider accepted an earlier write before replaying it on
another transport. Linux/macOS discovers `openai` on `PATH`. Windows uses
`%LOCALAPPDATA%\Programs\OpenAI-CLI\bin\openai.exe`.
The helper passes Responses JSON through explicit `--request-file -`. CLI
1.56.1 can retry a Responses POST on some transient errors. For InputTokens
use HTTP or SDK `responses.inputtokens` for whole-request counting. The
helper rejects the native InputTokens route because it can silently miss
implicit stdin on Windows. The
helper makes a single application-level HTTP send per invocation and leaves
retries and transport changes to the caller. Batch Submit selects a file for upload.
CLI 1.56.1 keeps automatic updates opt-in. The helper explicitly disables CLI
updates and notices during its calls so its selected version stays predictable.
[OpenAI CLI 1.56.1 input contract](https://github.com/openai/openai-cli/blob/v1.56.1/docs/shell-file-input.md)

Set `$model`, `$inputText`, and `$effort` for the request. Use `$null` for
`$effort` to omit it.

```powershell
& $helper -Operation Models | ConvertFrom-Json
$body = @{ model = $model; input = $inputText; store = $false }
if ($effort) { $body.reasoning = @{ effort = $effort } }
$requestJson = $body | ConvertTo-Json -Depth 20 -Compress
try {
    $result = & $helper -Operation Responses -IncludeReceipt -Json $requestJson
    $response = $result.body | ConvertFrom-Json
} catch {
    $details = $_.Exception.Data['OpenAiLocalApi']
    throw
}
```

Choose a supported effort and an output budget if useful. Model listing shows
visibility. The actual call verifies the selected combination of model, effort
and tools. API processing still uses the project's billing and data controls.
For ordinary Responses the helper defaults omitted or null `store` to `false`
and honors explicit booleans. Set `background = $true` for a background request.
OpenAI temporarily retains background response data for execution and
retrieval even with `store = $false`. Batch files and individual Batch request
bodies have their own retention and lifecycle.
[Background mode](https://developers.openai.com/api/docs/guides/background)

The helper buffers results. `-MaxInputMiB` defaults to 32 MiB of prepared UTF-8
request JSON, including `store` when the helper adds it. `-MaxOutputMiB` defaults
to 64 MiB of decoded HTTP body or UTF-8 CLI stdout bytes. Buffering and parsing
can use more memory. Use a streaming client for streaming Responses or large
transfers. The local JSON parser also limits nesting to 64 levels. A larger
byte budget does not raise that limit.

`-TimeoutSeconds` defaults to 600 seconds, or 3,600 for Security. It bounds
HTTP I/O or the wait after native process start. Setup and result parsing are
outside that phase. The WSL watchdog has a grace period and native cleanup can
add a short wait. Remote work can continue after the local deadline.

Check `response.status`, `incomplete_details`, and the output items for refusals
or tool calls. `queued` and `in_progress` indicate accepted work. Keep the
returned ID and use `-Operation RetrieveResponse -ResponseId $id` to get a
stored or background response. The helper checks the returned ID. Inspect the
status again after retrieval and treat unfamiliar statuses as unresolved. To
request cancellation use the official CLI `responses cancel --response-id ID`
with authentication for the same project. [Responses API](https://developers.openai.com/api/reference/resources/responses/)

## Results and recovery

| Operation | Default result | Options |
| --- | --- | --- |
| Models, Responses, RetrieveResponse, InputTokens | JSON text | `-IncludeReceipt` returns a PowerShell object with the text in `body` and metadata in `receipt`. |
| Batch Submit, List, Get, Cancel | JSON text | Same receipt option. A single-batch receipt includes `batchId` and `batchStatus`. Get and Cancel check the returned ID. |
| Batch File | Buffered text from the CLI | Same receipt option. Use a native file download for byte-exact copies. |
| Security | Native stdout text | Same receipt option. Add `-IncludeNativeDiagnostics` to collect bounded stderr separately on success. Pass the native command first in `-SecurityArgs` and request its JSON format when useful. |
| SecurityLogin | PowerShell object with `status`, `transport`, and `exitCode` | Returns its own object with or without `-IncludeReceipt`. |
| Doctor | PowerShell object with PowerShell version and file presence flags | Add `-CheckReadiness` for offline version probes, build entrypoints and a cached tokenizer known-answer test. Verify actual login, project access and service behavior on the route in use. |

Inspect `$_.Exception.Data['OpenAiLocalApi']` for failure category, HTTP status
or native exit code, request IDs, API code/type and retry delay when available.
Parameter binding errors come directly from PowerShell. The native fields
`localExitConfirmed` and `localIoSettled` describe local cleanup. If either
is false, check the process before restarting. `stdoutTruncated` and
`diagnosticTruncated` describe the available stream captures.
Local exit and settled pipes do not establish descendant termination or remote
completion. Native scan uncertainty may carry both `checkNativeState` and
`outcomeUnconfirmed`. Inspect scan receipts, artifacts and the effective native
context before repeating a scan that may still run remotely.

When `outcomeUnconfirmed` is true, reconcile with the same API project before
repeating paid or state-changing work. `responseId`, `responseStatus`, and
Batch `recovery` on an exception provide lookup hints. `recoveryEvidence`
identifies their sources and `recoveryConflictFields` flags disagreement. For
Responses try retrieving the observed ID when stored. For Batch retrieve the
observed batch ID and compare its input file ID, or page through Batch List to
find a batch with the observed input file ID. If only the upload may have
succeeded, check the project's file records. Inspect returned status and files
to determine the work's outcome. Request IDs correlate requests and logs.
[API request IDs](https://developers.openai.com/api/reference/overview/)

For substantial work, optionally pass `-CheckpointPath` with a new local JSONL
path in an existing task directory. The helper flushes a metadata-only dispatch
record before sending and records observed result IDs or error state before
returning. A dispatch record alone or an incomplete final line means the outcome
is unknown. Read the last complete record, then reconcile using the same
credential and project. `-CheckpointProject` is a caller-supplied project hint.
`-ClientRequestId` optionally forwards a caller-chosen correlation ID on HTTP
or OpenAI CLI calls. This ID is not an idempotency key. Native Security uses a
local attempt ID and a separate native scan receipt when available.

## Batch API

Batch uses the OpenAI CLI for independent work that can wait. Select the
currently supported window in `$batchWindow` and the intended file in
`$jsonlPath`. Prepare UTF-8 JSONL with a single model and
endpoint and unique `custom_id` values. Each line includes `method`, `url`,
and `body`. For Responses use `POST` and `/v1/responses`. The helper passes
a read-locked temporary snapshot to the CLI for upload and submission. The
local byte count and SHA-256 appear in `-IncludeReceipt` and checkpoints as
`sourceBytes` and `sourceSha256`. An explicit `-MaxInputMiB` adds a size cap
for the snapshot. Check available temporary disk space, model support and
Batch pricing when relevant.
[Batch guide](https://developers.openai.com/api/docs/guides/batch)

Submit once, then save the ID for later retrieval. The example polls the
existing batch for up to five minutes and fetches whichever result files are
present at a terminal state. Resume later with `Batch Get` and the same ID if
the batch is still pending.

```powershell
$batch = & $helper -Operation Batch -BatchAction Submit -BatchTarget $jsonlPath -BatchCompletionWindow $batchWindow | ConvertFrom-Json
$batchId = $batch.id
$state = $batch
$terminal = 'completed', 'failed', 'expired', 'cancelled'
$pollBudget = [TimeSpan]::FromMinutes(5)
$pollClock = [Diagnostics.Stopwatch]::StartNew()
while ($state.status -cnotin $terminal -and $pollClock.Elapsed -lt $pollBudget) {
    $remaining = ($pollBudget - $pollClock.Elapsed).TotalSeconds
    if ($remaining -lt 1) { break }
    $readTimeout = [int][Math]::Min(30, [Math]::Floor($remaining))
    $state = & $helper -Operation Batch -BatchAction Get -BatchTarget $batchId -TimeoutSeconds $readTimeout | ConvertFrom-Json
    if ($state.status -cnotin $terminal) {
        $pause = [Math]::Min(10, ($pollBudget - $pollClock.Elapsed).TotalSeconds)
        if ($pause -gt 0) { Start-Sleep -Seconds $pause }
    }
}

$batchFiles = @{}
if ($state.status -cin $terminal) {
    foreach ($field in 'output_file_id', 'error_file_id') {
        $property = $state.PSObject.Properties[$field]
        if ($null -ne $property -and $property.Value) {
            $batchFiles[$field] = & $helper -Operation Batch -BatchAction File -BatchTarget $property.Value
        }
    }
}
```

Expired and cancelled batches can have partial output. Match rows from both
files by `custom_id`. `List` returns up to 20 batches per page. Pass the last
ID as `-BatchAfter` if `has_more` is true. `Cancel` takes a batch ID.
`batchCreateState=not-dispatched` can come from a structured preparation or
upload failure. The upload may still require reconciliation. A missing batch in
List does not prove that an in-flight create failed. Reuse an uploaded file only
when the prior create is known not to have been sent, or its failure is
confirmed, and the file belongs to the same authenticated project. Then
`batches create --input-file-id ID --endpoint /v1/responses --completion-window WINDOW`
can use the file.

## Token counts

For request-level input budgeting, pass the selected model, input, and relevant
instructions and tools in `$countJson` to
`& $helper -Operation InputTokens -Json $countJson`. Completed Responses report
actual usage and cache details. Project billing records determine charges and
credit application.

For optional local counts, use a Python venv with `tiktoken` and a prepared
encoding cache. The example uses the Windows-installed venv under
`%LOCALAPPDATA%\Programs\OpenAI-Tiktoken`. On Linux/macOS, point it to the
chosen venv's `bin/python` and the actual encoding cache.
Set `$encoding` to the matching cached encoding (`o200k_base`, `cl100k_base`,
or `o200k_harmony`) and `$textPath` to an absolute path to a UTF-8 file. This
offline recipe isolates Python imports, bounds the whole-file input and counts
exact line endings and any leading BOM
as text. API framing, tool schemas, images, and cache pricing are separate.

```powershell
$tok = Join-Path $env:LOCALAPPDATA 'Programs/OpenAI-Tiktoken'
$cache = Join-Path $tok 'encodings'
$maxBytes = 32MB
$countScript = @'
import os, pathlib, sys
from unittest.mock import patch
import tiktoken

os.environ["TIKTOKEN_CACHE_DIR"] = sys.argv[1]
with patch("tiktoken.load.read_file", side_effect=RuntimeError("Offline tokenizer cache is missing or invalid")):
    encoder = tiktoken.get_encoding(sys.argv[2])
limit = int(sys.argv[4])
with pathlib.Path(sys.argv[3]).open("rb") as source:
    data = source.read(limit + 1)
if len(data) > limit:
    raise SystemExit("Tokenizer input exceeds the selected byte limit.")
print(len(encoder.encode_ordinary(data.decode("utf-8"))))
'@
$count = $countScript | & (Join-Path $tok '.venv/Scripts/python.exe') -I - $cache $encoding $textPath $maxBytes
if ($LASTEXITCODE -ne 0) { throw 'Offline token counting failed.' }
$count
```

## Optional integrations

**Plugin Eval.** Use `plugin-eval:evaluate-skill` or
`plugin-eval:evaluate-plugin` when the plugin is available. Static analysis and
budget estimates run locally. Live benchmarks run through a separate Codex CLI
harness with its own effective authentication, workload and artifacts. Use
measured runs when their results justify the model calls, and attribute the
usage to the harness that produced it. [Plugin Eval](https://github.com/openai/plugins/tree/main/plugins/plugin-eval)

## Defensive repository work

Use Codex Security when its defensive repository workflows fit. The helper's
`Security` operation passes arguments to the native tool in command-first
order and uses that tool's authentication and configuration. It skips the
saved credential and removes named OpenAI and Codex API-key variables before
launch. Native stores, project configuration, and custom provider settings
can still determine the effective authentication. Use
`codex-security <command> --help` for supported arguments.
Use the native tool or host SDK directly for TTY operations or the streaming
`scan --host` protocol. The buffered helper closes stdin after its input.

The Linux/macOS route discovers `codex-security` on `PATH`. On Windows the
native route (`Cli`, the default) respects `CODEX_SECURITY_STATE_DIR`
and otherwise uses `%LOCALAPPDATA%\OpenAI\Codex-Security-API`. `Wsl` invokes
the installed wrapper as user `node` in `Inquisitor-DevAiAye-Debian`, with
working directory `/home/node` and its own native configuration. Pass
WSL-visible repository and artifact paths with this route. Keep artifacts
outside the reviewed repository.

Check sign-in through the same route and native context you intend to use.
Before model calls, verify the effective provider and project for the command.

```powershell
$securityTransport = 'Wsl' # Use 'Cli' to check the Windows route.
$loginStatus = & $helper -Operation Security -Transport $securityTransport -SecurityArgs @('login', 'status', '--json') | ConvertFrom-Json
```

A validated signed-out JSON result with exit 1 throws with
`kind = native_signed_out`. Its original JSON is available in
`$_.Exception.Data['OpenAiLocalApiResult']`. To provision the intended native
store explicitly, use `-Operation SecurityLogin -Transport Cli` or `Wsl`.
That operation supplies the saved key over stdin to `login --with-api-key`
and can replace the native sign-in. `status = native_login_completed` records
the login process's successful exit. Check status again in that route to
verify sign-in. Windows login runs from the user's local app-data directory
and uses the configured native state directory. For scans, recheck the effective
provider, account/project, repository and result on the selected Windows or WSL route.

For threshold-gated scans request JSON. When native `scan` exits 1 with a
completed JSON manifest, the helper throws with `kind = completed_nonzero`
and preserves the original JSON in `OpenAiLocalApiResult`. Check scope,
artifacts, coverage, and policy to interpret the result. A dry run checks
setup. When `checkNativeState` is true, inspect native login or artifacts and
the local process state before restarting. A remote operation may still be
running after local termination. Check the API project's usage and billing
for API-key Codex calls, which the ChatGPT-linked promotional benefit excludes.
Delegation binds each new WorkId to its exact request, stable instructions and
project hint. On ambiguous dispatch reconcile the stored attempt and its
correlation before retry. A late quota review names the specific attempt. HTTP
receipt rate headers describe a request observation, with method and UTC time
when available. Use fresh scope-matched capacity evidence for forecasts.

[Codex Security CLI](https://github.com/openai/codex-security/blob/main/sdk/typescript/docs/cli.md) · [API credit terms](https://developers.openai.com/api/docs/guides/chatgpt-api-credits#what-the-credits-cover)
