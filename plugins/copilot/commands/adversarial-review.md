---
description: Run a Copilot review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Copilot review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Copilot's output verbatim to the user.

Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions. It is not just a stricter pass over implementation defects. Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Cost guard (background runs only):
- Before launching in the background, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" cost-check --role review --json
```

- If the raw arguments include `--model <id>`, forward the same `--model <id>` to `cost-check` above so the guard checks the model the run will actually use, not the configured default.
(use `--role task` in `/copilot:rescue`).
- Always state the returned `label` to the user on the launch line, for example `model  claude-sonnet-4.6 (9x premium)`.
- If `exceeds` is false, launch without asking.
- If `exceeds` is true, use `AskUserQuestion` exactly once with four options in this order:
  - `Run in background` — describe it as "proceed at <label>"
  - `Switch to <cheapest>` — describe it as "rerun at <cheapestLabel>"
  - `Choose another model` — describe it as "see all models and pick one"
  - `Cancel`
- If the user picks `Choose another model`, run the model table and let them pick from the whole roster rather than just the cheapest:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" models
```

  Show that table exactly as returned — it is numbered, sorted cheapest first, and complete. Do not use a second `AskUserQuestion` for the models themselves: it caps at four options and the roster is larger than that. Stop, let the user answer with a number or a model id, and pass their answer straight through as `--model <their answer>` — the script resolves row numbers itself using the same ordering the table was numbered with.
- If `costUnknown` is true, `exceeds` is true because the cost could not be established, not because a
  known multiplier is high. Say so plainly ("the multiplier for <model> could not be read from
  `models.list`") rather than quoting a figure, and omit the `Switch to <cheapest>` option when
  `cheapest` is null.
- If the user picks the cheaper model, append `--model <cheapest>` to the companion command.
- If the user cancels, do not launch anything and say so.
- Foreground runs never ask. State the cost and run.

Background flow:
- Launch with `Bash(..., run_in_background: true)` using the same command.
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Copilot review started in the background. Check `/copilot:status` for progress."
