# Copilot plugin for Claude Code — design

Date: 2026-08-18
Status: approved, ready for implementation planning

## 1. Purpose

Build a Claude Code plugin that lets a Claude Code user delegate code review and
coding tasks to GitHub Copilot CLI, without leaving Claude Code.

It is a port of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
onto the GitHub Copilot CLI harness, at strict surface parity: the same commands,
the same subagent, the same skill set, the same hooks.

The plugin delegates to the user's **local** Copilot CLI install and its existing
authentication. It ships no credentials, no separate runtime, and no npm runtime
dependencies.

## 2. Requirements

- GitHub Copilot CLI `>= 1.0.80` on `PATH` as `copilot`
- Node.js `>= 18.18.0`
- An active Copilot subscription; the user is authenticated (`copilot login`,
  or `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` in the environment)
- Git, for the review commands

## 3. Findings that shaped the design

All of the following were verified empirically against Copilot CLI 1.0.80 on
macOS before this document was written. They are facts about the harness, not
assumptions.

### 3.1 Copilot CLI has a JSON-RPC server mode

`copilot --headless --stdio --no-auto-update` starts a JSON-RPC 2.0 server on
stdin/stdout. This is the direct analogue of `codex app-server` and is what
`@github/copilot-sdk` drives.

Two differences from the Codex app server matter:

1. **Framing is LSP-style**, not newline-delimited JSON. Every message is
   `Content-Length: <n>\r\n\r\n<json>`. The Codex plugin's line-buffered reader
   cannot be reused as-is.
2. **The handshake is `connect`**, not `initialize`/`initialized`.
   `connect { protocolVersion: 3 }` returns
   `{ ok: true, protocolVersion: 3, version: "1.0.80" }`.

### 3.2 Session IDs are caller-supplied

`session.create` accepts a `sessionId` we generate (`crypto.randomUUID()`) and
honors it. Codex, by contrast, mints thread IDs server-side, which is part of
why it needed a broker to hold a live handle.

This is the single most consequential difference. It means a background job can
record its Copilot session ID at enqueue time, before the worker process has
started, so cancel and resume work against jobs that have not reported back yet.

### 3.3 There is no native reviewer

Codex exposes `review/start` with a built-in review prompt and a
`baseBranch` / `uncommittedChanges` target type. Copilot has no equivalent.

Both review commands must therefore be prompt-driven. This collapses two code
paths into one: a single review engine parameterised by prompt template.

### 3.4 There is no structured-output parameter

`session.send` accepts `{ sessionId, prompt, displayPrompt, attachments, mode,
agentMode, requestHeaders }`. There is no `outputSchema` equivalent to the one
Codex accepts on `turn/start`, even though `models.list` reports
`structured_outputs: true` for individual models.

The JSON contract therefore moves into the prompt, and parsing must be
defensive.

### 3.5 There is no session-import API

Codex exposes `externalAgentConfig/import`, which reads Claude Code's
`~/.claude/projects/**/*.jsonl` natively and produces a resumable thread with
visible turn history. Copilot has nothing comparable.

### 3.6 Read-only has to be assembled

Codex has `sandbox: "read-only"` as a first-class thread parameter. Copilot's
equivalent is composed from three independent mechanisms (see §6.3).

### 3.7 Premium-request cost is observable

The `session.shutdown` event carries `totalPremiumRequests`, `totalNanoAiu`, and
related usage counters. Every `session.send` consumes a premium request against
the user's Copilot quota. The Codex plugin has the same property with respect to
Codex usage limits but never surfaces it.

### 3.8 Verified RPC shapes

```
connect                       { protocolVersion: 3 }
                              → { ok, protocolVersion, version }
auth.getStatus                {}
                              → { isAuthenticated, authType, host, statusMessage, login }
models.list                   {}
                              → { models: [{ id, name, capabilities, billing }] }
session.create                { sessionId, model, reasoningEffort, workingDirectory,
                                excludedTools, availableTools, enableFileChangeTracking,
                                streaming, requestPermission, clientName, agent, ... }
                              → { sessionId, workspacePath, capabilities }
session.send                  { sessionId, prompt }            → { messageId }
session.mode.set              { sessionId, mode }              → null
session.permissions.setAllowAll { sessionId, enabled }         (requires `mode` or `enabled`)
session.interruptMainTurn     { sessionId }
session.abort                 { sessionId }
session.metadata.snapshot     { sessionId }
                              → { sessionId, currentMode, selectedModel, workingDirectory,
                                  workspace: { git_root, cwd }, ... }
sessions.list                 { limit }
                              → { sessions: [{ sessionId, startTime, modifiedTime,
                                               summary, name, context: { cwd } }] }
session.destroy               { sessionId }                    → { success: true }
```

Server-to-client notifications:

- `session.lifecycle` — `{ type: "session.created" | "session.updated" | ..., sessionId, metadata }`
- `session.event` — `{ sessionId, event: { type, data, id } }`

Observed `session.event` types relevant to this plugin: `session.start`,
`session.mode_changed`, `session.managed_settings_resolved`, `session.shutdown`,
`assistant.turn_start`, `assistant.message`, `assistant.reasoning`,
`assistant.tool_call_delta`, `assistant.turn_end`, `assistant.usage`,
`command.execute`, `command.completed`, `agent_completed`, `agent_idle`.

## 4. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Hand-rolled JSON-RPC client over `copilot --headless --stdio` | True analogue of the Codex app-server integration. Zero runtime dependencies, matching the reference plugin. `@github/copilot-sdk` would pull in `koffi`, `zod`, and `@github/copilot` into a plugin that has no install step. |
| D2 | No broker | §3.2 removes the reason one existed. Deletes ~500 lines and an entire class of stale-socket failure. Cost is a few seconds of runtime startup per command. |
| D3 | Strict surface parity with `codex-plugin-cc` | 7 commands, 1 subagent, 3 skills, 3 hooks. Copilot-native extras are a later proposal, not v1. |
| D4 | One review engine, two prompt templates | §3.3 leaves no native reviewer to special-case. |
| D5 | JSON contract in the prompt, defensive parse | §3.4. Mirrors the reference plugin's existing `parseStructuredOutput` fallback behaviour. |
| D6 | Digest-priming transfer | §3.5. Lossy but honest; the command output says so. |
| D7 | Per-job premium-request accounting | §3.7. The only intentional departure from parity. Background jobs make quota consumption easy to lose track of; surfacing it is the difference between a usable tool and a quota leak. |

## 5. Repository layout

```
.claude-plugin/marketplace.json
.github/workflows/pull-request-ci.yml
README.md
LICENSE
NOTICE
package.json                       private, type: module, no runtime deps
scripts/bump-version.mjs
plugins/copilot/
  .claude-plugin/plugin.json
  CHANGELOG.md
  LICENSE
  NOTICE
  commands/
    review.md
    adversarial-review.md
    rescue.md
    transfer.md
    status.md
    result.md
    cancel.md
    setup.md
  agents/
    copilot-rescue.md
  skills/
    copilot-cli-runtime/SKILL.md
    copilot-result-handling/SKILL.md
    copilot-prompting/SKILL.md
    copilot-prompting/references/prompt-blocks.md
    copilot-prompting/references/prompt-recipes.md
    copilot-prompting/references/prompt-antipatterns.md
  prompts/
    review.md
    adversarial-review.md
    stop-review-gate.md
  schemas/
    review-output.schema.json
  hooks/hooks.json
  scripts/
    copilot-companion.mjs
    session-lifecycle-hook.mjs
    stop-review-gate-hook.mjs
    lib/
      rpc-client.mjs
      copilot.mjs
      args.mjs
      fs.mjs
      git.mjs
      job-control.mjs
      process.mjs
      prompts.mjs
      render.mjs
      state.mjs
      tracked-jobs.mjs
      usage.mjs
      workspace.mjs
      claude-session-transfer.mjs
tests/
  *.test.mjs
  fake-copilot-fixture.mjs
  helpers.mjs
```

Marketplace name: `github-copilot`. Plugin name: `copilot`. Commands are
therefore `/copilot:review`, `/copilot:rescue`, and so on.

## 6. Runtime architecture

### 6.1 `lib/rpc-client.mjs`

A JSON-RPC 2.0 client over a spawned `copilot --headless --stdio` process.

Responsibilities:

- Spawn `copilot` with `["--headless", "--no-auto-update", "--stdio", "--log-level", "error"]`
- Encode outgoing messages with `Content-Length` framing
- Decode incoming messages from a `Buffer` accumulator, handling partial reads
  and multiple messages per chunk
- Correlate responses to requests by `id`
- Dispatch notifications to a settable handler
- Reject any pending request when the child exits, surfacing captured stderr
- `close()` ends stdin, then force-terminates the process tree after a grace
  period

Public surface: `connect(cwd, options)`, `request(method, params)`,
`notify(method, params)`, `setNotificationHandler(fn)`, `close()`, `.stderr`.

The `connect` handshake sends `connect { protocolVersion: 3 }` and throws a
version-mismatch error naming the required minimum if the server reports a
lower protocol version.

### 6.2 `lib/copilot.mjs`

The harness layer. Exports:

- `getCopilotAvailability(cwd)` — `copilot --version` plus a `--headless --stdio`
  handshake probe. Returns `{ available, detail, version }`.
- `getCopilotAuthStatus(cwd)` — `auth.getStatus`. Returns `{ available,
  loggedIn, detail, authType, login, host }`.
- `runCopilotTurn(cwd, options)` — the single turn primitive.
- `interruptCopilotTurn(cwd, { sessionId })` — `session.interruptMainTurn`,
  falling back to `session.abort`.
- `findLatestTaskSession(cwd)` — `sessions.list` filtered by
  `context.cwd` and by our session-name prefix.
- `parseStructuredOutput(rawOutput, fallback)` — ported verbatim, extended to
  strip Markdown code fences before `JSON.parse`.

`runCopilotTurn` options:

```
{
  sessionId,          // resume this session, or omit to create a new one
  prompt,
  defaultPrompt,      // used when resuming with no explicit prompt
  model,              // null = Copilot default
  effort,             // low | medium | high | xhigh | max
  readOnly,           // true for reviews, false for rescue
  sessionName,        // set via session.name.set when creating
  agent,              // custom agent name, passed to session.create
  onProgress          // ProgressReporter
}
```

It returns:

```
{
  status,             // 0 on a completed turn, 1 otherwise
  sessionId,
  messageId,
  finalMessage,
  reasoningSummary,
  touchedFiles,
  commandExecutions,
  usage,              // { premiumRequests, ... } from session.shutdown
  error,
  stderr
}
```

### 6.3 Read-only enforcement

Copilot has no `sandbox: "read-only"`. Read-only is assembled from three
independent layers, each of which is individually sufficient to block the
common case and jointly close the gaps:

1. **Tool filtering** — `session.create { excludedTools: [...] }` removes write
   and edit tools from the model's view entirely.
2. **Plan mode** — `session.mode.set { sessionId, mode: "plan" }`. The runtime
   blocks file mutation outside the session folder.
3. **Deny-by-default permissions** — `session.create { requestPermission: true }`,
   and the client answers every pending permission request by denying anything
   not on an explicit read allowlist.

Rescue runs invert all three: `mode: "interactive"`, no tool exclusions, and
`session.permissions.setAllowAll { sessionId, enabled: true }`. This mirrors the
reference plugin's `--write` default for its rescue subagent.

The exact `excludedTools` list must be derived at implementation time from
`session.tools.getCurrentMetadata` against the installed CLI, not hardcoded from
memory. Implementation must not guess tool names.

### 6.4 Turn capture and progress

A capture state machine consumes `session.event` notifications for the session
under test and maps them onto the reference plugin's progress vocabulary, so
`render.mjs` and the job log format carry over unchanged:

| `session.event` type | phase | log line |
|---|---|---|
| `session.start` | `starting` | session ready |
| `assistant.turn_start` | `starting` | turn started |
| `assistant.reasoning` | `investigating` | reasoning summary captured |
| `command.execute` | `running`, or `verifying` when the command matches the verification-command regex | running command |
| `command.completed` | same | command completed with exit code |
| `assistant.tool_call_delta` | `investigating` | tool call |
| `assistant.message` | `finalizing` when it is the final message | assistant message captured |
| `assistant.usage` | — | usage counters accumulated |
| `assistant.turn_end` | `finalizing` | turn completed; resolves the capture |
| `session.shutdown` | `done` | premium requests recorded |

Notifications are buffered until the `session.send` response supplies the
`messageId`, then replayed — the same ordering guard the reference plugin uses
for `turnId`.

Completion is driven by `assistant.turn_end`. A defensive inferred-completion
timer, ported from the reference plugin, fires only when a final assistant
message has been seen and no tool call is outstanding.

### 6.5 Modules ported with little or no change

| Module | Change |
|---|---|
| `lib/git.mjs` | None. Diff collection, target resolution, untracked-file formatting, and the inline-vs-self-collect size heuristic are harness-agnostic. |
| `lib/state.mjs` | None. Workspace-hashed state dir under `$CLAUDE_PLUGIN_DATA/state`, 50-job cap, job files and log files. |
| `lib/tracked-jobs.mjs` | Extended with usage accounting (§6.7). Otherwise unchanged. |
| `lib/job-control.mjs` | Rename `threadId` → `sessionId`. |
| `lib/render.mjs` | Rename Codex → Copilot in labels; add the usage line. |
| `lib/args.mjs`, `lib/process.mjs`, `lib/fs.mjs`, `lib/prompts.mjs`, `lib/workspace.mjs` | None. |

`lib/broker-endpoint.mjs`, `lib/broker-lifecycle.mjs`, `scripts/app-server-broker.mjs`,
and `lib/app-server-protocol.d.ts` have no counterpart and are not ported.

### 6.6 Background jobs

Unchanged from the reference design:

- State lives in `$CLAUDE_PLUGIN_DATA/state/<slug>-<sha256-16>/`
- `state.json` holds config plus a job index, capped at 50 newest
- `jobs/<id>.json` holds the full record; `jobs/<id>.log` holds the progress log
- `--background` writes a `queued` record and spawns a detached
  `copilot-companion.mjs task-worker --cwd <cwd> --job-id <id>`
- The worker rehydrates the stored request and runs it under `runTrackedJob`

One improvement enabled by §3.2: the job record carries its Copilot `sessionId`
from the moment it is queued, so `/copilot:cancel` can interrupt a job whose
worker has not yet produced its first progress event.

### 6.7 Premium-request accounting

`usage.mjs` accumulates counters from `assistant.usage` events and from the
`session.shutdown` event's `totalPremiumRequests` / `totalNanoAiu`.

- Each job record gains `usage: { premiumRequests, aiu, model }`
- `/copilot:status` renders a `premium` column in its job table
- `/copilot:status` with no argument renders a session total across listed jobs
- `/copilot:result` includes the job's usage line
- When the runtime reports no usage data, the field is omitted rather than
  rendered as zero

This is the one intentional departure from strict parity, approved explicitly.

## 7. Commands

All eight command files reproduce the reference plugin's frontmatter discipline:
`description`, `argument-hint`, `allowed-tools`, and `disable-model-invocation:
true` on every command except `rescue` and `setup`.

The behavioural rules that are harness-neutral are reproduced verbatim, because
they are what make the reference plugin behave well:

- "Return the command stdout verbatim. Do not paraphrase, summarize, or add
  commentary before or after it."
- "This command is review-only. Do not fix issues, apply patches, or suggest
  that you are about to make changes."
- The foreground/background decision procedure: inspect `git status --short
  --untracked-files=all` and `git diff --shortstat`, recommend waiting only for
  a clearly tiny scope, recommend background otherwise, then a single
  `AskUserQuestion` with the recommended option first.

### 7.1 `/copilot:review`

`[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]`

Runs the standards-and-defects review prompt against the resolved git target.
Read-only per §6.3. Because there is no native reviewer to defer to, this
command accepts the same target selection as the adversarial variant but still
rejects custom focus text, preserving the reference plugin's division of labour:
`review` is not steerable, `adversarial-review` is.

### 7.2 `/copilot:adversarial-review`

`[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]`

Ports `prompts/adversarial-review.md` from the reference plugin. That template
is harness-neutral and is reproduced with only the role line changed and the
JSON schema inlined per D5.

### 7.3 `/copilot:rescue`

`[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <level>] [task ...]`

Routes to the `copilot:copilot-rescue` subagent via the `Agent` tool. Write-capable
by default. Before starting, unless `--resume` or `--fresh` is present, calls
`copilot-companion.mjs task-resume-candidate --json` and asks once whether to
continue the latest session for this repo.

Model aliases resolve through a map seeded from `models.list` at setup time
rather than hardcoded, so the plugin does not go stale as GitHub's roster
changes. `auto` is passed through untouched.

### 7.4 `/copilot:transfer`

`[--source <claude-jsonl>]`

Per D6:

1. Resolve the Claude transcript path — from `--source`, else from the
   `SessionStart` hook's exported `CLAUDE_TRANSCRIPT_PATH`. The source must be
   under `~/.claude/projects`.
2. Parse the `.jsonl` and render a structured digest: goal, decisions taken,
   files touched, commands run, open threads.
3. `session.create` with a UUID we own and a session name derived from the
   digest.
4. Seed the digest as the opening message.
5. Print the digest location and `copilot --resume=<uuid>`.

The command output states plainly that this is a primer, not replayed turn
history, and that Copilot has no session-import API.

### 7.5 `/copilot:status`, `/copilot:result`, `/copilot:cancel`

Ported behaviour. `status` renders a compact Markdown table for the no-argument
case and full detail for a specific job ID, now including the premium column.
`cancel` calls `session.interruptMainTurn`, then terminates the worker process
tree, then marks the job cancelled.

### 7.6 `/copilot:setup`

`[--enable-review-gate|--disable-review-gate]`

Reports Node, Copilot binary, protocol handshake, and auth status; caches the
model roster from `models.list`; toggles the review gate. When Copilot is
missing and npm is available, offers `npm install -g @github/copilot`. When
Copilot is present but unauthenticated, directs the user to `!copilot login`.

## 8. Subagent

`agents/copilot-rescue.md` is a thin forwarder, reproducing the reference
subagent's constraints:

- Exactly one `Bash` call to `copilot-companion.mjs task ...`
- Never inspects the repository, reads files, greps, polls status, fetches
  results, cancels jobs, or summarizes output
- Never calls `review`, `adversarial-review`, `status`, `result`, or `cancel`
- Returns the companion's stdout verbatim; returns nothing if the call fails
- May use the `copilot-prompting` skill only to tighten the forwarded prompt
- Leaves `--model` and `--effort` unset unless the user asked for them
- Defaults to `--write` unless the user asked for read-only

## 9. Skills

All three are `user-invocable: false` internal contracts.

- **`copilot-cli-runtime`** — the helper contract for the rescue subagent.
  Ports the reference skill with `task` command syntax, resume routing, and the
  "forwarder, not orchestrator" rule.
- **`copilot-result-handling`** — presentation rules. Ports verbatim, including
  the critical rule: after presenting review findings, STOP; never auto-apply
  fixes; ask which issues the user wants fixed.
- **`copilot-prompting`** — replaces `gpt-5-4-prompting`. The XML-block
  methodology and the `<task>` / `<structured_output_contract>` /
  `<verification_loop>` / `<grounding_rules>` block vocabulary carry over
  directly. The model-specific guidance is rewritten for Copilot's roster, and
  a new block is added covering D5: how to state a JSON contract in-prompt when
  the harness cannot enforce a schema.

## 10. Hooks

`hooks/hooks.json` registers three hooks.

- **`SessionStart`** (timeout 5s) — appends `COPILOT_COMPANION_SESSION_ID`,
  `CLAUDE_TRANSCRIPT_PATH`, and `CLAUDE_PLUGIN_DATA` to `$CLAUDE_ENV_FILE`.
- **`SessionEnd`** (timeout 5s) — terminates process trees for any job still
  `queued` or `running` under this session ID, then drops those jobs from state.
  No broker teardown.
- **`Stop`** (timeout 900s) — the optional review gate, off by default.

The review gate reproduces the reference contract exactly: the prompt requires a
first line of `ALLOW: <reason>` or `BLOCK: <reason>`; anything else is treated as
a failure and blocks with an explanation. The gate only reviews the immediately
previous turn, and only if that turn made direct edits.

The reference plugin's warning is strengthened for Copilot. Each gate firing is
a billable premium request. The `/copilot:setup` output and the plugin README
both state this, and the gate's own log line reports the premium requests it
consumed.

## 11. Prompts and schema

`schemas/review-output.schema.json` is ported unchanged: `verdict`
(`approve` | `needs-attention`), `summary`, `findings[]` (`severity`, `title`,
`body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`), and
`next_steps[]`.

Per D5 the schema is not passed to the runtime. It is interpolated into the
review prompts inside a `<structured_output_contract>` block. Parsing strips
Markdown code fences, then attempts `JSON.parse`, then falls back to reporting
`rawOutput` plus a `parseError` — the same three-state result the reference
renderer already handles.

`prompts/review.md` is new authorship, since the reference plugin delegated to
Codex's built-in reviewer and has no template to copy. It covers correctness
defects, contract violations, error handling, and test coverage, with the same
finding bar and grounding rules as the adversarial template.

## 12. Testing

`node --test tests/*.test.mjs`, no test framework dependency, matching the
reference plugin.

- `tests/fake-copilot-fixture.mjs` — a stub binary that speaks the
  `Content-Length` framing, answers `connect`, `auth.getStatus`, `models.list`,
  `session.create`, `session.send`, `session.destroy`, and emits a scripted
  `session.event` sequence including `assistant.usage` and `session.shutdown`.
  This is what makes the suite hermetic and free of premium-request cost.
- `rpc-client.test.mjs` — framing round-trip, split-chunk reads, multiple
  messages in one chunk, request/response correlation, child-exit rejection.
- `copilot.test.mjs` — turn capture against scripted event sequences, including
  out-of-order notifications and a missing `assistant.turn_end`.
- `usage.test.mjs` — premium-request accumulation and the omit-when-absent rule.
- `git.test.mjs`, `state.test.mjs`, `render.test.mjs`, `process.test.mjs`,
  `commands.test.mjs` — ported from the reference suite.

CI runs on pull request: `node --test`, plus a version-consistency check across
`package.json`, `plugin.json`, and `marketplace.json`.

## 13. Build order

1. `rpc-client.mjs`, `copilot.mjs`, `/copilot:setup` — end-to-end provable with
   a real `session.send`
2. Port `git.mjs`, `state.mjs`, `tracked-jobs.mjs`, `job-control.mjs`,
   `render.mjs`; wire `/copilot:review`
3. `/copilot:adversarial-review`, `/copilot:rescue`, the subagent, the three
   skills
4. `/copilot:status`, `/copilot:result`, `/copilot:cancel`, usage accounting,
   the three hooks, `/copilot:transfer`
5. Fake-copilot fixture, full test suite, CI, marketplace metadata, README

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| RK1 | `--headless --stdio` is undocumented and could change | `connect` returns a protocol version; the client asserts it and fails with a clear upgrade message. CI pins a minimum CLI version. |
| RK2 | Prompt-enforced JSON is weaker than a schema parameter | Defensive parse with a three-state result; the renderer already handles a parse failure by showing raw output. |
| RK3 | Read-only is assembled from three mechanisms rather than one flag | All three applied together; the permission handler denies by default. Tool names derived from the live runtime, never hardcoded. |
| RK4 | Transfer is lossy | Stated plainly in command output and README. |
| RK5 | Premium-request consumption, especially from the review gate | Per-job accounting surfaced in status and result; gate ships off by default with an explicit warning. |
| RK6 | Copilot's tool names and event types drift between releases | Fixture-based tests fail loudly; setup probes the live runtime for the tool roster. |

## 15. Out of scope for v1

Deliberately excluded, to be proposed separately once parity ships:

- A `/copilot:plan` command using native plan mode
- `--agent` custom-agent selection surfaced as a user-facing flag
- GitHub MCP toolset configuration so reviews can pull live PR and issue context
- Broker / shared runtime (D2)
- Windows-specific handling beyond what the ported `process.mjs` already does
