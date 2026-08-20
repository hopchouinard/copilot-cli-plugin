---
description: Check whether the local Copilot CLI is ready, choose models, and manage the review gate
argument-hint: '[--model <id|number>] [--review-model <id|number>] [--task-model <id|number>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Before running anything, check the raw arguments for a bare model flag with no id after it — `--model`, `--review-model`, or `--task-model`, either as the last token or immediately followed by another `--flag`. The underlying script rejects a valueless flag outright (it throws `Missing value for --model` before any of your logic below can run), so this must be handled here first, without ever passing that bare flag through:

- Run the model table, with every bare model flag removed and every other argument kept:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" models
```

- Show that table to the user **exactly as returned**. It is already numbered, sorted cheapest first, and marks which models the review and task roles currently use. Do not rebuild it, truncate it, or re-order it, and do not use `AskUserQuestion` — the whole point of the table is that it lists every model, and an `AskUserQuestion` caps at four options.
- Then stop and let the user answer. Ask them which model they want, naming the flag being set (for `--review-model` say it applies to reviews only; for `--task-model`, rescue and transfer runs; for `--model`, both).
- When they reply, pass their answer straight through as the flag value:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json --model <their answer>
```

  The script resolves a row number or a model id itself, using the same ordering the table was numbered with, so forward what they typed verbatim rather than mapping it to an id yourself. If they typed something invalid the script reports the valid range — show that and ask again.
- If the user names a model in the same message that invoked the command ("use sonnet", "pick the cheapest"), skip the table and resolve it directly.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

Use this JSON-mode result only to decide what to do next — it is not what you show the user (see "Final output" below).

If the result says Copilot is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Copilot now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run `npm install -g @github/copilot`.

Final output:
- Once no further action is needed (Copilot was already available, or the user chose to install or skip), run the setup command one more time with the same `$ARGUMENTS` but WITHOUT `--json`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup $ARGUMENTS
```

- Present that command's stdout to the user as the final setup report — this is the rendered resolved-model table, not something to reconstruct from the JSON fields above.
- If Copilot is installed but not authenticated, preserve the guidance to run `!copilot login`.
- Preserve the resolved model table exactly as returned, including the multiplier column and the source of each value.
