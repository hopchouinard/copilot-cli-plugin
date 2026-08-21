# Changelog

## Unreleased

State store:
- The plugin's state store no longer depends on which other plugins are installed alongside it.
  Its SessionStart hook used to publish its data directory into the shared session environment
  under the harness's own `CLAUDE_PLUGIN_DATA` name, as did the plugin this one was ported from.
  With both installed the last SessionStart to run won, and every Bash-run command in the session
  resolved its store to the *other* plugin's directory while hooks resolved it to the correct one.
  `/copilot:setup --enable-review-gate` therefore set the flag somewhere the Stop hook never
  looked, and the review gate silently never armed. The directory is now published as
  `COPILOT_PLUGIN_DATA`, which no neighbour can clobber, and the plugin no longer overwrites the
  shared name for its neighbours either.
- **One-time action:** configuration written before this fix lives in another plugin's data
  directory and is not migrated. Re-run `/copilot:setup` with your model and gate settings once.
  The model catalog refetches on its own.

Model selection:
- Commands send a resolved model **id** across process boundaries, never a table row number. A row
  number is an index into a catalog that can change: anything refreshing the shared roster between
  the cost guard and the launch it authorised re-numbers the rows, so the same number could price
  one model and run another. The script still accepts a row number, which is what makes `--model 4`
  useful directly after `models` in a shell.
- `/copilot:setup` is now atomic: every requested change is validated before any of them is
  persisted. It previously applied settings as it parsed them, so a command that failed still
  changed configuration — `/copilot:setup --enable-review-gate --model 99` reported an invalid
  model and exited non-zero having already turned the review gate on, silently committing the user
  to a premium request on every stop while telling them the command had failed.
- `--effort` is validated against the model being set in the same command rather than the one it
  replaces.
- `/copilot:setup --model` now shows a numbered table of **every** model in the live catalog,
  cheapest first, marking which models the review and task roles currently use. It replaces a
  four-option `AskUserQuestion` picker that could only ever offer a third of a twelve-model roster,
  leaving the rest reachable only by typing an id into "Other".
- Any command taking `--model` also accepts a table row number, resolved by the script through the
  same ordering the table was numbered with, so the number a user reads and the number they type
  cannot point at different models. Model ids always win over row numbers.
- `--review-model` and `--task-model` get the same treatment; previously only a bare `--model` was
  handled and the other two threw `Missing value` at the user.
- The cost guard in `/copilot:review`, `/copilot:adversarial-review`, and `/copilot:rescue` gains a
  `Choose another model` option that opens the same table, instead of offering only the cheapest
  model as an alternative.
- New `copilot-companion.mjs models` subcommand backing all of the above, with `--json`. It
  refreshes a stale roster before displaying it — a picker is where an out-of-date price does the
  most damage.

Fixes for every finding raised on PR #1 by the GitHub Copilot and Codex reviewers.

Security:
- Read-only reviews now validate command **arguments**, not just the executable. Each allowed
  command carries an explicit flag whitelist, so `find . -delete`, `find . -exec rm -rf {} +`,
  `git diff --output=FILE`, and `rg --pre=<cmd>` are refused instead of approved.
- Untracked symlinks are resolved and containment-checked before being read, so a link such as
  `secrets -> ~/.ssh/id_rsa` is listed but never sent to Copilot.
- `--resume` requires an exact, canonicalised working-directory match. A session with no recorded
  directory previously matched every repository and could be continued in the wrong one.

Correctness:
- The stop-time review gate no longer allows a session to end silently when Copilot is missing or
  logged out, and its internal-error block decision now exits 0 so Claude Code actually applies it.
- Per-job premium usage is recorded as the delta for that turn rather than the resumed session's
  running total, which was double-counted in session totals.
- The inferred-completion fallback no longer fires while a tool call is in flight, which truncated
  turns from models that narrate before acting.
- `state.json` is published atomically and its read-modify-write is serialized by an interprocess
  lock; a torn read previously rebuilt the file from an empty default and deleted every tracked
  job's files. The lock is released only by the process that holds it, verified by an ownership
  token — releasing unconditionally let a writer that timed out waiting delete the real holder's
  lock, which was worse than taking no lock at all.
- Background jobs are persisted before their worker is spawned, closing a race that could strand a
  job in the queue forever.
- The cost guard refreshes a stale or incomplete model roster before pricing a run, and treats an
  unknown multiplier as exceeding the threshold rather than silently bypassing the confirmation.
- A catalog with an unparseable `cachedAt` is treated as stale rather than as permanently fresh.
- `/copilot:setup --effort` validates against both the review and task models, not the task model
  alone.
- The default branch keeps its `origin/` qualifier when no local branch of that name exists.
- Review output that parses as JSON but does not match the schema falls back to raw output instead
  of throwing after the premium request was already spent.

## 0.1.0

- Initial version of the Copilot plugin for Claude Code
- `/copilot:review` and `/copilot:adversarial-review` for read-only Copilot reviews of working-tree or branch changes
- `/copilot:rescue` to delegate investigation, fixes, and follow-up work to Copilot through the `copilot:copilot-rescue` subagent
- `/copilot:transfer` to condense the current Claude Code conversation into a briefing that seeds a new, resumable Copilot session
- `/copilot:status`, `/copilot:result`, and `/copilot:cancel` to track, read, and cancel background Copilot jobs, including premium-request usage
- `/copilot:setup` to check Copilot CLI readiness, resolve and choose models per role, and manage the optional stop-time review gate
- A six-level model resolution chain (flag, plugin config, `COPILOT_MODEL`, repo settings, user settings, `auto`), since the Copilot RPC layer resolves no default model on its own
- A cost guard that reads the live model catalog and warns before backgrounding a run at or above a configurable premium multiplier
- `SessionStart`/`SessionEnd` lifecycle hooks and an optional `Stop`-time review gate hook
