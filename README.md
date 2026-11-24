# Legatus

Legatus submits work to the OpenAI API, records its outcome, and helps local
agents recover results. It supports Linux, macOS and Windows. The [skill](SKILL.md)
describes how an agent should select and use these routes.

## Install from source

Node.js **22+** and npm are required. A standard Legatus installation in Codex
also requires both of the following companion tools.

1. Install the [official OpenAI CLI](https://developers.openai.com/api/docs/libraries/openai-cli).
   It provides a separate API route and helps isolate failures in the primary
   transport. On Linux and macOS, make `openai` available on `PATH`. For the
   Windows PowerShell helper, place the official executable at
   `%LOCALAPPDATA%\Programs\OpenAI-CLI\bin\openai.exe`. Check `openai --version`
   or run the Windows executable by its full path.
2. In Codex, install the [OpenAI Developers plugin](https://developers.openai.com/learn/developers-codex-plugin)
   to get its **OpenAI Platform** app. The app provides account information
   that helps plan and diagnose API work, including remaining API credits,
   organization context and usage. Connecting the app is the user's choice.
   See [Platform billing and diagnostics](references/platform-billing.md).

The core HTTP and SDK paths use their own project credential and also work in
headless environments or agent hosts without the Platform app.

Install the locked SDK and check the local interface from the checkout root.

```text
npm ci --prefix scripts/agents-sdk --ignore-scripts --omit=optional
node scripts/openai-agents.mjs doctor
node scripts/openai-agents.mjs qualify
```

`qualify` uses a synthetic transport. No API key or billable work is needed.
For Codex, place this skill folder under `~/.agents/skills/legatus`
or `.agents/skills/legatus` inside a project. Invoke `$legatus`. Other agents
can use the same scripts and instructions where their client supports local
tools.

## Call and recover

The Node entry reads a single UTF-8 JSON invocation from stdin and emits
JSON Lines. Provision an OpenAI project API key through `OPENAI_API_KEY` in
the process environment before a live call. Use the appropriate project
for model, feature, quota and billing access. Workspace Agents use a separate
credential. See [API operations](references/api-workflows.md) for the local
launcher and [recovery guidance](references/agents-api.md) for receipts.

```sh
printf '%s\n' '{"action":"models.list"}' | node scripts/openai-agents.mjs
```

In PowerShell use `'{"action":"models.list"}' | node scripts/openai-agents.mjs`.

Use `node scripts/openai-agents.mjs catalog` to check the fields of an action.
The outer invocation has an `action`, optional `id`, and a `request`
object for API parameters. Omitting `request` means `{}`. Set
`timeoutSeconds` to an integer from 1 to 86400 to select the local deadline.
Default deadlines depend on the action. Local fields such as `inputFile`,
`outputFile`, `checkpointPath` and `eventFile` belong to the outer invocation.
Prefer absolute paths. The PowerShell launcher resolves relative paths against
its current filesystem directory.
Misspelled outer fields fail before dispatch. API parameters stay inside
`request`. Supply one body. The adapter field `rawRequest` carries an already
serialized JSON body and may coexist only with an absent, null or empty
`request`. For example, a Workspace idempotency key belongs in the outer
invocation and uses `-IdempotencyKey` in PowerShell.
Only a streamed `responses.retrieve` accepts `starting_after` as a continuation
cursor. A new Responses request establishes its own stream history.

The PowerShell launchers, buffered API helper, queue and checkpoint inventory
are also available. Use PowerShell 7.4+ on macOS/Linux or 7.2+ on Windows.
These use the same Node API implementation for SDK calls. On macOS/Linux,
the launcher reads the scoped environment key. On Windows, the existing
Credential Manager default is kept and `-CredentialSource Environment` on the
SDK launcher selects the environment explicitly.

```text
pwsh -NoProfile -File scripts/Install-OpenAiRuntime.ps1
pwsh -NoProfile -File scripts/openai-agents.ps1 doctor
```

The versioned installer keeps qualified SDKs in user state. The direct Node
entry uses the SDK installed in the checkout. See [runtime maintenance](references/runtime-maintenance.md)
for updates, offline installation and separate state roots, and
[delegation](references/delegation.md) for queue and recovery.

## Optional tools

- [Stdio MCP](references/workbench.md#optional-read-only-mcp) provides read-only
  action discovery, checkpoint inventory and saved-result access. Use the
  command-line launchers for submission. Checkpoint inventory uses `pwsh`.
- The native Codex Security CLI is optional. Windows also has a local WSL
  adapter. Core API workflows and local job recovery work independently.

## Test

For incidental live API checks the AI initiates for its own workflow, consider
[daily complimentary-token models](references/platform-billing.md#choosing-a-model-for-live-api-tests)
when they can adequately perform the check.

```text
node --test "scripts/tests/*.test.mjs"
pwsh -NoProfile -File scripts/tests/delegation.test.ps1
pwsh -NoProfile -File scripts/tests/buffered-portability.test.ps1
```

Tests use synthetic requests and local fixtures. The [CI matrix](.github/workflows/portability.yml)
exercises a clean checkout with public dependencies and no API credentials.
