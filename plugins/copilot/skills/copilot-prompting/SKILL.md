---
name: copilot-prompting
description: Internal guidance for composing Copilot prompts for coding, review, diagnosis, and research tasks inside the Copilot Claude Code plugin
user-invocable: false
---

# Copilot Prompting

Use this skill when `copilot:copilot-rescue` needs to ask Copilot for help.

Prompt Copilot like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per Copilot run. Split unrelated asks into separate runs.
- Tell Copilot what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning effort or adding long explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Copilot should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Copilot stays narrow and avoids unrelated refactors.

## Stating a JSON contract without a schema parameter

Copilot CLI has no output-schema parameter. When a run must return JSON, the
contract lives entirely in the prompt and must be stated defensively:

- Say "Return ONLY a single JSON object" explicitly.
- Say "No prose before it, no prose after it."
- Say "Do not wrap it in a Markdown code fence." Models add fences by default.
- Inline the full JSON Schema in the prompt rather than describing it.
- Name the enum values inline for any constrained field.

The plugin's parser strips a fence if one appears anyway, but a prompt that
prevents the fence is better than a parser that repairs it.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Do not raise reasoning effort first. Tighten the prompt and verification rules before escalating.
- Reasoning effort is per-model and some models support none at all. Never assume an effort level is available.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.
