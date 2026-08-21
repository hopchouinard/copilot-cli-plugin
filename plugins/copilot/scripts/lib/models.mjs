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
  // An unparseable cachedAt makes `now - Date.parse(...)` NaN, and every
  // comparison against NaN is false — so the pre-existing `> TTL` test
  // reported a corrupted stamp as FRESH and pinned a bad catalog in place
  // forever. A stamp we cannot read is not evidence of freshness.
  const cachedAt = Date.parse(catalog.cachedAt);
  if (!Number.isFinite(cachedAt)) {
    return true;
  }
  return now - cachedAt > CATALOG_TTL_MS;
}

function configKeyForRole(role) {
  return role === "review" ? "reviewModel" : "taskModel";
}

export function resolveModel({ role, flagModel, config = {}, env = {}, repoSettings, userSettings, catalog }) {
  const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

  // A flag value may be a table row number rather than an id. Resolving it
  // here, at the single point every command funnels through, means `--model 7`
  // works identically for setup, review, rescue, transfer, and the cost guard
  // instead of each one reimplementing the mapping.
  const flag = trimmed(flagModel) ? resolveModelSelection(flagModel, catalog).model : null;

  const candidates = [
    [flag, "flag"],
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

export function catalogHasModel(modelId, catalog) {
  return Boolean(findModel(modelId, catalog));
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

// The one ordering used by BOTH the numbered table the user reads and the
// number they type back. Deriving them separately would let the two drift and
// silently select a different model than the one displayed, so every consumer
// goes through here.
//
// Cheapest first, because cost is the reason this table exists. Models with no
// numeric multiplier (`auto`, which carries a discount rather than a
// multiplier) sort last. Ties break on id so the numbering is deterministic
// regardless of the order the RPC happens to return models in — an unstable
// ordering would mean the number the user just read no longer points at the
// same model when they type it.
export function orderedCatalogModels(catalog) {
  return [...(catalog?.models ?? [])].sort((left, right) => {
    const leftPriced = typeof left.multiplier === "number";
    const rightPriced = typeof right.multiplier === "number";
    if (leftPriced !== rightPriced) {
      return leftPriced ? -1 : 1;
    }
    if (leftPriced && left.multiplier !== right.multiplier) {
      return left.multiplier - right.multiplier;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

// Accepts either a model id or a 1-based row number from the table rendered by
// renderModelTable. An id always wins over a number, so a catalog that ever
// ships a model literally named "7" still resolves to that model rather than
// to row 7.
//
// A non-numeric value that is not in the catalog passes through unchanged
// rather than throwing: naming a model the cached roster does not know about
// is legitimate (the roster may be stale, or the model brand new), and the
// cost guard already treats an unpriceable model as expensive. Only a number
// is meaningless without a catalog to index into.
export function resolveModelSelection(input, catalog) {
  const trimmed = typeof input === "string" ? input.trim() : input == null ? "" : String(input).trim();
  if (!trimmed) {
    return { model: null, matchedBy: "empty" };
  }

  if (catalogHasModel(trimmed, catalog)) {
    return { model: trimmed, matchedBy: "id" };
  }

  if (/^\d+$/.test(trimmed)) {
    const ordered = orderedCatalogModels(catalog);
    if (ordered.length === 0) {
      throw new Error(
        `Cannot resolve model number "${trimmed}": no model catalog is cached. Run /copilot:setup first, or pass a model id.`
      );
    }
    const index = Number(trimmed) - 1;
    if (index < 0 || index >= ordered.length) {
      throw new Error(
        `Invalid model number "${trimmed}": expected 1-${ordered.length}. Run /copilot:setup --model to see the numbered list.`
      );
    }
    return { model: ordered[index].id, matchedBy: "number" };
  }

  return { model: trimmed, matchedBy: "id" };
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
