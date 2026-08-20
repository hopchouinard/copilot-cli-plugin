---
description: Check whether the local Copilot CLI is ready, choose models, and manage the review gate
argument-hint: '[--model <id>] [--review-model <id>] [--task-model <id>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If the result says Copilot is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Copilot now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run `npm install -g @github/copilot`, then rerun the setup command above.

If the user passed `--model` with no value:
- Read `modelCatalog.models` from the JSON result.
- Use `AskUserQuestion` exactly once to let them pick a model.
- Label each option with the model id, and put its multiplier and supported effort levels in the description, for example `9x premium · low, medium, high, max`.
- Order the options cheapest first.
- Then rerun the setup command with `--model <chosen id>`.

Output rules:
- Present the final setup output to the user.
- If Copilot is installed but not authenticated, preserve the guidance to run `!copilot login`.
- Preserve the resolved model table exactly as returned, including the multiplier column and the source of each value.
