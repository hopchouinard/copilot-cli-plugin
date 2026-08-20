import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCatalog,
  resolveModel,
  validateEffort,
  multiplierFor,
  cheapestModel,
  isCatalogStale,
  CATALOG_TTL_MS
} from "../plugins/copilot/scripts/lib/models.mjs";

const RAW = {
  models: [
    { id: "auto", capabilities: {}, billing: { discountPercent: 10 } },
    {
      id: "claude-sonnet-4.6",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "max"] } },
      billing: { is_premium: true, multiplier: 9, restricted_to: ["pro", "pro_plus", "individual_trial", "business", "enterprise", "max"] }
    },
    { id: "claude-haiku-4.5", capabilities: { supports: {} }, billing: { multiplier: 0.33 } },
    {
      id: "gpt-5.3-codex",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
      billing: { multiplier: 6 }
    }
  ]
};

const CATALOG = normalizeCatalog(RAW);

const EMPTY = { reviewModel: null, taskModel: null, effort: null };

test("normalizeCatalog extracts multiplier and effort support", () => {
  const sonnet = CATALOG.models.find((model) => model.id === "claude-sonnet-4.6");
  assert.equal(sonnet.multiplier, 9);
  assert.deepEqual(sonnet.reasoningEfforts, ["low", "medium", "high", "max"]);
  assert.equal(sonnet.premium, true);
  const auto = CATALOG.models.find((model) => model.id === "auto");
  assert.equal(auto.discountPercent, 10);
  assert.equal(auto.multiplier, null);
  assert.equal(auto.premium, null);
  const haiku = CATALOG.models.find((model) => model.id === "claude-haiku-4.5");
  assert.deepEqual(haiku.reasoningEfforts, []);
  assert.ok(CATALOG.cachedAt);
});

test("the flag beats every other source", () => {
  const resolved = resolveModel({
    role: "review",
    flagModel: "gpt-5.3-codex",
    config: { ...EMPTY, reviewModel: "claude-haiku-4.5" },
    env: { COPILOT_MODEL: "auto" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "gpt-5.3-codex", source: "flag" });
});

test("plugin config beats env, repo settings, and user settings", () => {
  const resolved = resolveModel({
    role: "review",
    flagModel: null,
    config: { ...EMPTY, reviewModel: "claude-haiku-4.5" },
    env: { COPILOT_MODEL: "auto" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "claude-haiku-4.5", source: "config" });
});

test("role selects which config key is read", () => {
  const config = { ...EMPTY, reviewModel: "claude-sonnet-4.6", taskModel: "gpt-5.3-codex" };
  assert.equal(resolveModel({ role: "review", config, env: {} }).model, "claude-sonnet-4.6");
  assert.equal(resolveModel({ role: "task", config, env: {} }).model, "gpt-5.3-codex");
});

test("env beats repo settings and user settings", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: { COPILOT_MODEL: "gpt-5.3-codex" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "gpt-5.3-codex", source: "env" });
});

test("repo settings beat user settings", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: {},
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "claude-haiku-4.5" }
  });
  assert.deepEqual(resolved, { model: "claude-sonnet-4.6", source: "repo-settings" });
});

test("user settings are read because the RPC layer ignores them", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: {},
    repoSettings: null,
    userSettings: { model: "claude-haiku-4.5" }
  });
  assert.deepEqual(resolved, { model: "claude-haiku-4.5", source: "user-settings" });
});

test("falls back to auto when nothing is configured", () => {
  const resolved = resolveModel({ role: "task", config: EMPTY, env: {} });
  assert.deepEqual(resolved, { model: "auto", source: "fallback" });
});

test("skips empty string in config and falls through to next source", () => {
  const resolved = resolveModel({
    role: "review",
    flagModel: null,
    config: { reviewModel: "", taskModel: null },
    env: { COPILOT_MODEL: "gpt-5.3-codex" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "gpt-5.3-codex", source: "env" });
});

test("skips whitespace-only string in env and falls through to repo settings", () => {
  const resolved = resolveModel({
    role: "task",
    flagModel: null,
    config: EMPTY,
    env: { COPILOT_MODEL: "   " },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "claude-sonnet-4.6", source: "repo-settings" });
});

test("validateEffort passes a supported level through", () => {
  assert.equal(validateEffort("claude-sonnet-4.6", "high", CATALOG), "high");
});

test("validateEffort rejects a level the model does not support, naming the allowed set", () => {
  assert.throws(
    () => validateEffort("claude-sonnet-4.6", "xhigh", CATALOG),
    /claude-sonnet-4\.6.*low, medium, high, max/s
  );
});

test("validateEffort returns null when no effort was requested", () => {
  assert.equal(validateEffort("claude-haiku-4.5", null, CATALOG), null);
});

test("validateEffort rejects any effort for a model that supports none", () => {
  assert.throws(() => validateEffort("claude-haiku-4.5", "low", CATALOG), /does not support reasoning effort/);
});

test("multiplierFor reads the catalog, and auto reports a discount as null", () => {
  assert.equal(multiplierFor("claude-sonnet-4.6", CATALOG), 9);
  assert.equal(multiplierFor("auto", CATALOG), null);
});

test("cheapestModel skips auto and picks the lowest multiplier", () => {
  assert.equal(cheapestModel(CATALOG), "claude-haiku-4.5");
});

test("isCatalogStale returns true for a catalog older than the TTL", () => {
  const now = Date.now();
  const eightDaysAgo = new Date(now - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const staleC = { models: [], cachedAt: eightDaysAgo };
  assert.ok(isCatalogStale(staleC, now));
});

test("isCatalogStale returns false for a freshly-stamped catalog", () => {
  const now = Date.now();
  const oneHourAgo = new Date(now - (60 * 60 * 1000)).toISOString();
  const freshC = { models: [], cachedAt: oneHourAgo };
  assert.ok(!isCatalogStale(freshC, now));
});
