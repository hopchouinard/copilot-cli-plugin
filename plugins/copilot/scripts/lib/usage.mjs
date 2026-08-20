import { multiplierFor } from "./models.mjs";

function catalogEntry(modelId, catalog) {
  return catalog?.models?.find((model) => model.id === modelId) ?? null;
}

export function describeCost(modelId, catalog) {
  const entry = catalogEntry(modelId, catalog);
  const multiplier = multiplierFor(modelId, catalog);

  if (typeof multiplier === "number") {
    return { model: modelId, multiplier, label: `${modelId} (${multiplier}x premium)` };
  }

  if (typeof entry?.discountPercent === "number") {
    return { model: modelId, multiplier: null, label: `${modelId} (${entry.discountPercent}% discount)` };
  }

  return { model: modelId, multiplier: null, label: `${modelId} (cost unknown)` };
}

export function exceedsThreshold(modelId, catalog, threshold) {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }
  const multiplier = multiplierFor(modelId, catalog);
  if (typeof multiplier !== "number") {
    return false;
  }
  return multiplier >= limit;
}

export function formatUsage(usage) {
  if (!usage || typeof usage.premiumRequests !== "number") {
    return null;
  }
  const plural = usage.premiumRequests === 1 ? "" : "s";
  const model = usage.model ? ` on ${usage.model}` : "";
  return `${usage.premiumRequests} premium request${plural}${model}`;
}

export function summariseJobUsage(jobs) {
  const reporting = (jobs ?? []).filter((job) => typeof job?.usage?.premiumRequests === "number");
  if (reporting.length === 0) {
    return null;
  }
  return {
    premiumRequests: reporting.reduce((total, job) => total + job.usage.premiumRequests, 0),
    jobs: reporting.length
  };
}
