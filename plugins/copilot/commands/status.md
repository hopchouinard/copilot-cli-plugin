---
description: Show active and recent Copilot jobs for this repository, including premium-request usage
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the premium column and the session total line exactly as returned.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
