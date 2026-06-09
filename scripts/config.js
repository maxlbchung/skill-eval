// Loads and validates config.json — the single source of the evaluation matrix,
// pricing weights, and run parameters (design §11). Nothing here is hardcoded:
// models, conditions, and replicate count all flow from this object.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "index.db");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

function fail(msg) {
  throw new Error(`Invalid config: ${msg}`);
}

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") fail("config is not an object");

  const m = cfg.matrix;
  if (!m || typeof m !== "object") fail("missing 'matrix'");
  if (!Array.isArray(m.models) || m.models.length === 0) fail("matrix.models must be a non-empty array");
  if (m.models.some((x) => typeof x !== "string" || !x.trim())) fail("matrix.models must be model-id strings");
  if (new Set(m.models).size !== m.models.length) fail("matrix.models contains duplicates");
  if (!Array.isArray(m.conditions) || m.conditions.length === 0) fail("matrix.conditions must be a non-empty array");
  for (const required of ["skill", "control"]) {
    if (!m.conditions.includes(required)) fail(`matrix.conditions must include "${required}"`);
  }
  if (!Number.isInteger(m.replicates) || m.replicates < 1) fail("matrix.replicates must be an integer >= 1");

  const p = cfg.pricing;
  if (!p || typeof p !== "object") fail("missing 'pricing'");
  if (!p.weights || typeof p.weights !== "object") fail("missing 'pricing.weights'");
  for (const k of ["input", "cacheCreation", "cacheRead", "output"]) {
    if (typeof p.weights[k] !== "number" || !(p.weights[k] >= 0)) fail(`pricing.weights.${k} must be a number >= 0`);
  }
  if (!p.inputPerMTok || typeof p.inputPerMTok !== "object") fail("missing 'pricing.inputPerMTok'");
  for (const model of m.models) {
    if (typeof p.inputPerMTok[model] !== "number" || !(p.inputPerMTok[model] >= 0)) {
      fail(`pricing.inputPerMTok has no rate for model "${model}"`);
    }
  }

  for (const k of ["maxTurns", "concurrency", "port", "schemaVersion"]) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) fail(`${k} must be a positive integer`);
  }
  return cfg;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read config at ${configPath}: ${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err.message}`);
  }
  validateConfig(cfg);
  return Object.freeze(cfg);
}

// Replicate indices are zero-padded so cell directories sort in run order.
// Width is at least 2 (00, 01, …) and grows for large N.
export function replicateWidth(replicates) {
  return Math.max(2, String(Math.max(0, replicates - 1)).length);
}

export function cellDirName({ model, condition, replicate }, width) {
  return `${model}__${condition}__${String(replicate).padStart(width, "0")}`;
}

// The full 6N cell list in deterministic (config) order: model → condition → replicate.
export function cells(cfg) {
  const width = replicateWidth(cfg.matrix.replicates);
  const out = [];
  for (const model of cfg.matrix.models) {
    for (const condition of cfg.matrix.conditions) {
      for (let replicate = 0; replicate < cfg.matrix.replicates; replicate++) {
        out.push({ model, condition, replicate, dir: cellDirName({ model, condition, replicate }, width) });
      }
    }
  }
  return out;
}

export function cellCount(cfg) {
  return cfg.matrix.models.length * cfg.matrix.conditions.length * cfg.matrix.replicates;
}

// Inverse of cellDirName: "<model>__<condition>__<replicate>" → {model, condition, replicate}.
// Splits from the right so a model string containing "__" (none do today) stays intact.
export function parseCellDir(name) {
  const parts = name.split("__");
  const replicate = Number(parts.pop());
  const condition = parts.pop();
  const model = parts.join("__");
  return { model, condition, replicate };
}
