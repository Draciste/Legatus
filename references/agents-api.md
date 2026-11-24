# Managed Agents API

Choose this route for remote multi-step work with durable session state. Use
Responses for workflows the caller orchestrates. Check current access,
pricing, data controls, and limits for the selected project and environment.
Hosted sandboxes are billed separately. Apply the skill's model selection,
token budgets, and load balancing.
Inspect observed usage by turn, including cached input and agent tooling.
Managed instructions and tool steps can dominate the cost of a short prompt.
Session state is retained by the service according to the current Agents API
data controls. Check residency and retention for the task.

## Start and inspect

~~~powershell
$agents = (Resolve-Path ./scripts/openai-agents.ps1).Path
& $agents doctor
& $agents catalog | ConvertFrom-Json -AsHashtable
$body = @{
    agent = @{ model = $model; reasoning = @{ effort = $effort } }
    environment = @{ type = 'none' }
    input = $task
    metadata = @{ job_ref = $jobRef }
}
$started = & $agents sessions.create -Request $body -CheckpointPath $newCheckpoint |
    ConvertFrom-Json -AsHashtable
$sid = $started.data.id
& $agents sessions.retrieve -Id $sid
& $agents sessions.turns.list -Id $sid -Request @{ limit = 10 }
& $agents sessions.items.list -Id $sid -Request @{ limit = 50; order = 'asc' }
~~~

Choose one input. Use `-Request` for a PowerShell dictionary, `-Json` for a
JSON object, or `-RequestPath` for a local UTF-8 JSON file. Review the catalogue
for required path parameters. The request and stable instructions have separate
16 MiB and 1 MiB input limits. The launcher also checks the complete 36 MiB
UTF-8 invocation envelope before starting the SDK. JSON escaping can make
an individual input within its limit exceed the envelope budget. The default response includes API data and a
receipt with IDs, HTTP status, and available rate-limit headers. List operations
return one page. Supply the documented next cursor when needed. When the API
flags more results but supplies no cursor, `receipt.pagination.state` is
`cursor-unavailable`. The observed page remains available. The launcher
uses the selected project credential with the official API host. A full run needs
agents read/write and responses write.

For an OpenAI-hosted workspace, choose `environment.type = 'openai_hosted'`
and the size, network access, and inputs for the task. Use `files.create`
with `-InputFile` for an explicit upload. Supply the documented purpose,
such as `@{ purpose = 'user_data' }` in `-Request`. Attach inline inputs
or Files API IDs through `environment.files`. Ask the agent to publish
wanted outputs under `/workspace/outputs`. Match artifacts to the completed
turn and expected path before downloading.

~~~powershell
& $agents sessions.artifacts.list -Id $sid -Request @{ limit = 50 }
& $agents sessions.artifacts.content -Id $artifactId -Request @{ session_id = $sid } -OutputFile $newLocalPath
~~~

## Optional session spend limits

For an explicitly requested session budget, set `spend_control = @{ limit = 250 }`
on `sessions.create` or `sessions.update` to request USD 2.50. Use positive whole
USD cents. Omit the field to keep the existing update behavior. A null control
or null limit explicitly removes the limit. Previously recorded spend remains.

Inspect `receipt.sessionBudget` after create, update, or retrieve. It reports
the requested and acknowledged limit, plus the provider's best-effort
consumption in whole cents when available. Unconfirmed or mismatched limits
are visible even if the API returned a session ID. A
`agent.session.budget_reached` event means the session paused. Retrieve the
original session and decide whether to raise the budget or stop. Estimates
remain advisory. Limits do not replace the charges recorded by the provider.
[Agents API sessions](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/)

## Optional Daybreak

For an approved defensive review, use `sessions.create` with the root
`access_programs.cyber` field. Verify the selected key's named non-default API
project, its access setting and the model's required approval. The
[Daybreak matrix](https://developers.openai.com/api/docs/guides/daybreak)
is authoritative for supported combinations. `doctor` and `catalog` describe
local request support. `ProjectHint` is a caller-supplied label.

The simplest audit of a supplied diff uses an inline agent, no execution
environment, and no external tools. Select the eligible model and program
before constructing the request.

~~~powershell
$body = @{
    agent = @{ model = $approvedModel; tools = @() }
    environment = @{ type = 'none' }
    access_programs = @{ cyber = $approvedProgram }
    input = $selectedReviewInput
    stream = $true
}
& $agents sessions.create -Request $body -CheckpointPath $newCheckpoint
~~~

The launcher generates an opaque `metadata.job_ref` when absent and records it
as `jobRef`. The checkpoint's `inputSha256` covers the UTF-8 JSON of the submitted
`input` field. Treat request correlation, HTTP acceptance, provider-reported
configuration and exact root-turn completion as separate observations. For
`configurationState=unconfirmed` the provider result has not established the
effective program. A reported mismatch leaves the original run identifiable.

Recover a known session with `sessions.retrieve` and its recorded root turn
with `sessions.turns.retrieve -Id $turnId -Request @{ session_id = $sid }`.
Use `sessions.turns.items.list` to read saved items for that turn. If no session
ID was recorded, match `metadata.job_ref` with `sessions.list` in the original
project. Ambiguous results need reconciliation. An `idle` session alone does
not establish the outcome of its preceding turn.

The receipt preserves distinct configuration and access errors, quota,
permissions and inconclusive transport. A provider cyber-policy or structured
refusal is retained as the original outcome. Choose an eligible Daybreak model
and program before sending authorized work.
[Error codes](https://developers.openai.com/api/docs/guides/daybreak#handle-errors)

For a single analysis without a managed session, the SDK path
`responses.create` accepts the same explicit field on a standalone request.
For selection in Agents, create a fresh session. Provider tracing and managed
session retention apply. [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration#use-daybreak-in-a-session) ·
[Tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing)

## Watch, continue and recover

Set `stream = $true` in a create request for live events. Use
`sessions.events.stream -Id $sid` to attach to a known session. Output is
JSONL with receipt, event, and result or error records. Enable
`-StopOnTurn` to wait for an identified main turn. Add `-TurnId` to
select a specific turn, including a child. A passive watcher reports
`lastTerminalTurn` separately from whether watching reached an identified
end condition. Child and unattributed events remain available. A local
timeout or closed stream can leave remote work running. Check a terminal
turn event or retrieve the turn and its saved items. HTTP 202 from
The catalog gives `events` as a required array for `sessions.events.create`.
The idempotency key is a local option. The service acknowledges input
acceptance with an empty HTTP 202 response. Check `receipt.eventAcceptance`
for the validated acknowledgement. An unexpected status or body leaves the
effect unconfirmed. Inspect the existing session before replaying the event.
Explicit stream or environment failure is reported separately from ordinary
watcher EOF. Retrieve the session's current `required_actions` if it
needs a function result, an approval response, or an environment connection.
When an explicitly requested event file fails to save or close, the launcher
reports `observedEventsSaved=false` and exits nonzero. A confirmed turn and
its identity stay in the result for same-session recovery.

To continue or steer, send a message with an idempotency key for that logical
submission. Start a stream beforehand if early events matter.

~~~powershell
$message = @{
    events = @(@{
        type = 'agent.session.input.message'
        input = @(@{
            role = 'user'
            content = @(@{ type = 'input_text'; text = $followUp })
        })
    })
}
& $agents sessions.events.create -Id $sid -Request $message -IdempotencyKey $submissionKey -CheckpointPath $newMessageCheckpoint
~~~

Store the session ID and use a new checkpoint path per attempt when recovery
matters. The local JSONL checkpoint flushes dispatch and identity evidence.
Keep the message and its original submission key together. After an uncertain
result, inspect session state, turns, items, and pending actions in the same
project. For a create with no ID, look for the unique job marker in the project
session list. Replay identical input only after reconciliation, using the same
session and original submission key. The SDK's automatic retries are disabled.

Send an `agent.session.input.cancel` event to stop the current turn when
appropriate, then verify the outcome. Save needed outputs before explicitly
deleting the session and unneeded input files. Physical cleanup can continue
after the deletion acknowledgement.

## Additional operations

The catalogue covers saved agents, sessions, events, items, turns, subagents,
traces, artifacts, environments, environment files and templates, automations,
vaults and credentials, and Files API transfers. Select tools, schedules,
callbacks, and approval modes according to the task. Vaults and credentials
require additional project permissions.

`environments.files.list` returns one verified page for the specified
environment. The optional `path` scopes it to an absolute workspace
directory. Pass `receipt.pagination.nextPage` as `page` with the same
directory and ordering. A valid page without a usable continuation is
preserved and marked `cursor-stalled` or `cursor-unavailable`. Batch callers
should also track already seen cursors to detect longer cycles.
ID-cursor lists use `receipt.pagination.nextPage` as `after`. When the last
item has no usable ID and more items are reported, keep the existing page and
treat the continuation as unavailable.

For a self-hosted session, provision the selected isolated environment with
the official executor and a separate restricted environment key. Pass the
returned environment ID and URL to that executor. The local launcher handles
the application side of the Agents API.

- [Quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart)
- [Sessions and recovery](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage)
- [Files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files)
- [Self-hosted executor](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [TypeScript API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents)

## Runtime maintenance

The launcher uses Node.js and the pinned official SDK. The package manifests
live in `scripts/agents-sdk`. Examples use the checkout root. For Node without
PowerShell, use the [portable entry](../README.md#call-and-recover). Follow the
[runtime maintenance guide](runtime-maintenance.md) to install, qualify,
activate or roll back a candidate. Doctor checks the local contract. A
session list can verify actual project access.
