---
name: copilot-cli-runtime
description: Internal helper contract for calling the copilot-companion runtime from Claude Code
user-invocable: false
---

# Copilot Runtime

Use this skill only inside the `copilot:copilot-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Copilot CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `copilot:copilot-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `copilot-prompting` skill to rewrite the user's request into a tighter Copilot prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`.
- If the forwarded request includes `--model` or `--effort`, pass them through to `task`.
- If the forwarded request includes `--resume`, strip that token and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token and do not add `--resume-last`.

Model and effort:
- Leave `--model` and `--effort` unset unless the user explicitly asked. The plugin resolves both from its own configuration, and an unset flag is the correct default.
- Never invent a model id. Valid ids come from `/copilot:setup`.
- Effort levels are per-model. If the user asks for an effort the model does not support, the helper returns an error naming the supported set. Return that error as-is; do not retry with a different value.

Safety rules:
- Default to write-capable Copilot work unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Copilot cannot be invoked, return nothing.
