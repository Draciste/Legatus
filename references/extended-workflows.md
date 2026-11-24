# Extended OpenAI API workflows

Use the existing saved-key launcher unless the route needs a separate identity.
Discover exact operation names with `catalog` and use `doctor` to check the
local runtime. A local contract check does not establish account access.

```powershell
$scripts = (Resolve-Path ./scripts).Path
$api = Join-Path $scripts 'openai-agents.ps1'
$jobs = Join-Path $scripts 'openai-jobs.ps1'
```

## GPT-6.2 prompt prefixes

For repeated audits, keep stable developer guidance in the first item of
`input`. Put the case, turn-specific prompt and changing evidence after that
prefix. GPT-6.2 appends top-level `instructions` after `input`, so use that
field for the current turn. Keep the ordering, tool schemas and output schema
stable when practical. For existing response chains, consider when a changed
prefix would affect reasoning reuse. Measure actual cached input and total
cost; a long cache write is only useful when repeated use pays for it.

```powershell
$request = @{ model = $model; input = $caseText; instructions = $turnGuidance }
& $api responses.inputtokens -Request $request -StableInstructionsPath $auditGuidance
& $api responses.create -Request $request -StableInstructionsPath $auditGuidance
```

The launcher prepends one developer message using the selected UTF-8 text file
and preserves top-level instructions for both paths. Include only the fields
supported by each endpoint when using additional request parameters. Pass either plain string input or an
ordered item array. Own the prefix only once. Existing developer messages
are left intact. Use this option on a fresh or full-input request. On a
stored continuation, rely on the already-established prefix or supply the
full context deliberately. Verify support for the model in use rather than extrapolating
GPT-6.2 placement to older models.
[GPT-6.2 migration](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart) ·
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## Responses containers and Agent artifacts

Responses Hosted Shell and Code Interpreter files live in API containers.
Use the returned container and file IDs from output items, file citations,
or an explicit container listing. A tool citation is a pointer. Download
the bytes and verify the actual file. Containers can expire, so retrieve
wanted files while the container is active.

```powershell
& $api containers.files.list -Id $containerId
& $api containers.files.content.retrieve -Id $fileId -Request @{container_id=$containerId} -OutputFile $newPath
& $api containers.files.create -Id $containerId -InputFile $localFile
& $api containers.files.create -Id $containerId -Request @{file_id=$uploadedFileId}
```

The catalogue also has create, list, inspect and cleanup operations.
Reuse a supported Responses container explicitly where it fits. Pass
`container_reference` according to the chosen tool's contract. Delete
only the resource you own after retrieving the needed artifacts.
Responses Hosted Shell writes user-downloadable artifacts under `/mnt/data`.
Agents API hosted sandboxes use their own `sessions.artifacts.*` routes and
`/workspace/outputs`. Ask for the hosted Artifact SDK and supplied document
skills when a task needs a workbook, slides or a Word document. Verify
the actual format and contents before accepting it.
[Containers](https://developers.openai.com/api/reference/resources/containers) ·
[Hosted Shell](https://developers.openai.com/api/docs/guides/tools-shell) ·
[Agents files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files)

## Provenance

```powershell
& $api provenance.create -InputFile $original -InputMediaType 'application/pdf' -IncludeApiMessage
```

For common file extensions the launcher supplies the MIME type. An explicit
type is useful when the extension does not describe the format. Send the
authorized original, record which signal and outcome the API returned, and
keep its error and result separate from an absent provenance signal.
`not_detected` means supported signals were not found. It does not certify
human authorship or rule out generation by another service. A signed
manifest can record processing as well as generation. Check current
file-size, audio-duration, and retention rules before use.
The receipt separates signal validation from the reported outcome. A missing
applicable signal, unsupported result type or inconsistent result is returned
for inspection with nonzero status.
[Content Provenance](https://developers.openai.com/api/docs/guides/content-provenance)

## Multipart uploads

Use ordinary Files for routine small uploads. Use `uploads.transfer` when
the target purpose and file size warrant multipart. Supply a new checkpoint
path for substantial uploads. One invocation creates an Upload, sends ordered
parts serially from the opened file, computes the local SHA-256 and
completes to a File. It records confirmed IDs and byte offsets. The SHA-256
in the receipt covers the bytes submitted by the local client. Leave the
source unchanged until handoff. The destination endpoint may have a smaller
limit than the multipart API.

Direct and multipart upload require a reported filename and purpose. Completion
checks these fields and byte count across the Upload, its File and the local
request where known. The Upload envelope can omit the optional `object` label.
An unknown nested File size is allowed. If the metadata conflict, use
`observedFileId` in the error receipt, PowerShell inventory or MCP `list_jobs`
as a recovery lead. A single observed ID enables a follow-up metadata read.
Conflicting IDs leave no specific read recommendation. `fileId` is set after
the consistency checks pass.

**Known API bug.** Complete returns HTTP 500 `complete_upload_failed` with
a matching MD5 in live tests. Keep `verify_md5` off for `uploads.transfer`
and omit `md5` from direct `uploads.complete` requests until a live retest
confirms the fix. We reported this as
[OpenAI OpenAPI #597](https://github.com/openai/openai-openapi/issues/597).

```powershell
& $api uploads.transfer -InputFile $file -Request @{purpose='assistants';mime_type=$mime} -CheckpointPath $newReceipt
& $jobs $receiptDirectory
```

Choose the purpose for the target workflow. The sample uses `assistants`
because the Uploads API lists it. The Files endpoint has a broader
documented purpose list. `user_data` completed in a prior live multipart test,
but does not appear in the published Uploads purpose list.

Basic operations `uploads.create`, `uploads.parts.create`, `uploads.complete`
and `uploads.cancel` remain available. If a transfer stops, check the saved
Upload and confirmed ordered part IDs. Use explicit part files for remaining
ranges only when the completed bytes are known. After ambiguous completion,
reconcile a matching File or request evidence before resubmitting. Creating
another Upload is a new attempt. The API does not provide a part list or
an Upload retrieve operation in this API version. Cancel only your own
known pending Upload and apply normal cleanup to completed Files separately.
[Uploads API](https://developers.openai.com/api/reference/resources/uploads)

## GPT-Live and recording

`live.audio` runs a finite server-side voice session with a PCM16LE mono
file at 16 or 24 kHz and captures raw reply PCM, transcripts and final usage.
It paces the file, allows a bounded response interval and requires the
matching `session.closed` event. The result distinguishes confirmed
session closure, input completion and output completion. An early
close still returns its available text and usage with a partial outcome.
Set `retain_partial=$true` to keep the available, sample-aligned PCM at the
chosen destination after an early close, disconnect or interruption. The
result can contain partial transcripts and audio even when the launcher
returns nonzero. `audioReceived` tracks received media and `outputPublished`
tracks local file publication. A silent normal close still has
`outputComplete=false`. `applicationComplete` stays unknown because these
observations do not establish that the requested utterance was delivered in
full. `formatSource` identifies a reported format or a request-based fallback
when the service omits the format. An explicitly unsupported format is rejected.
If the terminal event confirms closure but reports negative usage,
`liveUsageVerification=invalid` records the discrepancy separately. With
`retain_partial` enabled, the verified sample-aligned bytes remain available.
The launcher buffers up to 16 MiB of reply PCM for a single staged write.
It stops accepting events and closes the socket on transport or processing
errors and on cancellation.
It also stops on more than 32,768 incoming events or 64 Mi UTF-16 code units
of incoming event text per session. A limit failure has a distinct error code.
With `retain_partial`, only valid, sample-aligned audio accepted before the
interruption can be published.

```powershell
$live = @{ model=$liveModel; audio=@{format=@{type='audio/pcm';rate=24000}};
    instructions='Answer briefly and in the caller language.' }
& $api live.audio -Request @{session=$live;listen_seconds=5} -InputFile $rawPcm -OutputFile $newReplyPcm -CheckpointPath $newReceipt
```

For interactive microphone and speaker use the official WebRTC client flow
and `live.create` for a caller-owned SDP offer. Read the answer from
`data.transport.sdp` and set it as remote description on that same browser
peer. Session negotiation is not a media round trip. Close from that
session's data channel with `session.close` and await `session.closed`.
Explicit opt-in session storage enables supported recording download by ID
via `live.sessions.downloadrecording`. Select `gpt-live-1.1` explicitly for improved
pronunciation, multilingual transcription or accent consistency. Set language
and dialect preferences in the session instructions. For WebRTC standby, pass
`session.wake_policy = @{ type = 'speech' }` and optionally
`session.idle_timeout_s = 20` (5–60) with the SDP offer. The caller owns the active
microphone track, WebRTC data channel and handling of pause/resume events. The
file-based `live.audio` route uses the requested model over WebSocket with no
standby. Check `receipt.requestedModel` and the reported model when available.
[Live session management](https://developers.openai.com/api/docs/guides/live-conversations)
Account access, available model,
voice rates and delegation costs come from the platform.
[GPT-Live](https://developers.openai.com/api/docs/guides/live) ·
[WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) ·
[WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets)

## Workspace Agents

Use a published agent's `agtch_...` channel and a token scoped to Workspace
Agents. The launcher sends this token only to `api.chatgpt.com`. Supply it
as a securely entered PowerShell variable (`-WorkspaceToken`), via the
Windows generic credential `OpenAI Workspace Agents pro Codex`, or through
the calling automation's ephemeral `OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN`.
The Platform key and promo billing route are separate.

```powershell
$body = @{input=$task;conversation_key=$conversationKey}
& $api workspace.trigger -Id $triggerId -Request $body -IdempotencyKey $stableSubmissionKey -CheckpointPath $newReceipt
& $api workspace.status -Id $triggerId -Request @{run_id=$runId}
```

HTTP 202 acknowledges submission. Status returns progress or terminal state
for the confirmed run ID. The API returns a ChatGPT conversation link for
reading the actual answer under the applicable workspace permissions.
A new or unrecognized state is preserved as `observedResourceStatus` with
an unknown classification and a nonzero exit. Inspect it before deciding
whether the run is pending or terminal.
Checkpoint setup failure reports that dispatch was unattempted. A conflict
or early-retry response can leave the dispatch outcome uncertain. If an
accepted response identifies a run but its conversation link is unusable,
the error receipt still carries the run ID for a status lookup.
Use the same idempotency key only for the identical turn if an uncertain
submission needs reconciliation. Check the current workspace feature and
access requirements before any trigger.
[Workspace Agents triggers](https://learn.chatgpt.com/workspace-agents/trigger-runs) ·
[Workspace access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)
