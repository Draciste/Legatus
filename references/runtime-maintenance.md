# Maintain and update Legatus

Keep support for new upstream features easy to add. Maintain a small named
action catalogue on the official SDK and a thin local launcher. Keep existing
operation names and receipts usable. Separate resource contracts, local
workflows, and unrelated credentials. Changes to well-understood upstream
methods should usually mean a catalogue or adapter change rather than a new
launcher or a second dependency stack.

## Update the SDK and its dependencies

The versioned installer works on Windows, Linux and macOS. It discovers
Node and npm on `PATH` on Linux/macOS and keeps the existing installed Node
preference on Windows. Use PowerShell 7.4+ on Linux/macOS and 7.2+ on Windows.
Set `LEGATUS_NODE_EXECUTABLE` to an existing absolute Node executable when a
specific runtime is needed. On Windows include npm beside that Node installation
for the installer. Installer and launcher Doctor report the actual Node version
and path. On Linux/macOS npm is launched as an executable, including shell shims.
For a Node-only setup, install the lock in the checkout as shown in the
[quick start](../README.md#install-from-source). Update that checkout and run
`npm ci` and `qualify` together when the lock changes.

On Linux the default state root is `$XDG_STATE_HOME/legatus` or
`~/.local/state/legatus`. On macOS it is
`~/Library/Application Support/Legatus`. Windows retains the previous
per-user installation and delegation paths. Set `LEGATUS_STATE_DIR` to an
absolute private directory when you need separate state. This overrides the
PowerShell runtime and default queue roots. The Node-only entry continues to
use its checkout-local SDK unless a runtime directory is supplied explicitly.

The packaged `scripts/agents-sdk/package-lock.json` is the active selection.
The launcher checks that the SDK and SVG parser, including its XML character
tables, resolve inside their corresponding locked packages with matching versions.
The wrapper verifies the installed lock and SDK version. Different locks can
coexist even within the same SDK version. Every normal invocation is offline
until it issues the requested API operation. Package installation is deliberate.
Keep the runtime directory under your account's write control. The launcher
checks the lock and declared SDK version. To recover from a damaged or modified
dependency tree, stage a clean installation from trusted manifests and qualify it
before selection. Running the installer again with the same lock stages a clean
replacement if the installed runtime fails qualification. The previous damaged
directory remains available under the reported `retainedInvalidRuntime` path.

1. Review the official changelog and the affected SDK method signatures.
   Prepare a separate candidate `package.json` with exact versions and resolve a
   fresh lock using npm's official registry. Keep the trusted previous pair.
2. Stage and qualify the candidate. The installer uses integrity metadata
   from the lock, skips package lifecycle scripts, checks the catalogue and
   installs into a versioned directory.
3. Check the relevant old and new actions with synthetic responses. Use a
   bounded live test when access is available and local checks cannot prove
   compatibility. Activate only after the applicable checks pass.

```powershell
$scripts = (Resolve-Path ./scripts).Path
$install = Join-Path $scripts 'Install-OpenAiRuntime.ps1'
$api = Join-Path $scripts 'openai-agents.ps1'
& $install -ManifestDirectory $candidate
& $api doctor -RuntimeManifestDirectory $candidate
& $api qualify -RuntimeManifestDirectory $candidate
& $install -ManifestDirectory $candidate -Activate
```

For a fresh install from the active manifests, run `& $install`. To stage
with a pre-populated npm cache, use `-Offline -CacheDirectory <absolute path>`.
For rollback, pass the previous installed runtime directory as
`-ManifestDirectory` and activate it against a compatible skill version.
Keep a known working lock with its qualified modules until the replacement
passes. The installer runs an offline qualification before selection.
`qualify` also runs it on demand with the selected SDK and an in-memory
transport. It covers Unicode JSON, binary multipart, fragmented SSE,
partial EOF, an accepted request with lost acknowledgement and a blocked
preflight. These checks qualify local behavior. Check live access or provider
behavior separately when relevant.
The installer expects eight named checks, including Daybreak session
serialization and SVG acceptance/rejection through the actual output path.
Each local qualification command has a 45-second deadline and a 64 KiB report budget. The npm install stage
has a ten-minute local deadline and can be retained for inspection.

## Update companion tools

- **OpenAI CLI.** Check the official release and local `--version`. Compare
  changed command shapes, structured input/output, retry and authentication
  behavior on the routes we use. Qualify the candidate before promoting it
  to the established executable path. Use offline native discovery for commands
  the skill does not wrap. For example, run
  `openai explore "count tokens offline"`, then
  `openai tokenizer count --file PATH --encoding o200k_base --number` for
  a plain UTF-8 file up to 1 MiB. Choose an explicit supported encoding.
  Use the prepared tiktoken environment for larger text or other cached
  encodings, and InputTokens over HTTP or SDK for framed requests.
  [OpenAI CLI guide](https://developers.openai.com/api/docs/libraries/openai-cli)
- **Node and PowerShell.** Check the SDK's Node requirement, native WebSocket
  behavior and platform architecture. Recheck the launcher under the chosen
  PowerShell. Use a fresh process for changed compiled credential/transport
  types. Use the candidate runtime for meaningful checks before replacing
  the system selection.
- **Codex Security and Plugin Eval.** Treat their auth,
  SDKs, browsers, native runtimes and optional connectors as versioned
  associations. Follow their own update mechanisms and qualify the actual
  invocation path.
- **Tokenizers and encoding assets.** Keep the tokenizer version, cached
  encoding files and model mapping aligned. Qualify the offline known-answer
  probe and use the server input-count operation when full request framing
  matters.
- **API features, models and service limits.** Use current documented values
  or cached verified evidence. Check endpoint access, effective project
  limits and pricing when changes matter. Prefer capability detection and
  explicit feature support over replacing stable paths with guessed defaults.

Use the usual proportionate cadence. Check before material work when changes
or stale evidence could affect it. Preserve compatibility and recovery state
through a staged update. Add concise references for new upstream capabilities
as they become useful.
[API changelog](https://developers.openai.com/api/docs/changelog) ·
[OpenAI CLI releases](https://github.com/openai/openai-cli/releases) ·
[OpenAI Node SDK](https://github.com/openai/openai-node/releases)
