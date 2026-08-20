# Changelog

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
