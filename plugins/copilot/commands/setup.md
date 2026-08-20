---
description: Check whether the local Copilot CLI is ready, choose models, and manage the review gate
argument-hint: '[--model <id|number>] [--review-model <id|number>] [--task-model <id|number>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Before running anything, check the raw arguments for a bare model flag with no id after it — `--model`, `--review-model`, or `--task-model`, either as the last token or immediately followed by another `--flag`. The underlying script rejects a valueless flag outright (it throws `Missing value for --model` before any of your logic below can run), so this must be handled here first, without ever passing that bare flag through. Call the flag you found `<bare-flag>`; you must reuse that exact flag later, because `--model` sets both roles while `--review-model` and `--task-model` each set only one — substituting `--model` would silently change a role the user did not ask about.

- Run the model table. Forward `--cwd <dir>` if the original arguments carried one; `--cwd` is the only other option this subcommand takes.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" models
```

- **If the output says no model catalog is cached**, there is nothing to pick from — this is a first run, or Copilot is unreachable. Do not show it and do not ask. Drop `<bare-flag>` from the arguments entirely, continue with the normal setup flow below including the install and authentication steps, and once setup reports Copilot is ready, run the `models` command again and resume this picker. If Copilot still is not ready, say so and stop; a model cannot be chosen without a roster.
- Otherwise show the table to the user **exactly as returned**. It is already numbered, sorted cheapest first, and marks which models the review and task roles currently use. Do not rebuild it, truncate it, or re-order it, and do not use `AskUserQuestion` — the whole point of the table is that it lists every model, and an `AskUserQuestion` caps at four options.
- Then stop and let the user answer. Ask them which model they want, naming what `<bare-flag>` will change: `--review-model` affects reviews only, `--task-model` affects rescue and transfer runs, `--model` affects both.
- When they reply, **convert their answer to a model id** by reading it off the row they picked in the table you just displayed, then rebuild the original argument list with `<bare-flag>` given that id as its value and every other original argument preserved. For example, if the user ran `/copilot:setup --review-model --enable-review-gate` and answered `4` on a table whose row 4 was `mai-code-1-flash-picker`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json --review-model mai-code-1-flash-picker --enable-review-gate
```

  Pass the id, not the number. A row number is an index into a catalog that can change between the moment the table was rendered and the moment `setup` resolves it — `setup` may refresh the roster itself — so a number can name a different model than the row the user read. The id is stable and cannot drift. The script does accept a row number, which is what makes `--model 4` work when you run it directly from a shell straight after `models`, but nothing should send one across two separate invocations.
- If they typed a model id rather than a number, pass it through unchanged. If they typed something that is neither, say so and ask again rather than guessing.
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
