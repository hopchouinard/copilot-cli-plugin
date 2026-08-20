import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_MODEL = "auto";

export function normalizeCatalog(response) {
  const models = (response?.models ?? []).map((model) => ({
    id: model.id,
    multiplier: typeof model.billing?.multiplier === "number" ? model.billing.multiplier : null,
    discountPercent:
      typeof model.billing?.discountPercent === "number" ? model.billing.discountPercent : null,
    reasoningEfforts: Array.isArray(model.capabilities?.supports?.reasoning_effort)
      ? model.capabilities.supports.reasoning_effort
      : [],
    premium: model.billing?.is_premium ?? null
  }));

  return { models, cachedAt: new Date().toISOString() };
}

export function isCatalogStale(catalog, now = Date.now()) {
  if (!catalog?.cachedAt) {
    return true;
  }
  return now - Date.parse(catalog.cachedAt) > CATALOG_TTL_MS;
}

function configKeyForRole(role) {
  return role === "review" ? "reviewModel" : "taskModel";
}

export function resolveModel({ role, flagModel, config = {}, env = {}, repoSettings, userSettings }) {
  const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

  const candidates = [
    [trimmed(flagModel), "flag"],
    [trimmed(config[configKeyForRole(role)]), "config"],
    [trimmed(env.COPILOT_MODEL), "env"],
    [trimmed(repoSettings?.model), "repo-settings"],
    [trimmed(userSettings?.model), "user-settings"]
  ];

  for (const [model, source] of candidates) {
    if (model) {
      return { model, source };
    }
  }

  return { model: FALLBACK_MODEL, source: "fallback" };
}

function findModel(modelId, catalog) {
  return catalog?.models?.find((model) => model.id === modelId) ?? null;
}

export function validateEffort(modelId, effort, catalog) {
  if (effort == null || effort === "") {
    return null;
  }

  const normalized = String(effort).trim().toLowerCase();
  const model = findModel(modelId, catalog);
  if (!model) {
    throw new Error(`Unknown model "${modelId}". Run /copilot:setup to refresh the model list.`);
  }

  if (model.reasoningEfforts.length === 0) {
    throw new Error(
      `Model ${modelId} does not support reasoning effort. Drop --effort, or pick a model that supports it.`
    );
  }

  if (!model.reasoningEfforts.includes(normalized)) {
    throw new Error(
      `Model ${modelId} does not accept effort "${normalized}". Supported: ${model.reasoningEfforts.join(", ")}.`
    );
  }

  return normalized;
}

export function multiplierFor(modelId, catalog) {
  return findModel(modelId, catalog)?.multiplier ?? null;
}

export function cheapestModel(catalog) {
  const priced = (catalog?.models ?? []).filter((model) => typeof model.multiplier === "number");
  if (priced.length === 0) {
    return null;
  }
  return priced.reduce((lowest, model) => (model.multiplier < lowest.multiplier ? model : lowest)).id;
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readUserSettings(homeDir = os.homedir()) {
  return readJsonIfPresent(path.join(homeDir, ".copilot", "settings.json"));
}

export function readRepoSettings(repoRoot) {
  if (!repoRoot) {
    return null;
  }
  return readJsonIfPresent(path.join(repoRoot, ".github", "copilot", "settings.json"));
}
