---
description: Check whether the local Copilot CLI is ready, choose models, and manage the review gate
argument-hint: '[--model <id>] [--review-model <id>] [--task-model <id>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Before running anything, check the raw arguments for a bare `--model` with no id after it (either the last token, or immediately followed by another `--flag`). The underlying script rejects a valueless `--model` outright (it throws `Missing value for --model` before any of your logic below can run), so this must be handled here first, without ever passing that bare flag through:
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json` with the bare `--model` removed (keep every other argument) to get the current model catalog.
- Read `modelCatalog.models` from the JSON result.
- Use `AskUserQuestion` exactly once to let them pick a model.
- Label each option with the model id, and put its multiplier and supported effort levels in the description, for example `9x premium · low, medium, high, max`.
- Order the options cheapest first.
- Replace the bare `--model` in the arguments with `--model <chosen id>` and use that as `$ARGUMENTS` for everything below.

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
