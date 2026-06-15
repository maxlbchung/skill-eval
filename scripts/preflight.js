// Read-only preflight for the operating agent (SKILL.md §1, §3). Inspects a target skill + the query
// store and prints, as ONE JSON object on stdout, everything the agent needs to decide how to run —
// without launching a session or writing anything. It collapses the "detect" reasoning the agent
// would otherwise do by hand (does the eval contract exist? did the regime change? is there a fresh
// baseline, measured with which models/replicates, from which day? which control cells would be
// reused vs re-measured?) into deterministic facts plus a suggested posture. The agent reads this and
// makes only the genuine judgment calls (refresh? composition?). Nothing here mutates state.
//
//   node scripts/preflight.js --skill-dir <dir> [--config config.json] [--models a,b,c]
//                             [--replicates N] [--full-matrix] [--prompt ...] [--prompt-file ...]
//
// The flags mirror run.js so the preflight reflects the matrix the SAME invocation would actually
// run. Output is JSON only (stdout); diagnostics (if any) go to stderr.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, baselineMaxAgeIso, DB_PATH, DEFAULT_CONFIG_PATH } from "./config.js";
import { openDb } from "./db.js";
import { skillName, findEvalDoc, parseEvalMd } from "./prompts.js";
import { computeEvalHash } from "./session.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const skillDir = flag("--skill-dir");
if (!skillDir) {
  console.error("Usage: node scripts/preflight.js --skill-dir <dir> [--config config.json] [--models a,b,c] [--replicates N] [--full-matrix] [--prompt ...] [--prompt-file ...]");
  process.exit(1);
}
const configPath = flag("--config", DEFAULT_CONFIG_PATH);
const promptOverride = flag("--prompt") ?? (flag("--prompt-file") ? fs.readFileSync(flag("--prompt-file"), "utf-8") : null);
const fullMatrix = has("--full-matrix");
const explicitReplicates = flag("--replicates") != null ? Number(flag("--replicates")) : null;
const explicitModels = flag("--models") != null ? flag("--models").split(",").map((s) => s.trim()).filter(Boolean) : null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const out = { skillDir };
let skill;
try {
  skill = skillName(skillDir);
} catch {
  skill = path.basename(skillDir);
}
out.skillName = skill;

const cfg = loadConfig(configPath);
out.config = {
  models: cfg.matrix.models,
  replicates: cfg.matrix.replicates,
  baselineMaxAgeHours: cfg.baselineMaxAgeHours ?? 24,
};

// 1. Eval contract (SKILL.md §1). present:false carries the reason so the agent knows to author it.
const liveEvalDir = path.join(skillDir, "eval");
const evalDoc = findEvalDoc(liveEvalDir);
let evalSpec = null;
if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
  out.contract = { present: false, error: `no SKILL.md in ${skillDir}` };
} else if (!evalDoc) {
  out.contract = { present: false, error: `no eval/eval.md (the test contract) in ${liveEvalDir}` };
} else {
  try {
    evalSpec = parseEvalMd(evalDoc);
    out.contract = {
      present: true,
      evalDoc: path.relative(skillDir, evalDoc).split(path.sep).join("/"),
      runner: evalSpec.runner,
      required: evalSpec.required,
      inputs: evalSpec.inputs,
    };
  } catch (e) {
    out.contract = { present: false, error: e.message };
  }
}

const db = openDb(DB_PATH);

// Without a valid contract there is no eval_hash and nothing to compare. Report the skill's prior
// baseline (if any) for context and stop — the only next step is to author the contract (§1).
if (!evalSpec) {
  const prior = db.baselineDefaults(skill);
  out.priorBaseline = prior
    ? { models: prior.models, replicates: prior.replicates, lastMeasured: prior.startedAt }
    : null;
  out.decision = {
    posture: "blocked",
    reason: "eval contract missing or invalid — author eval/eval.md + a runner first (SKILL.md §1)",
    askComposition: false,
    askDayBoundaryRefresh: false,
    announceRegimeChange: false,
  };
  emit(out);
  db.close();
  process.exit(0);
}

// 2. eval_hash on the LIVE eval/ dir — identical to what prepareSession hashes off its snapshot.
const evalHash = computeEvalHash(liveEvalDir, evalSpec, promptOverride);
out.evalHash = evalHash;

// 3. Effective matrix the SAME invocation would run: explicit flags > last baseline > config.
const baseDefaults = db.baselineDefaults(skill);
const defaultModels = baseDefaults?.models.filter((m) => cfg.matrix.models.includes(m)) ?? null;
const effModelsRaw = explicitModels ?? (defaultModels?.length ? defaultModels : cfg.matrix.models);
const effModels = cfg.matrix.models.filter((m) => effModelsRaw.includes(m)); // config display order
out.effective = {
  models: effModels,
  replicates: explicitReplicates ?? baseDefaults?.replicates ?? cfg.matrix.replicates,
  modelsSource: explicitModels ? "flags" : defaultModels?.length ? "last baseline" : "config",
  replicatesSource: explicitReplicates != null ? "flags" : baseDefaults?.replicates ? "last baseline" : "config",
};

// 4. Regime change vs the skill's last complete session (keyed on eval_hash, exactly like run.js).
const prev = db.latestRegimeInfo(skill);
out.lastSession = prev
  ? { sessionId: prev.sessionId, evalHash: prev.evalHash, models: prev.models, startedAt: prev.startedAt }
  : null;
const regimeChanged = prev?.evalHash != null && prev.evalHash !== evalHash;

// 5. The control baseline AT THIS regime (eval_hash): which effective models have a prior control
//    run, its replicate count, and when it was last measured. Per-model reuse vs re-measure uses the
//    exact run.js decision (regimeHasBaseline within the headless freshness window).
const maxAgeIso = baselineMaxAgeIso(cfg);
const perModelControl = {};
const baseModels = [];
let newestControl = null;
let baseReplicates = null;
for (const m of effModels) {
  perModelControl[m] = fullMatrix ? "measure" : db.regimeHasBaseline(evalHash, m, { maxAgeIso }) ? "reuse" : "measure";
  const rb = db.regimeBaseline(evalHash, m); // last control run in this regime, any age
  if (rb) {
    baseModels.push(m);
    baseReplicates = rb.n;
    if (!newestControl || rb.epochStart > newestControl) newestControl = rb.epochStart;
  }
}
out.perModelControl = perModelControl;

// withinFreshWindow = the baseline is recent enough that a no-flags run would actually reuse it
// (regimeHasBaseline honored the headless freshness window above → perModelControl 'reuse'). A
// baseline that EXISTS but is past the window auto-refreshes on a no-flags run, so it is not a
// "reuse" — it's a forced re-measure, like a regime change.
const reusableModels = effModels.filter((m) => perModelControl[m] === "reuse");
const baselineExists = baseModels.length > 0;
const withinFreshWindow = reusableModels.length > 0;
const now = new Date();
const today = now.toISOString().slice(0, 10);
out.baseline = {
  exists: baselineExists,
  models: baseModels,
  replicates: baseReplicates,
  lastMeasured: newestControl,
  ageHours: newestControl ? Math.round(((now.getTime() - Date.parse(newestControl)) / 3600_000) * 10) / 10 : null,
  // calendar-day vs today (UTC) — the human-facing day-boundary trigger from §3.
  calendarDay: newestControl ? (newestControl.slice(0, 10) === today ? "today" : "earlier") : null,
  withinFreshWindow,
};

// 6. Suggested posture + which questions the agent should ask (it may override). A run measures fresh
//    control — and so re-establishes the baseline — when the regime changed, there is no baseline, or
//    the baseline is past the freshness window (a stale auto-refresh). Only a within-window baseline
//    is a genuine "reuse"; from an earlier day it's the §3 day-boundary judgment call.
const staleRefresh = baselineExists && !regimeChanged && !withinFreshWindow;
const initializing = regimeChanged || !baselineExists || staleRefresh;
const askDayBoundaryRefresh = !initializing && out.baseline.calendarDay === "earlier";
const inv = ["node scripts/run.js --skill-dir " + quoteArg(skillDir)];
if (explicitModels) inv.push("--models " + explicitModels.join(","));
if (explicitReplicates != null) inv.push("--replicates " + explicitReplicates);
if (fullMatrix) inv.push("--full-matrix");
out.decision = {
  posture: initializing ? "initialize" : "reuse",
  regimeChanged,
  announceRegimeChange: regimeChanged,
  announceStaleBaseline: staleRefresh,
  askDayBoundaryRefresh,
  askComposition: initializing, // ask which models + how many replicates (pre-fill from baseline.*)
  suggestedInvocation: inv.join(" "),
  note: regimeChanged
    ? "Regime changed (eval/ tests differ) — control re-measures automatically; announce it, then ask composition."
    : !baselineExists
      ? "No baseline for this regime yet — ask composition; this run establishes the baseline."
      : staleRefresh
        ? `Baseline is ${out.baseline.ageHours}h old (> the ${out.config.baselineMaxAgeHours}h window) — control auto-refreshes; announce it, then ask composition.`
        : askDayBoundaryRefresh
          ? "Fresh baseline from an earlier day — ask the day-boundary refresh question; reuse needs no flags."
          : "Same-day fresh baseline — reuse silently (skill-only); ask nothing, run with no flags.",
};

emit(out);
db.close();

function quoteArg(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}
