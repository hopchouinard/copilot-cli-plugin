# Copilot plugin for Claude Code

Use GitHub Copilot from inside Claude Code for code reviews or to delegate tasks to Copilot.

This plugin is for Claude Code users who want an easy way to reach for GitHub Copilot from the
workflow they already have. It is a port of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
to the GitHub Copilot CLI, and it has three properties that plugin does not: the plugin has to
choose your model for you, every run spends billable premium requests at a multiplier that varies
a lot by model, and session transfer is a condensed briefing, not a history import. All three are
covered below — read them before you run anything in the background.

## What You Get

- `/copilot:review` for a normal read-only Copilot review
- `/copilot:adversarial-review` for a steerable challenge review
- `/copilot:rescue`, `/copilot:transfer`, `/copilot:status`, `/copilot:result`, and `/copilot:cancel`
  to delegate work, hand off sessions, and manage background jobs
- `/copilot:setup` to check readiness, choose models, and manage the optional review gate

## Requirements

- **A GitHub Copilot subscription**, including the free tier. Every run below consumes premium
  requests from that subscription — see [What Runs Cost](#what-runs-cost).
- **GitHub Copilot CLI, version 1.0.80 or later.** The facts in this README (RPC behavior, the
  model catalog shape, the multiplier table) were measured against 1.0.80 and may drift on newer
  releases; the plugin reads the model catalog live rather than hardcoding it.
- **Node.js 18.18 or later.**

## Install

Add the marketplace in Claude Code. From a local checkout of this repository:

```bash
/plugin marketplace add /path/to/copilot-cli-plugin
```

Once this repository is published to a git host, the same command works with the `owner/repo`
form instead of a local path (for example `/plugin marketplace add <owner>/<repo>`).

Install the plugin:

```bash
/plugin install copilot@github-copilot
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` tells you whether Copilot is ready. If Copilot is missing and npm is available,
it can offer to install Copilot for you.

If you prefer to install Copilot yourself, use:

```bash
npm install -g @github/copilot
```

If Copilot is installed but not authenticated, run:

```bash
!copilot login
```

After install, you should see:

- the slash commands listed below
- the `copilot:copilot-rescue` subagent in `/agents`

One simple first run is:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Choosing Models

Codex resolves a default model on its own. **Copilot's headless RPC layer does not.** Creating a
Copilot session without an explicit model leaves it with none, and it ignores whatever is in your
own `~/.copilot/settings.json`. That gap is why this plugin resolves a model itself, on every run,
through a six-level chain, and always passes one explicitly:

```
--model flag  >  plugin config  >  COPILOT_MODEL  >  .github/copilot/settings.json  >  ~/.copilot/settings.json  >  "auto"
```

The chain is checked top to bottom and the first value found wins. Review and rescue/task runs
resolve **separate** defaults (`--review-model` and `--task-model`), because their cost profiles
differ — a review is read-only and predictable in shape, a rescue task can be open-ended.

Set them with `/copilot:setup`:

```bash
/copilot:setup --model <id>              # sets both review and task models
/copilot:setup --review-model <id>
/copilot:setup --task-model <id>
/copilot:setup --effort <level>          # default reasoning effort, where the model supports it
```

Run `/copilot:setup --model` with no value and Claude will list the live model catalog and let you
pick one interactively. `/copilot:setup` (with no arguments) always shows the resolved model per
role, its multiplier, and **why** it was chosen — which link in the chain supplied it.

## What Runs Cost

Every Copilot run — review, rescue, transfer, and each firing of the review gate — consumes
**premium requests** from your Copilot quota, billed at a **per-model multiplier**. These
multipliers are not close to each other. Measured against Copilot CLI 1.0.80:

| Model | Multiplier |
|---|---|
| `mai-code-1.1-flash` | 0.25 |
| `claude-haiku-4.5`, `gpt-5-mini`, `mai-code-1-flash-picker` | 0.33 |
| `auto` | 10% discount |
| `claude-sonnet-4.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gemini-3.1-pro-preview` | 6 |
| `claude-sonnet-4.6` | 9 |
| `gemini-3.5-flash` | 14 |

That is a **56x** spread between the cheapest and most expensive model in the roster, and the same
background review can cost **27x more** depending only on which model resolved. Note that
`gemini-3.5-flash` is the single most expensive model despite the name — multiplier does not track
model tier or naming.

**This table is a snapshot, not a contract.** The plugin never hardcodes it: every multiplier
shown by `/copilot:setup`, the cost guard, and `/copilot:status` is read live from the Copilot RPC
`models.list` call, so it moves when GitHub reprices the model.

Two things exist specifically to keep this cost visible:

- **The cost guard.** Before backgrounding a review or rescue run, the plugin checks the resolved
  model's multiplier against a threshold (`--cost-warn-threshold`, default `6x`, `0` disables it).
  At or above the threshold, Claude asks before launching — with the option to proceed at the
  resolved model, switch to the cheapest model in the catalog, or cancel. Foreground runs
  (`--wait`) never ask; you already see the model and multiplier stated on the launch line before
  they run.
- **`/copilot:status`.** Shows a `premium` column per job and a session-total line — the actual
  number of premium requests consumed, not an estimate.

```bash
/copilot:setup --cost-warn-threshold 4     # warn at 4x or above
/copilot:setup --cost-warn-threshold 0     # disable the cost guard
```

## Transfer Is A Primer, Not A History Import

Codex exposes a session-import API that reads Claude's `.jsonl` transcript natively and creates
real, continuable turns on the other side. **Copilot has no equivalent API.** `/copilot:transfer`
does not replay your Claude Code conversation into Copilot. It **condenses** the conversation into
a briefing and sends that briefing as the opening message of a new Copilot session. Copilot knows
only what that briefing describes — nothing about your prior turns beyond it. If you're expecting
Copilot to "remember" the conversation the way `codex resume` would, it won't; the transfer is a
handoff summary, not a session clone.

The briefing also includes **shell commands captured from the conversation**. A best-effort
redaction pass runs over them first — it strips values that look like credentials (`Authorization`
headers, bearer tokens, and assignments to `TOKEN`/`KEY`/`SECRET`/`PASSWORD`/`CREDENTIAL`-shaped
names). **This redaction is pattern matching, not a guarantee.** Review the commands yourself
before trusting that nothing sensitive made it into the briefing, especially for commands that
embed secrets in a shape the pattern list doesn't cover.

```bash
/copilot:transfer
/copilot:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's `SessionStart` hook supplies the current transcript path automatically; `--source` is
a manual override for pointing at a different transcript. `/copilot:transfer` prints the new
Copilot session ID and a `copilot --resume=<session-id>` command to continue it directly in
Copilot.

## Usage

### `/copilot:review`

Runs a normal, read-only Copilot review on your current work.

> [!NOTE]
> Multi-file reviews can take a while. Running in the background is usually the right call, and
> the command will recommend it once the change looks larger than a file or two.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not
steerable and does not take custom focus text — use
[`/copilot:adversarial-review`](#copilotadversarial-review) when you want to challenge a specific
decision or risk area.

Examples:

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
/copilot:review --model claude-haiku-4.5 --wait
```

This command is read-only and never makes changes. When run in the background, use
[`/copilot:status`](#copilotstatus) to check progress and [`/copilot:cancel`](#copilotcancel) to
stop it.

Read-only is enforced in three layers, and the outermost one is a command allowlist. When Copilot
asks to run a shell command during a review, the plugin approves it only if the executable is one
of `git status`, `git diff`, `git log`, `git show`, `git ls-files`, `ls`, `cat`, `rg`, `grep`,
`find`, `head`, `tail`, or `wc` **and** every flag it passes appears in that command's explicit
allowed-flag list. Recognising the executable alone is not enough — `find . -delete` and
`find . -exec rm -rf {} +` are inspection commands by name and destructive by argument. Anything
not on the list is denied, and Copilot simply retries with something simpler. If a review reports
being refused a command you consider harmless, that is this allowlist being conservative on
purpose: a wrong denial costs a retry, a wrong approval runs.

### `/copilot:adversarial-review`

Runs a **steerable** review that challenges the chosen implementation and design, not just
implementation defects.

It uses the same review-target selection as `/copilot:review`, including `--base <ref>` for branch
review, and the same `--wait`/`--background` flags. Unlike `/copilot:review`, it accepts extra
focus text after the flags.

Use it when you want:

- a review before shipping that questions the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, or race conditions

Examples:

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether this was the right caching and retry design
/copilot:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

Use it when you want Copilot to:

- investigate a bug
- try a fix
- continue a previous Copilot rescue session
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Rescue runs default to write-capable Copilot sessions — Copilot can edit files, not just talk
> about them — unless you ask for read-only investigation. Depending on the task and model, these
> runs can take a while; forcing `--background` is usually the right call.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and
`--fresh`, and a resumable rescue session exists for this repo, the plugin offers to continue it.

Examples:

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5-mini --effort medium investigate the flaky integration test
/copilot:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Copilot:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

**Notes:**

- If you don't pass `--model` or `--effort`, the plugin resolves both through the chain in
  [Choosing Models](#choosing-models) — Copilot itself will not pick for you.
- Follow-up rescue requests ("continue", "keep going", "apply the top fix") default to resuming the
  latest Copilot rescue session in the repo.

### `/copilot:transfer`

See [Transfer Is A Primer, Not A History Import](#transfer-is-a-primer-not-a-history-import) above.

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository, including premium requests
consumed per job and a session total.

Examples:

```bash
/copilot:status
/copilot:status task-abc123
/copilot:status --all
```

Use it to check progress on background work, see the latest completed job, confirm whether a task
is still running, or see what a run has cost so far.

### `/copilot:result`

Shows the final stored Copilot output for a finished job, including the model, usage, and — when
available — the Copilot session ID, so you can reopen that run directly with
`copilot --resume=<session-id>`.

Examples:

```bash
/copilot:result
/copilot:result task-abc123
```

### `/copilot:cancel`

Cancels an active background Copilot job. It interrupts the remote Copilot turn before killing the
local worker process, so Copilot stops burning premium requests on work nobody will read.

Examples:

```bash
/copilot:cancel
/copilot:cancel task-abc123
```

### `/copilot:setup`

Checks whether Copilot is installed and authenticated, resolves and displays the model chosen for
each role, and manages plugin configuration. If Copilot is missing and npm is available, it can
offer to install Copilot for you.

```bash
/copilot:setup
/copilot:setup --model <id>
/copilot:setup --review-model <id> --task-model <id>
/copilot:setup --effort <level>
/copilot:setup --cost-warn-threshold <n>
```

#### Enabling the review gate

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

The review gate is **off by default**. When enabled, a `Stop` hook runs a targeted Copilot review
based on Claude's response before the session is allowed to end; if that review finds issues, the
stop is blocked so Claude can address them first.

> [!WARNING]
> **Every firing of the review gate is a billable premium request**, charged at the resolved
> **task** model's multiplier (not the review model's) — see [What Runs Cost](#what-runs-cost). The
> gate can also create a long-running Claude/Copilot loop and drain your quota quickly. Only enable
> it when you plan to actively monitor the session, and pick a cheap task model if you intend to
> leave it on.

## Typical Flows

### Review Before Shipping

```bash
/copilot:review
```

### Hand A Problem To Copilot

```bash
/copilot:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/copilot:adversarial-review --background
/copilot:rescue --background investigate the flaky test
```

Then check in with:

```bash
/copilot:status
/copilot:result
```

## Copilot Integration

The plugin wraps the GitHub Copilot CLI's headless RPC layer. It uses the global `copilot` binary
installed in your environment and your existing Copilot authentication — there is no separate
runtime or account.

### Configuration

Model selection follows the chain in [Choosing Models](#choosing-models). To pin a model or effort
level for everyone working in a repository, add a `.github/copilot/settings.json` file:

```json
{
  "model": "gpt-5.4-mini"
}
```

That sits below plugin config and `COPILOT_MODEL` in the chain, and above your personal
`~/.copilot/settings.json` — so a repo-level pin wins over your personal default but loses to
anything you set explicitly through `/copilot:setup` or the environment.

### Moving The Work Over To Copilot

Rescue sessions, reviews, and transferred sessions can all be resumed directly in Copilot with
`copilot --resume=<session-id>`, using the session ID printed by `/copilot:result`,
`/copilot:status <job-id>`, or `/copilot:transfer`. This lets you keep working the same
conversation in the Copilot CLI or continue it there instead.

## FAQ

### Do I need a separate Copilot account for this plugin?

If you're already signed into GitHub Copilot on this machine, that account works immediately here
too — this plugin uses your local Copilot CLI authentication. If you haven't used Copilot yet, run
`/copilot:setup` to check readiness, and `!copilot login` to sign in.

### Does the plugin use a separate Copilot runtime?

No. It delegates through your local Copilot CLI's headless RPC layer on the same machine: the same
install, the same authentication state, the same repository checkout.

### Will `/copilot:transfer` give Copilot my full Claude Code conversation?

No — read [Transfer Is A Primer, Not A History Import](#transfer-is-a-primer-not-a-history-import).
It seeds Copilot with a condensed briefing, not your conversation history.

### Why does the plugin insist on choosing a model instead of leaving it to Copilot?

Because the Copilot RPC layer resolves no default on its own — see
[Choosing Models](#choosing-models). Leaving this to Copilot would leave sessions with no model at
all.

### Why do multipliers matter so much here?

Because they vary by up to 56x across the model roster, and the expensive end isn't obviously
"the biggest model" — see [What Runs Cost](#what-runs-cost). The cost guard and `/copilot:status`
exist so that spend is visible before and after the fact, not a surprise on your bill.
