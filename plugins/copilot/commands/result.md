---
description: Show the stored final output for a finished Copilot job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, and next steps
- File paths and line numbers exactly as reported
- The model and usage lines
- The `copilot --resume=<session-id>` command when present
- Any error messages or parse errors
