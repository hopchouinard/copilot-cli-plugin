import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewPrompt } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { renderReviewResult } from "../plugins/copilot/scripts/lib/render.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "copilot");

const CONTEXT = {
  target: { label: "working tree diff" },
  collectionGuidance: "Use the repository context below as primary evidence.",
  content: "## Git Status\n\nM src/a.js\n"
};

test("the review prompt inlines the JSON schema, because the harness cannot enforce one", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, { template: "review", focusText: "" });
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /needs-attention/);
  assert.ok(!prompt.includes("{{OUTPUT_SCHEMA}}"), "the placeholder must be interpolated");
});

test("the review prompt carries the target label and repository context", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, { template: "review", focusText: "" });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /M src\/a\.js/);
});

test("the adversarial prompt carries the user focus text", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, {
    template: "adversarial-review",
    focusText: "question the retry design"
  });
  assert.match(prompt, /question the retry design/);
});

test("renderReviewResult lists findings ordered by severity with file and line", () => {
  const rendered = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "One blocking issue.",
        findings: [
          { severity: "low", title: "Nit", body: "b", file: "b.js", line_start: 2, line_end: 2, confidence: 0.4, recommendation: "r" },
          { severity: "critical", title: "Data loss", body: "b", file: "a.js", line_start: 10, line_end: 12, confidence: 0.9, recommendation: "r" }
        ],
        next_steps: ["Fix a.js"]
      },
      parseError: null,
      rawOutput: "{}"
    },
    { reviewLabel: "Review", targetLabel: "working tree diff", costLabel: "claude-haiku-4.5 (0.33x premium)" }
  );
  assert.ok(rendered.indexOf("Data loss") < rendered.indexOf("Nit"), "critical must sort above low");
  assert.match(rendered, /a\.js:10/);
  assert.match(rendered, /claude-haiku-4\.5/);
});

test("renderReviewResult falls back to raw output when parsing failed", () => {
  const rendered = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "Copilot said something unstructured" },
    { reviewLabel: "Review", targetLabel: "working tree diff", costLabel: "auto (10% discount)" }
  );
  assert.match(rendered, /Unexpected token/);
  assert.match(rendered, /Copilot said something unstructured/);
});
