---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Copilot rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <id>] [--effort <level>] [what Copilot should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `copilot:copilot-rescue` subagent via the `Agent` tool (`subagent_type: "copilot:copilot-rescue"`), forwarding the raw user request as the prompt.
`copilot:copilot-rescue` is a subagent, not a skill — do not call `Skill(copilot:copilot-rescue)` or `Skill(copilot:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be Copilot's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the task text.
- If the request includes `--resume` or `--fresh`, do not ask. The user already chose.
- Otherwise, before starting Copilot, check for a resumable session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Copilot session or start a new one.
- The two choices must be:
  - `Continue current Copilot session`
  - `Start a new Copilot session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Copilot session (Recommended)` first.
- Otherwise put `Start a new Copilot session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Cost guard (background runs only):
- Before launching in the background, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" cost-check --role task --json
```

- If the request includes `--model <id>`, forward the same `--model <id>` to `cost-check` above so the guard checks the model the run will actually use, not the configured default.
- Always state the returned `label` to the user on the launch line, for example `model  claude-sonnet-4.6 (9x premium)`.
- If `exceeds` is false, launch without asking.
- If `exceeds` is true, use `AskUserQuestion` exactly once with four options in this order:
  - `Run in background` — describe it as "proceed at <label>"
  - `Switch to <cheapest>` — describe it as "rerun at <cheapestLabel>"
  - `Choose another model` — describe it as "see all models and pick one"
  - `Cancel`
- If the user picks `Choose another model`, run the model table and let them pick from the whole roster rather than just the cheapest:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" models
```

  Show that table exactly as returned — it is numbered, sorted cheapest first, and complete. Do not use a second `AskUserQuestion` for the models themselves: it caps at four options and the roster is larger than that. Stop, let the user answer with a number or a model id, and pass their answer straight through as `--model <their answer>` — the script resolves row numbers itself using the same ordering the table was numbered with.
- If `costUnknown` is true, `exceeds` is true because the cost could not be established, not because a
  known multiplier is high. Say so plainly ("the multiplier for <model> could not be read from
  `models.list`") rather than quoting a figure, and omit the `Switch to <cheapest>` option when
  `cheapest` is null.
- If the user picks the cheaper model, add `--model <cheapest>` before routing to the subagent.
- If the user cancels, do not launch anything and say so.
- Foreground runs never ask. State the cost and run.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Copilot companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/copilot:status`, fetch `/copilot:result`, call `/copilot:cancel`, summarize output, or do follow-up work of its own.
- Leave `--model` and `--effort` unset unless the user explicitly asks. The plugin resolves both.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Copilot is missing or unauthenticated, stop and tell the user to run `/copilot:setup`.
- If the user did not supply a request, ask what Copilot should investigate or fix.
