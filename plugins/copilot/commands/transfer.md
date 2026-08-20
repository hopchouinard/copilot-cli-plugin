---
description: Transfer the current Claude Code session into a resumable Copilot session
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Copilot session ID and the `copilot --resume=<session-id>` command.

Preserve the note explaining that this is a primer rather than replayed turn history. Copilot CLI has no session-import API, so the transfer condenses the Claude conversation into a briefing. Do not describe it to the user as a full history transfer.

Preserve the note stating that the briefing includes commands recorded during this session, and that credential redaction (Authorization headers, Bearer tokens, secret-ish named assignments) is best-effort pattern matching, not a guarantee. Do not describe the redaction as complete or safe, and do not drop or soften this note.
