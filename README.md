# Legatus / Legát

Legatus submits work to the OpenAI API, records its outcome, and helps local
agents recover results. It supports Linux, macOS and Windows. The [skill](SKILL.md)
describes how an agent should select and use these routes.

**Legatus Capabilites:** Batch, Background jobs, Hosted terminal, Sandboxes, Managed agents, Streaming, Web and file search, Structured outputs, Image generation and editing, Live voice, Speech synthesis and transcription, Token and cost estimates, Checkpoints and recovery, Read-only MCP.

## Legatus OpenAI capabilities

Listed in the order most useful for everyday Legatus work. Model and feature
availability depends on the selected OpenAI project and credentials.

1. [Responses API](references/api-workflows.md) for general analysis,
   delegation, structured outputs, and tools such as web and file search.
   Legatus can stream, submit in the background, and resume supported work.
2. [Agents API and Workspace Agents](references/agents-api.md) for managed
   sessions, multi-step work, and retrieval of turns and artifacts.
   [Workspace Agents](references/extended-workflows.md#workspace-agents) can
   trigger configured workflows with their own credential.
3. [Batch API and deferred work](references/deferred-work.md) for independent
   requests that can wait, with job tracking and result recovery.
4. [Decisions API](references/api-workflows.md#decisions-and-structured-outputs)
   for classification, scoring, and routing from typed answers.
5. [OpenAI Daybreak](references/agents-api.md#optional-daybreak) for defensive
   analysis through Responses or Agents, with eligible models such as
   GPT‑6 Cyber when the API project has the required approval.
6. [Images API](references/api-workflows.md#files-tools-and-media) for
   generation and editing with GPT‑Image 2.6 Sunburst or Flare, and local
   checks on saved image files.
7. [Audio and GPT‑Live](references/extended-workflows.md#gpt-live-and-recording)
   for speech synthesis, transcription, and voice sessions with GPT‑Live 1.1,
   including capture of audio and available transcripts.
8. [OpenAI API resource operations](references/api-workflows.md#files-tools-and-media)
   for files and uploads, Conversations, vector stores, embeddings, moderation,
   API skills, and containers. Separate
   [Admin reads](references/platform-billing.md#optional-admin-usage-and-costs)
   cover recorded usage and costs with authorized admin credentials.

Run `node scripts/openai-agents.mjs catalog` for the exact supported actions
and their arguments.

## Included components

Every Legatus installation includes the [skill](SKILL.md) and action catalogue,
the [Node and PowerShell launchers](references/api-workflows.md), the local
[delegation and recovery tools](references/delegation.md), and the
[workbench](references/workbench.md). Result validation, runtime installation
and automated tests are part of the project.

Legatus ships its own [read-only stdio server](references/workbench.md#read-only-mcp)
for action discovery, checkpoint inventory and reading saved results. Register
it as `legatus-mcp` as part of standard Codex setup. Checkpoint and result
access use dedicated local directories.

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
   organization context and usage. If the app is unconnected, the agent
   should offer a one-time, strong recommendation to sign in and explain why.
   Sign-in is the user's choice. API calls still work, but the agent lacks
   direct visibility into key account data for planning credit use.
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
or `.agents/skills/legatus` inside a project, then
[register the bundled MCP](references/workbench.md#read-only-mcp) from that
installed copy. Invoke `$legatus`. Other agents can use the same scripts and
instructions where their client supports local tools.

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

- [Codex Security CLI](https://learn.chatgpt.com/docs/security/cli/reference)
  runs defensive repository reviews from a local checkout and returns
  findings and coverage for inspection. Legatus can call it through its
  native or Windows WSL route.
- [Plugin Eval](SKILL.md#optional-integrations) evaluates Codex skills and
  plugins, including whether Codex discovers and uses the intended workflows.
- [OpenAI tiktoken](SKILL.md#token-counts) counts tokens in local text offline
  when the matching encoding is cached. Legatus uses the API input-count
  operation to count complete request framing.
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

## Field examples

For AI agents learning Legatus, see [worked examples](references/field-examples.md)
of remote audits, credit evidence, long-running Astra work, rate limits and
checkpoint-based recovery.

## Responses API as a remote lab

Legatus can send work to OpenAI and collect the result later. When a task
needs a terminal or a place to create files, a supported tool can also give
the model a temporary execution environment. Choose the environment by what
the task needs to do.

- **Remote model work.** A Responses request can review a supplied diff,
  analyze data already in the prompt, or write a structured report. Use
  `background` for a supported long-running request, save the Response ID,
  and retrieve its status and result with the same project credential.
  Background mode governs delivery. A terminal comes from a separate tool. The DevAiAye audit on Astra Max used this route for static
  source review split into independent parts.
- **A temporary remote lab.** Hosted Shell and Code Interpreter can work in
  OpenAI-managed containers. Use Hosted Shell for terminal-based processing
  and Code Interpreter for Python analysis. Typical tasks include comparing
  structured files, running calculations, or producing a report that needs
  to be downloaded as a file. The VM comparison is useful for thinking
  about files, processes and isolation. OpenAI manages the container and its
  lifetime. Hosted Shell runs commands non-interactively and without `sudo`.
  Check the chosen
  tool's capabilities before assuming network access or a particular runtime.
- **A remote workspace across several turns.** A supported Agents API
  session can keep the work in one conversation and use a sandbox when
  execution needs continuity. Track which turn produced each result and
  collect its artifacts through the session's own interface. Session state
  and sandbox files have separate lifecycles.

For an artifact-producing task, tell the model what files to deliver. Record
the job ID and the returned container and file references, or the session and
artifact references. Download the actual bytes while the environment still
has them and verify the format, contents and expected scope. In one Legatus
audit, the final response pointed to a report in a Responses container.
Collecting the report required a separate download. This pattern keeps
execution, delivery and verification visible as separate steps.

[Background](https://developers.openai.com/api/docs/guides/background) ·
[Hosted Shell](https://developers.openai.com/api/docs/guides/tools-shell) ·
[Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter) ·
[Agents API](https://developers.openai.com/api/docs/guides/agents-api)

## License and contributions

Legatus is released under the [MIT License](LICENSE).

Even a small voluntary contribution is appreciated. AI tokens aren't cheap. 🤷🏻
[Buy me a coffee](https://buymeacoffee.com/draciste)

## Disclaimer

Legatus is offered on an **“as is”** basis under the [MIT License](LICENSE).
Anyone using it assumes the risks of their deployment. MIT permits commercial
use, forking and redistribution. Support is voluntary.

- **Liability.** The MIT License's warranty and liability provisions apply to
  Legatus, including its use to submit jobs, work with files and invoke
  connected tools.
- **Support and maintenance.** Responses to questions, bug and security
  fixes, maintenance and future releases are at the maintainer's discretion.
  Users should plan for those services to be unavailable.
- **Production use.** Before deploying Legatus, evaluate it in your own
  environment. You are responsible for validating the selected account and
  permissions, protecting credentials and data, retaining needed backups,
  testing workflows and observing your organization's rules and applicable law.
- **Independent project.** Legatus is developed independently of OpenAI and
  the other vendors whose services or tools it works with. Product and company
  names identify compatibility and remain the property of their respective
  owners. Contact the Legatus maintainer for project-specific issues.
- **Published test results.** Tests and compatibility notes apply to the
  versions and conditions they document. Evaluate suitability for your own
  deployment before relying on those results.
- **Forks and redistribution.** You may redistribute or fork Legatus, including
  commercially, under the MIT terms. The people distributing those versions
  are responsible for their changes and any support they choose to offer.
