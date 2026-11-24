# API workflows from Codex

The normal Codex conversation keeps its own authentication. Use the saved
project API key through this skill for delegated Platform work. An entitled
API operation can use a linked organization's ChatGPT API credit grant. A
Codex process signed in with an API key uses standard API billing and is
excluded from that grant. Check the selected organization, project, current
pricing, queued-token and execution limits when they affect the task. For
credit-first routing, reuse current evidence of available balance and
eligibility for the specific operation, model, mode and tool charges. Refresh
uncertain or stale details when material to route choice. Preserve the user's
requirements and ordinary cost authorization. Report uncertain coverage as
unknown and use billing evidence to confirm credits actually applied.
[Platform billing and diagnostics](platform-billing.md) explains how to use the
connected OpenAI Platform app and signed-in billing views for account
diagnostics, balance, grant expiry and incentive usage.
[API credit terms](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## Choose a route

- Use `openai-api.ps1` for ordinary buffered Responses and server input counts.
- Use the existing SDK launcher `openai-agents.ps1` for raw JSON results with
  receipts, SSE, Decisions, file transfer, retrieval, and managed sessions.
  Run `catalog` for valid actions, parameter placement, and file options.
- Use the official OpenAI CLI as a fallback or for a read-only comparison when
  diagnosing the primary client. Discover native capabilities with
  `openai explore KEYWORDS` and `openai COMMAND --help`. Prefer structured
  formats when scripting. Use a verified connection and explicit project
  authentication before live native calls. The wrappers select the credential
  for the platform and scope. Verify server acceptance before replaying a
  timed-out write.

```powershell
$directory = (Resolve-Path ./scripts).Path
$api = Join-Path $directory 'openai-agents.ps1'
$jobs = Join-Path $directory 'openai-jobs.ps1'
& $api doctor
(& $api catalog | ConvertFrom-Json -AsHashtable).actions['responses.retrieve']
```

Use `-Request` for a PowerShell dictionary or `-Json`/`-RequestPath` for JSON.
The SDK launcher validates raw JSON without PowerShell date normalization,
uses strict UTF-8 for buffered JSON, rejects duplicate members, and refuses
request numbers that would change during SDK serialization. The buffered
HTTP Responses route accepts exact numeric JSON when needed. SDK buffered
results preserve original numeric text when ordinary JavaScript numbers
would change it. Treat SDK SSE as a decoded event stream.
Explicit file destinations must be new. Buffered JSON and SSE have a 64 MiB
decoded response limit. Uploads and file downloads have local limits of 512 MiB and
1 GiB respectively, independently of service limits. A normal download on a
filesystem supporting hard links publishes the whole file atomically. Elsewhere
it uses a non-overwriting copy. After an interrupted copy verify the file or
download to a new path. A failed copy leaves the destination for review.
Preflight uses a temporary name in the output directory. Checkpoint and event
files are live logs and appear when opened. The final artifact name is created
only during publication. A denied scratch cleanup fails preflight and may
leave a `.legatus-probe-*` file. The actual publication still checks collisions.
Publication requires a filesystem with stable file identities. Ordinary
SDK uploads report the bytes read and their SHA-256 in `sourceBytes` and
`sourceSha256` after the source check. The digest describes the local stream.

Use `-IncludeApiMessage` for a bounded error message from the API when the
status and error code are insufficient. This setting is opt-in because a
service message can show details of the request. Checkpoint records omit it.
Use a dedicated checkpoint directory. `openai-jobs.ps1 -MaxCheckpointMiB`
can raise the local inventory reading budget for a large journal. Resolve
conflicting resource IDs or invalid complete lines before relying on a hint.
After dispatch, `localWarnings` can describe a checkpoint or close failure
alongside an intact server receipt. Reconcile the remote and local state
separately when the two disagree.
An unrecognized Responses status preserves the response and
`observedResourceStatus` with `resourceStatusClassification: "unknown"`
and a nonzero SDK launcher exit. Reconcile the observed Response ID.
The buffered PowerShell receipt exposes `observedResponseStatus` and
`responseStatusClassification` while retaining its buffered response body.
If a completed Response has missing or malformed output, the SDK launcher
keeps the observed state and ID and signals unverified output with a nonzero
exit. This applies to JSON and terminal SSE. The direct PowerShell helper
reports the same problem as a protocol error with the observed Response ID.
Verify the existing response before considering another request.
When writing an event file, `observedEventsSaved=false` marks a partial
local record. Resume from a sequence known to have been consumed or saved.

## Decisions and structured outputs

```powershell
$request = @{
  model = $decisionsModel
  input = $evidence
  questions = @(@{
    name = 'needs_review'
    type = 'predicate'
    instructions = 'Does the evidence include a mismatch requiring manual review?'
  })
}
$decision = & $api decisions.create -Request $request | ConvertFrom-Json -AsHashtable
```

Check the current supported model for Decisions. It answers predicates, fixed
choices, and ordered scores. Keep names unique if callers join on names. A
refusal can occur for one answer even when others are usable. Preserve
confidence/probability as estimates. Measure false negatives before using this
route to filter important findings. Score results must fall within the supplied
levels and agree with any supplied distribution within numeric tolerance.
Use Responses `text.format` with
`type=json_schema` when a workflow needs a generated report with typed fields.
Handle refusals, tool calls and incomplete results before schema validation.
[Decisions](https://developers.openai.com/api/docs/guides/decisions) · [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

## Streams, deferred work and recovery

```powershell
$request = @{ model = $model; input = $brief; stream = $true; store = $false }
& $api responses.create -Request $request -CheckpointPath $newReceipt -EventFile $newEvents
& $jobs $receiptDirectory
```

To recover a separate stored response by its known ID:

```powershell
& $api responses.retrieve -Id $responseId
# Optional for a supported Background response:
& $api responses.retrieve -Id $responseId -Request @{ stream = $true; starting_after = $consumedSequence }
```

Both retrieval examples use a separately stored response. SSE recovery
specifically requires a supported Background response. Create a
new event file for each attempt. Without `-EventFile` streaming returns JSONL
records on stdout. With it, stdout carries the receipt and final summary and
the event file carries decoded events, including suppressed frames as
`stream-observation` records for diagnosis. Apply only normal `event` records.
A validated terminal event describes the remote outcome. A sequence gap,
conflict or local write failure can yield a nonzero exit even with a known
remote completion. EOF or a local timeout can leave the remote outcome
unknown. Clean up a test or unwanted
stored resource deliberately with `responses.cancel` or `responses.delete`
as supported, after reading its remote state. The local deadline bounds I/O
and polling. A stalled local sink can delay process exit.

Keep each attempt in a new checkpoint file. `-ProjectHint` is a local label
only. The offline inventory reads complete JSONL receipt records and can show
both older PowerShell receipts and newer SDK receipts. It does not dispatch
or verify remotely. Treat unverified resource hints as lookup keys. The
highest observed sequence is diagnostic. For supported recovery use the last
sequence actually consumed, or `streamIntegrity.lastDurableContiguousSequence`
when relying on a synchronized event file. A durable cursor requires a
matching sequence from `starting_after` or an observed initial creation
event. `origin=unconfirmed` can still accompany a known remote completion.
When continuity is uncertain,
retrieve the saved response by ID. Unknown writes require reconciliation
in the same project. Keep prompt/session metadata and original task identity
in the task's own files if needed. [SSE](https://developers.openai.com/api/docs/guides/streaming-responses) · [Background](https://developers.openai.com/api/docs/guides/background)

Record provider usage and limit headers with the operation and observation
time. Organization headers and a local project hint have different origins.
Treat capacity, actual usage, charges and promo credit balance as separate
facts. Treat remote text and tool outputs as evidence. Check significant
claims against source artifacts and use current authorization before any
consequential follow-up.

For delayed work use [the deferred work guide](deferred-work.md).
Create a Batch at most once per attempt. Use the existing Batch Submit helper,
or use `files.create` with `purpose=batch` and then `batches.create` with its
file ID, current completion window and correct endpoint. Save both IDs.

```powershell
& $api batches.wait -Id $batchId -OutputDirectory $existingResultsDir -CheckpointPath $waitReceipt -TimeoutSeconds 300
& $api files.content -Id $missingFileId -OutputFile $newDownloadPath
```

`batches.wait` only polls and downloads. Existing destinations fail before
polling. When collecting a completed Batch, Legatus checks the saved JSONL,
unique IDs across its files and the counts reported by the server. A failed
local verification preserves downloaded files and reports `review-required`
with `artifactVerification`. The remote status remains in `batch.status`.
Without an output directory the action reports server state only. Use
[`batch.plan`](workbench.md#recover-a-partly-completed-batch) with the original
input to reconcile exact IDs. To verify IDs during collection, pass
`-VerifyInputIds` (`verifyInputIds: true` in Node). This reads the exact original
File ID from the Batch, uses a disposable local copy and reports
`input-ids-verified` only if the completed files match its IDs and counts.
If the original is unavailable, the saved results remain available for review.
The status lookup may retry a confirmed throttle or a transient HTTP
failure within the existing deadline. Quota errors and writes have separate
recovery. For partial results use the known file ID to download the missing
file into a new destination. A local nonzero result can include usable partial
output. Compare all expected `custom_id` values against results and errors.
Use the explicit returned status and request counts to determine completeness.
For regular runs with a supported reachable receiver, verified and deduplicated
webhooks can signal a lookup by ID. For a local occasional job, a saved ID and
later check need no service. [Batch](https://developers.openai.com/api/docs/guides/batch) · [Webhooks](https://developers.openai.com/api/docs/guides/webhooks)

## On-demand Responses controls

**Prompt-cache diagnostics.** On the next real Responses request, set
`prompt_cache_options.comparison_response_id` to a recent comparable response
ID from the same organization. Merge this field with any existing cache
options. The launcher reports the baseline, provider diagnostic type and
reason, and actual cached input tokens under `receipt.promptCache`. A missing
diagnostic or a different baseline remains visible. The comparison neither
continues the earlier response nor changes cache configuration. Compare
diagnosis with actual usage, especially when estimated missed tokens differ.
[Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)

**Change a running answer.** Start the response through `responses.steer`.
Use a canonical GPT-6 model ID. The launcher checks the documented model
family before opening the socket, including when called in duplex mode.
The selected project still needs access to that model.
The PowerShell launcher takes one planned update and sends it after the
original response ID arrives.

```powershell
& $api responses.steer -Request @{
    response = @{ model = $model; input = $task }
    steer_input = $update
} -CheckpointPath $newCheckpoint
```

For an update decided after launch, start the Node entry as a duplex process
with `node scripts/openai-agents.mjs <runtime-directory> --interactive-steer`.
Send a newline-terminated JSON invocation with `action: "responses.steer"`
and `request: {response: {...}}`. Keep stdin open. Once the output reports
`response.created`, send one JSON line `{"steer_input":"adjust the task"}`.
The runtime directory is the qualified SDK directory, or omit the positional
directory for an installed checkout-local SDK. Use the process environment key.

The result names the original response, acknowledged steering ID and observed
continuation. `continuation-completed` requires the continuation's own terminal
event. If the original completes before the update is sent, its completed result
is returned with `completed-without-steer` and a nonzero exit for the missed update.
A correlated provider rejection carries the original steering input and a
structured error. It can omit the steering ID before acceptance. A generic
WebSocket error after dispatch leaves the outcome unconfirmed, even when the
continuation ID is already known. The launcher checks response and parent IDs
against the requested context and verifies the stream ID on correlated events.
The checkpoint keeps the known IDs and observed terminal states.
The launcher checks the user message content, and rejects bound conversations
or automatic compaction before opening a connection. If it needs client tool
results or approval, the launcher validates the completed original response,
pending reason and correspondence to the original tool calls or approvals.
Unverified input is labeled `unverified_pending_call`. Matched input returns the pending event
and closes its connection. The pending event describes work for the client.
Only independently obtained tool results or approval decisions can satisfy it.
A rejection, generic error or premature pending event can still include the original response
if its terminal event has already reached the local receive queue. Reconcile any observed IDs and results
before starting more work. Steering awaits the same WebSocket and cannot attach
to a separate HTTP job or restore a disconnected queued update. Output already
delivered and actions already started remain in effect. The default is
`store: false`. For authorized later retrieval set `store: true` explicitly.
[Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)

**Server-hosted Multi-agent.** For independent workstreams, opt in through
`responses.multiagent.create`. Use a currently supported model and optionally
set `multi_agent.max_concurrent_subagents` to a positive integer. The cap
controls simultaneous children, and the server can create further children
over the run. The root output and agent events are preserved. Evaluate
quality and usage against the existing local queue when the choice matters.
Use `responses.multiagent.retrieve` with the returned ID for stored results.
For live events use `stream: true` and optional `-EventFile`. The workbench can
suggest the matching retrieval route from a checkpoint. Both actions
select the documented beta automatically.
[Responses Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)

## Files, tools and media

- Use inline file/image input for one-off analysis. Use `files.create` plus a file
  ID for reusable inputs. Use `files.content` for byte-preserving downloads.
  Availability depends on the resource and file purpose. Our API probe accepted
  the `user_data` upload and returned its metadata, then denied downloading
  that file's contents. Keep the original local file.
  Responses receipts can flag text-only documents, PDF visual input,
  spreadsheet prefix augmentation and unknown formats such as opaque file IDs.
  These hints describe the submitted format and documented processing.
  Check the representation against the required pages, charts or rows.
  For many repeated search queries, the catalogue includes vector store
  create, attach, search and cleanup. Verify indexing is ready. Ask for
  `include = @('file_search_call.results')` when the audit needs retrieved
  passages. Keep a way to consult the original, especially for completeness.
  [File inputs](https://developers.openai.com/api/docs/guides/pdf-files) · [File Search](https://developers.openai.com/api/docs/guides/tools-file-search)
- Treat the SDK download path as ready after the successful publication
  receipt. It includes the transferred SHA-256 and publication evidence.
  On file systems requiring an exclusive-copy fallback, the destination can
  be visible while provisional. After interruption reconcile the destination
  before retrying. A result with `atomic=false` identifies this fallback.
- Use `web_search` with appropriate search scope and retain source annotations.
  Preserve usage, citations, tool outputs and incomplete state before projecting
  a short result. Hosted shell and Code Interpreter run in their own environments.
  Uploaded API skills are separate resources. The catalogue supports uploading
  a single ZIP or file, and version management. A custom function call is a
  request to the caller. Resolve it against the tools and permissions for the
  current task and associate the result with its call ID.
  [Tools](https://developers.openai.com/api/docs/guides/tools) · [API skills](https://developers.openai.com/api/docs/guides/tools-skills)
- `audio.transcriptions.create` takes `-InputFile` and returns a JSON
  transcript. JSON variants carrying timing verify intervals against the
  reported audio duration with up to 1 ms for rounding. Reported segment IDs
  must be unique. Diarized segments require IDs and speaker labels.
  Overlapping speakers and valid empty transcripts remain supported.
  `audio.speech.create` writes audio to `-OutputFile` after media
  and format checks. WAV uses RIFF/RF64 lengths, chunk extents and sample
  alignment. PCM uses byte alignment because it has no container. FLAC and MP3
  check the initial structure identified in the receipt. AAC checks an ADTS
  frame or the AAC sample map to local media payloads in a self-contained MP4,
  including a positive media timescale, agreement between a known classic
  media duration and `stts`, and explicit and inherited fragment
  durations. Where present, fragment decode timestamps are checked as well. Ogg
  Opus checks page sequence, CRC, end of stream and granule positions against
  packet durations, accounting for initial offset and end trimming. When
  verified audio pages precede a damaged or missing ending, the original
  bytes are kept with a nonzero exit and explicit `media.completion`. These
  checks establish container structure. Full decode and playback are separate.
  Codec side data has a 16 MiB local budget. MP4 sample tables are bounded
  to one million explicit entries per table.
  An explicit `stream_format=sse` preserves the original bytes when the stream
  contains framed data events. The receipt counts those frames and reports
  a completion marker, observed error or unknown completion separately. Exit
  zero for this archive indicates successful capture of framed events, so
  inspect the completion state when you need completed speech.
  Use a filename appropriate to the requested representation.
  `images.generate` and `images.edit` default to the raw API result. For
  inline image results the launcher checks base64 encoding or the URL shape.
  When a supported format is requested or reported, it also checks inline
  bytes against that format. With a URL the bytes remain unverified.
  `receipt.imageOutput` reports count completion and `formatVerification`
  separately. A count or format discrepancy preserves inline results and
  returns nonzero. Reconcile the available results before another generation.
  For GPT-Image 2.6, choose `gpt-image-2.6-sunburst` or `gpt-image-2.6-flare`.
  Supported accounts can request SVG and GIF. GIF accepts optional
  `frame_count` (2–16) and `frame_duration_ms`. For one output set an explicit
  `output_format` and pass a new `-OutputFile` with the matching extension.
  The launcher checks SVG for well-formed UTF-8 XML with an SVG root. For raster
  formats it checks container structure and complete boundaries before publishing.
  PNG also checks its compressed scanlines within a 16 MiB decompressed budget.
  The receipt records `pngDataValidation` as `filtered-scanlines` or
  `zlib-header-only` for larger images. These checks preserve the original
  bytes without rendering or fully decoding pixels.
  Within that budget indexed PNG also checks reconstructed palette indices
  across filtering and interlacing passes. The receipt reports `pngPaletteValidation`.
  Data after the compressed stream is tolerated within the final data-bearing
  IDAT chunk and counted as `pngTrailingIdatBytes` when scanlines are checked.
  A generated SVG can contain active content.
  For edits, pass a PNG/JPEG/WebP up to 50 MiB with `-InputFile` and optionally
  a transparent PNG up to 4 MiB of matching dimensions with `-MarkupFile`.
  The local launcher validates both files before upload. Use the native CLI
  for multiple reference images, a mask, another supported upload limit, or
  interactive preview.
  Consider a dedicated Realtime or GPT-Live client for live audio. Compare
  transcript timestamps and difficult names against source evidence.
  [Audio](https://developers.openai.com/api/docs/guides/audio) · [Images](https://developers.openai.com/api/docs/guides/image-generation)

Embedding results preserve the returned representation after checking order,
encoding, consistent dimensions and any explicit dimension request. The
receipt also requires the provider model and consistent token usage. Vector
search verifies scores and text excerpts. With the pinned route a search
reporting more hits retains the provider page and marks continuation unavailable.

`moderations.create` checks the result count, category maps, score range,
modalities and agreement of `flagged` with category flags. If the result
is contradictory, `receipt.moderationVerification` identifies the failed
check. Inspect the retained response and nonzero exit before downstream use.

## More involved integrations

`conversations.items.create` verifies the acknowledgement against the
submitted types, stable identifiers, exact JSON argument values and comparable
inline attachment bytes. It accepts serialization changes with the same
values. An unverifiable conversion between an inline attachment and a reference
is returned with partial correlation and a nonzero exit. A mismatch leaves the write
unconfirmed. Re-read the conversation before retrying. A returned function
output without a `call_id` remains available with partial verification.

Use Conversations or compaction for sustained context. Previous response IDs
save transmission, and prior input can still be billable. Consider WebSocket,
approved tool adapters, or Responses Multi-agent when the work needs their
specific latency or orchestration features. Use [Agents API](agents-api.md) for
managed sessions or the [Agents SDK](https://developers.openai.com/api/docs/guides/agents-sdk)
for a custom runtime. The [bundled local MCP](workbench.md#read-only-mcp)
offers action discovery, checkpoint inventory and saved-result reads.
A Secure MCP Tunnel serves a different purpose:
giving remote services access to selected private tools. Provision either on
demand under the host's normal permissions. Keep admin scopes separate from
inference. Verify supported capabilities and effective authentication before
assuming a mode is available or draws from a grant.

For recurring measurement, pair inexpensive deterministic checks with a
versioned dataset and measured Responses/Decisions calls. Promptfoo can run
comparative evaluations, and Plugin Eval can test which workflows Codex uses.
Introduce either at the point where it provides reproducible value. Check the
current deprecation schedule for legacy Evals, prompts and Assistants routes.
[Promptfoo migration](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo)
