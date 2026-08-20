// Coverage for the numbered model picker that replaced the four-option
// AskUserQuestion, which could only ever offer a third of the roster.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeCatalog,
  orderedCatalogModels,
  resolveModelSelection,
  resolveModel
} from "../plugins/copilot/scripts/lib/models.mjs";
import { renderModelTable } from "../plugins/copilot/scripts/lib/render.mjs";
import { buildModelListing, buildSetupReport, buildCostCheck } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig, getConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

// Deliberately supplied out of price order, and with a multiplier tie, so the
// tests prove the ordering is imposed here rather than inherited from the RPC.
const RAW_MODELS = [
  { id: "gemini-3.5-flash", billing: { multiplier: 14 }, capabilities: { supports: { reasoning_effort: ["minimal", "low"] } } },
  { id: "claude-haiku-4.5", billing: { multiplier: 0.33 }, capabilities: {} },
  { id: "auto", billing: { discountPercent: 10 }, capabilities: {} },
  { id: "gpt-5.4", billing: { multiplier: 6 }, capabilities: { supports: { reasoning_effort: ["none", "xhigh"] } } },
  { id: "mai-code-1.1-flash", billing: { multiplier: 0.25 }, capabilities: { supports: { reasoning_effort: ["low"] } } },
  { id: "claude-sonnet-4.6", billing: { multiplier: 9 }, capabilities: { supports: { reasoning_effort: ["max"] } } },
  { id: "gpt-5-mini", billing: { multiplier: 0.33 }, capabilities: {} },
  { id: "claude-sonnet-4.5", billing: { multiplier: 6 }, capabilities: {} }
];
const CATALOG = normalizeCatalog({ models: RAW_MODELS });

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
  setConfig(cwd, "modelCatalog", CATALOG);
  return cwd;
}

function withScenario(scenario) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-")), "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario), "utf8");
  return { binary: FIXTURE, env: { ...process.env, FAKE_COPILOT_SCRIPT: file } };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("models are ordered cheapest first, unpriced last, ties broken by id", () => {
  const ids = orderedCatalogModels(CATALOG).map((model) => model.id);
  assert.deepEqual(ids, [
    "mai-code-1.1-flash",   // 0.25
    "claude-haiku-4.5",     // 0.33, tie broken alphabetically
    "gpt-5-mini",           // 0.33
    "claude-sonnet-4.5",    // 6, tie broken alphabetically
    "gpt-5.4",              // 6
    "claude-sonnet-4.6",    // 9
    "gemini-3.5-flash",     // 14
    "auto"                  // no multiplier — last
  ]);
});

test("the ordering does not depend on the order the RPC returned models in", () => {
  const shuffled = normalizeCatalog({ models: [...RAW_MODELS].reverse() });
  assert.deepEqual(
    orderedCatalogModels(shuffled).map((m) => m.id),
    orderedCatalogModels(CATALOG).map((m) => m.id)
  );
});

test("an empty or missing catalog orders to nothing rather than throwing", () => {
  assert.deepEqual(orderedCatalogModels(null), []);
  assert.deepEqual(orderedCatalogModels({ models: [] }), []);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("a row number selects the model shown on that row", () => {
  const ordered = orderedCatalogModels(CATALOG);
  for (const [index, model] of ordered.entries()) {
    const picked = resolveModelSelection(String(index + 1), CATALOG);
    assert.equal(picked.model, model.id, `row ${index + 1}`);
    assert.equal(picked.matchedBy, "number");
  }
});

test("a model id still selects that model", () => {
  const picked = resolveModelSelection("claude-sonnet-4.6", CATALOG);
  assert.equal(picked.model, "claude-sonnet-4.6");
  assert.equal(picked.matchedBy, "id");
});

test("an id wins over a row number when a model is literally named as a digit", () => {
  const odd = normalizeCatalog({ models: [...RAW_MODELS, { id: "7", billing: { multiplier: 99 } }] });
  assert.equal(resolveModelSelection("7", odd).model, "7");
  // Every other number still indexes the table.
  assert.equal(resolveModelSelection("1", odd).model, "mai-code-1.1-flash");
});

test("an out-of-range number is rejected and names the valid range", () => {
  assert.throws(() => resolveModelSelection("99", CATALOG), /expected 1-8/);
  assert.throws(() => resolveModelSelection("0", CATALOG), /expected 1-8/);
});

test("a number with no cached catalog is rejected rather than guessed at", () => {
  assert.throws(() => resolveModelSelection("3", null), /no model catalog is cached/i);
});

test("an unknown non-numeric id passes through, so a roster older than the model still works", () => {
  const picked = resolveModelSelection("some-future-model", CATALOG);
  assert.equal(picked.model, "some-future-model");
});

test("an empty selection resolves to nothing rather than row zero", () => {
  assert.equal(resolveModelSelection("", CATALOG).model, null);
  assert.equal(resolveModelSelection(null, CATALOG).model, null);
});

// ---------------------------------------------------------------------------
// Resolution chain
// ---------------------------------------------------------------------------

test("a row number passed as a flag resolves through the normal chain", () => {
  const resolved = resolveModel({ role: "review", flagModel: "6", config: {}, catalog: CATALOG });
  assert.equal(resolved.model, "claude-sonnet-4.6");
  assert.equal(resolved.source, "flag");
});

test("a row number never leaks out of config, only ids do", async () => {
  const cwd = tempWorkspace();
  await buildSetupReport(cwd, { model: "6", refreshCatalog: false, ...withScenario({ models: RAW_MODELS }) });
  const config = getConfig(cwd);
  assert.equal(config.reviewModel, "claude-sonnet-4.6");
  assert.equal(config.taskModel, "claude-sonnet-4.6");
});

test("the cost guard prices a row number as the model it names", async () => {
  const cwd = tempWorkspace();
  const check = await buildCostCheck(cwd, { role: "review", model: "6", refreshCatalog: false });
  assert.equal(check.model, "claude-sonnet-4.6");
  assert.equal(check.multiplier, 9);
  assert.equal(check.exceeds, true);
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

test("the table lists every model in the catalog, not a truncated subset", () => {
  const table = renderModelTable(CATALOG);
  for (const model of RAW_MODELS) {
    assert.ok(table.includes(model.id), `missing ${model.id}`);
  }
  assert.match(table, /Reply with a number \(1-8\) or a model id\./);
});

test("the table numbers rows in the same order the selection resolves", () => {
  const table = renderModelTable(CATALOG);
  for (const line of table.split("\n")) {
    const row = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!row) {
      continue;
    }
    assert.equal(
      resolveModelSelection(row[1], CATALOG).model,
      row[2],
      `row ${row[1]} displays ${row[2]} but resolves elsewhere`
    );
  }
});

test("the table marks which roles currently use a model", () => {
  const table = renderModelTable(CATALOG, { review: "gpt-5.4", task: "gpt-5.4" });
  const line = table.split("\n").find((candidate) => candidate.includes("gpt-5.4 "));
  assert.match(line, /review, task/);
  assert.match(table, /IN USE/);
});

test("the table omits the IN USE column when nothing is resolved to", () => {
  const table = renderModelTable(CATALOG);
  assert.equal(table.includes("IN USE"), false);
});

test("a discount-only model is priced as a discount, not as unknown", () => {
  assert.match(renderModelTable(CATALOG), /auto\s+10% off/);
});

test("an empty catalog explains how to fetch one instead of rendering an empty table", () => {
  assert.match(renderModelTable({ models: [] }), /Run `\/copilot:setup`/);
});

// ---------------------------------------------------------------------------
// Listing command
// ---------------------------------------------------------------------------

test("the listing exposes the same numbering the table renders", async () => {
  const cwd = tempWorkspace();
  const listing = await buildModelListing(cwd, { refreshCatalog: false });
  assert.equal(listing.models.length, RAW_MODELS.length);
  assert.deepEqual(
    listing.models.map((model) => model.number),
    listing.models.map((_, index) => index + 1)
  );
  for (const model of listing.models) {
    assert.equal(resolveModelSelection(String(model.number), CATALOG).model, model.id);
  }
});

test("the listing reports which model each role currently resolves to", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  setConfig(cwd, "taskModel", "gpt-5.4");
  const listing = await buildModelListing(cwd, { refreshCatalog: false });
  assert.equal(listing.resolved.review, "claude-haiku-4.5");
  assert.equal(listing.resolved.task, "gpt-5.4");
});

test("a stale roster is refreshed before the user is asked to choose from it", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "modelCatalog", { models: [{ id: "ancient", multiplier: 1, reasoningEfforts: [] }], cachedAt: "2020-01-01T00:00:00.000Z" });

  const listing = await buildModelListing(cwd, withScenario({ models: RAW_MODELS }));

  assert.equal(listing.models.length, RAW_MODELS.length);
  assert.equal(listing.models.some((model) => model.id === "ancient"), false);
});

// ---------------------------------------------------------------------------
// Command docs — the picker only helps if the commands actually use it.
// ---------------------------------------------------------------------------

const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "copilot", "commands");
const readCommand = (name) => fs.readFileSync(path.join(COMMANDS_DIR, name), "utf8");

test("setup.md drives the picker from the models table, not from AskUserQuestion", () => {
  const source = readCommand("setup.md");
  assert.match(source, /copilot-companion\.mjs" models/, "setup.md must run the models subcommand");
  assert.match(source, /exactly as returned/, "the table must be shown verbatim, not rebuilt");
  assert.match(
    source,
    /do not use `AskUserQuestion`/i,
    "setup.md must say not to use the four-capped picker for model choice"
  );
});

test("setup.md forwards the raw answer rather than mapping the number itself", () => {
  const source = readCommand("setup.md");
  assert.match(source, /forward what they typed verbatim/i);
});

test("every cost-guard command offers the full roster, not only the cheapest model", () => {
  for (const name of ["review.md", "adversarial-review.md", "rescue.md"]) {
    const source = readCommand(name);
    assert.match(source, /`Choose another model`/, `${name} must offer the full roster`);
    assert.match(source, /copilot-companion\.mjs" models/, `${name} must run the models subcommand`);
    assert.match(source, /caps at four options/, `${name} must explain why a second picker is wrong`);
  }
});
