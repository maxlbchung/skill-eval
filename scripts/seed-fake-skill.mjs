// Seed a coherent "fake-skill" history into the query store. The story the data tells:
//
//   • The skill helps. In every regime, every model scores far higher WITH the skill than without
//     it (control). The lift is largest for the weakest model — a skill exists to let a small/cheap
//     model do what only a big one could do unaided, so it closes the model gap.
//   • Iterating the skill improves it. Within a regime the skill score climbs smoothly from a rough
//     first draft toward a high plateau, and gets a little cheaper as it gets more efficient.
//   • Control is a flat baseline. It doesn't depend on the skill, so it's measured once per regime
//     and reused; skill-only iterations draw their control column from that cached baseline.
//   • Changing the eval is a new regime. Adding harder tests / tightening the grader drops every
//     score (control and skill are both re-measured), then the author iterates the skill back up —
//     a sawtooth that trends upward across regimes.
//   • Failures are rare. A handful of cells crash over a month (API overload, a timeout) — each with
//     an on-disk log so the Error Logs tab is real.
//
// Everything keys off skill_name='fake-skill', so removal is one command:
//   node scripts/seed-fake-skill.mjs            # seed (idempotent: clears prior fake-skill first)
//   node scripts/seed-fake-skill.mjs --delete   # remove every fake-skill session (DB rows + dirs)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDb } from "./db.js";
import { loadConfig, DB_PATH, SESSIONS_DIR, cellDirName, replicateWidth } from "./config.js";

const SKILL_NAME = "fake-skill";
const cfg = loadConfig();
const db = openDb(DB_PATH);
const MODELS = cfg.matrix.models; // [opus, sonnet, haiku] in config order = strongest → weakest
const REPS = cfg.matrix.replicates;
const WIDTH = replicateWidth(REPS);
const [OPUS, SONNET, HAIKU] = MODELS;

// ---- deterministic helpers (no Date.now / Math.random → reseeds identically) ----
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r3 = (x) => Math.round(x * 1000) / 1000;
const lerp = (a, b, t) => a + (b - a) * t;

// ---- the eval: tests with a fixed intrinsic difficulty (0 trivial → 1 very hard) ----------------
// A cell of latent ability T passes tests easier than T and fails ones harder than T, with a smooth
// band between. Easy tests (file creation) pass for everyone; the hard ones (encoding repair) are
// exactly what control can't do and the skill is built to handle.
const BAND = 0.2;
const DIFFICULTY = {
  file_creation: 0.15,
  runs_clean: 0.28,
  dedup_precision: 0.42,
  dedup_recall: 0.55,
  types_coerced: 0.70,
  nulls_filled: 0.82,
  schema_valid: 0.86,
  encoding_fixed: 0.93, // the skill's signature capability — never fully aced, even mature
};
const TESTS_V1 = ["file_creation", "runs_clean", "dedup_precision", "dedup_recall", "types_coerced", "nulls_filled"]; // 6
const TESTS_V2 = [...TESTS_V1, "schema_valid", "encoding_fixed"]; // 8 — the hard ones added

function scoreTests(names, ability, rnd) {
  return names.map((name) => ({ name, score: r3(clamp01((ability - DIFFICULTY[name]) / BAND + 0.5 + (rnd() - 0.5) * 0.08)) }));
}

// ---- the three regimes (eval contracts), in time order -----------------------------------------
// `control`: latent ability per model without the skill (strongest→weakest, and lower in harder
// regimes). `skillStart`/`skillEnd`: the skill-condition ability at the first vs last iteration —
// it starts above control and ramps to a high plateau. Each new regime starts BELOW the prior
// regime's plateau (harder tests) and recovers higher (the author keeps improving the skill).
const REGIMES = [
  {
    key: "A", evalSalt: "v1·6tests", tests: TESTS_V1, iterations: 20,
    control:    { [OPUS]: 0.56, [SONNET]: 0.45, [HAIKU]: 0.34 },
    skillStart: { [OPUS]: 0.70, [SONNET]: 0.62, [HAIKU]: 0.55 },
    skillEnd:   { [OPUS]: 0.86, [SONNET]: 0.82, [HAIKU]: 0.78 },
  },
  {
    key: "B", evalSalt: "v2·+encoding+schema", tests: TESTS_V2, iterations: 28,
    control:    { [OPUS]: 0.46, [SONNET]: 0.36, [HAIKU]: 0.27 }, // new hard tests tank control
    skillStart: { [OPUS]: 0.74, [SONNET]: 0.67, [HAIKU]: 0.60 }, // skill drops from A's plateau, still well above control
    skillEnd:   { [OPUS]: 0.93, [SONNET]: 0.89, [HAIKU]: 0.85 },
  },
  {
    key: "C", evalSalt: "v3·stricter-grader", tests: TESTS_V2, iterations: 22,
    control:    { [OPUS]: 0.51, [SONNET]: 0.41, [HAIKU]: 0.31 },
    skillStart: { [OPUS]: 0.83, [SONNET]: 0.77, [HAIKU]: 0.71 },
    skillEnd:   { [OPUS]: 0.96, [SONNET]: 0.92, [HAIKU]: 0.88 },
  },
];

// A few crashed cells over the whole month — sparse and plausible. Keyed by (regime, iteration).
const CRASHES = [
  { regime: "A", iter: 9, model: SONNET, condition: "skill", replicate: 2, reason: "API 529 overloaded; retries exhausted" },
  { regime: "B", iter: 0, model: OPUS, condition: "control", replicate: 3, reason: "Claude process exited 1: stream closed unexpectedly" },
  { regime: "B", iter: 17, model: HAIKU, condition: "skill", replicate: 0, reason: "grader timed out after 120s" },
  { regime: "C", iter: 12, model: OPUS, condition: "skill", replicate: 4, reason: "tool_use loop exceeded maxTurns=50" },
];
const crashKey = (regime, iter, model, condition, replicate) => `${regime}|${iter}|${model}|${condition}|${replicate}`;
const CRASH_BY = new Map(CRASHES.map((c) => [crashKey(c.regime, c.iter, c.model, c.condition, c.replicate), c.reason]));

// ---- token / cost model (internally consistent) ------------------------------------------------
// Skill cells read the skill doc (big cache_read) and take more steps; control is leaner. Opus
// emits more tokens than Haiku. As the skill matures it gets more efficient (fewer steps, less
// output) — so cost falls a little as score rises. Cost ordering ends up opus≫sonnet>haiku and,
// within a model, skill>control.
const OUT_SCALE = { [OPUS]: 1.45, [SONNET]: 1.0, [HAIKU]: 0.8 };
const STEP_SCALE = { [OPUS]: 1.15, [SONNET]: 1.0, [HAIKU]: 1.05 };
function tokensFor(model, condition, iterFrac, rnd, failed) {
  const skill = condition === "skill";
  const eff = skill ? lerp(1.18, 0.88, iterFrac) : 1; // maturing skill → more efficient
  const j = (x, lo = 0.9, hi = 1.1) => x * (lo + rnd() * (hi - lo));
  let steps = Math.round((skill ? 10 : 5) * STEP_SCALE[model] * eff * (0.9 + rnd() * 0.2));
  let output = Math.round(j(skill ? 7500 : 4800) * OUT_SCALE[model] * eff);
  let cacheRead = Math.round(j(skill ? 220000 : 60000) * (0.85 + 0.3 * (steps / 12)));
  let cacheCreation = Math.round(j(skill ? 20000 : 8000));
  let input = Math.round(j(skill ? 2600 : 1050));
  if (failed) { // crashed partway: truncated work, no result
    steps = 1 + Math.floor(rnd() * 3); output = Math.round(output * 0.25); cacheRead = Math.round(cacheRead * 0.3); cacheCreation = Math.round(cacheCreation * 0.5);
  }
  return { input, cacheCreation, cacheRead, output, steps: Math.max(1, steps) };
}

// ---- timeline construction ---------------------------------------------------------------------
const easeRamp = (t) => 1 - Math.pow(1 - t, 1.7); // fast early gains → plateau (diminishing returns)

function buildTimeline() {
  const specs = [];
  let clock = Date.parse("2026-05-09T09:20:00.000Z");
  const step = rng("fake-skill:clock");
  let ver = 0;
  for (const rg of REGIMES) {
    for (let i = 0; i < rg.iterations; i++) {
      const iso = new Date(clock).toISOString();
      const t = rg.iterations > 1 ? i / (rg.iterations - 1) : 0;
      const sn = rng(`sess:${rg.key}:${i}`);
      // per-iteration skill ability per model: ramp start→end + tiny session noise (gently wiggly,
      // still clearly rising). The opener (i=0) sits at skillStart and also measures control.
      const skillAbility = {};
      for (const m of MODELS) skillAbility[m] = clamp01(lerp(rg.skillStart[m], rg.skillEnd[m], easeRamp(t)) + (sn() - 0.5) * 0.012);
      specs.push({
        ts: iso.replace(/\.\d+Z$/, "").replace(/:/g, "-"), start: iso,
        dur: i === 0 ? 17 + Math.floor(step() * 8) : 8 + Math.floor(step() * 6),
        ver: ++ver, regime: rg, iter: i, full: i === 0, iterFrac: t, skillAbility,
      });
      clock += Math.round((4 + step() * 12) * 3600_000); // 4–16h between iterations
    }
  }
  return specs;
}

function endIso(startIso, durMin) { return new Date(Date.parse(startIso) + durMin * 60000).toISOString(); }

// ---- writers -----------------------------------------------------------------------------------
function writeFailLogs(sessionId, cell, reason) {
  const dir = path.join(SESSIONS_DIR, sessionId, "cells", cellDirName(cell, WIDTH));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".failed"), reason + "\n");
  fs.writeFileSync(path.join(dir, "stderr.log"), `[build] ${cell.model} ${cell.condition} rep ${cell.replicate}\n[error] ${reason}\n[build] no valid result.json produced — cell marked failed\n`);
}

function seedSession(spec) {
  const rg = spec.regime;
  const id = `${spec.ts}__${SKILL_NAME}`;
  const evalHash = sha(`fake-skill:eval:${rg.evalSalt}`);
  const skillHash = sha(`fake-skill:skill:v${spec.ver}`);
  const conditions = spec.full ? ["skill", "control"] : ["skill"]; // skill-only iterations reuse the regime baseline

  const cells = [];
  for (const model of MODELS) for (const condition of conditions) for (let replicate = 0; replicate < REPS; replicate++) cells.push({ model, condition, replicate });

  db.insertSession({
    id, skill_name: SKILL_NAME, skill_hash: skillHash, eval_hash: evalHash,
    prompt_hash: sha(`fake-skill:prompt:${rg.evalSalt}:${spec.ver}`),
    status: "running", started_at: spec.start, tester_version: "2.0.0", schema_version: cfg.schemaVersion,
  });
  db.seedCells(id, cells);

  let failed = 0;
  for (const c of cells) {
    const reason = CRASH_BY.get(crashKey(rg.key, spec.iter, c.model, c.condition, c.replicate));
    const rnd = rng(`cell:${id}:${c.model}:${c.condition}:${c.replicate}`);
    if (reason) {
      db.writeBuildMetrics(id, c, tokensFor(c.model, c.condition, spec.iterFrac, rnd, true), "failed");
      writeFailLogs(id, c, reason);
      failed++;
      continue;
    }
    db.writeBuildMetrics(id, c, tokensFor(c.model, c.condition, spec.iterFrac, rnd, false));
    const ability = c.condition === "control"
      ? clamp01(rg.control[c.model] + (rnd() - 0.5) * 0.05) // control: stable baseline + replicate noise
      : clamp01(spec.skillAbility[c.model] + (rnd() - 0.5) * 0.05);
    db.ingestTests(id, c, scoreTests(rg.tests, ability, rnd));
  }
  db.finalizeSession(id, "complete", endIso(spec.start, spec.dur));
  return { id, regime: rg.key, full: spec.full, cells: cells.length, failed, start: spec.start };
}

// ---- delete / seed entry points ----------------------------------------------------------------
function deleteFakeSkill() {
  const sessions = db.listSessions().filter((s) => s.skill_name === SKILL_NAME);
  if (!sessions.length) { console.log(`No '${SKILL_NAME}' sessions — nothing to delete.`); return; }
  db.transaction(() => {
    for (const s of sessions) {
      db.db.prepare(`DELETE FROM test_results WHERE session_id = ?`).run(s.id);
      db.db.prepare(`DELETE FROM cell_metrics WHERE session_id = ?`).run(s.id);
      db.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(s.id);
    }
  });
  for (const s of sessions) { try { fs.rmSync(path.join(SESSIONS_DIR, s.id), { recursive: true, force: true }); } catch {} }
  console.log(`Deleted ${sessions.length} '${SKILL_NAME}' session(s) (DB rows + on-disk dirs).`);
}

function seedFakeSkill() {
  deleteFakeSkill();
  db.db.exec("PRAGMA synchronous = OFF"); // per-connection: fast bulk load
  const specs = buildTimeline();
  console.log(`Seeding '${SKILL_NAME}' — ${specs.length} sessions across ${REGIMES.length} regimes:\n`);
  const agg = new Map();
  for (const spec of specs) {
    const r = seedSession(spec);
    const a = agg.get(r.regime) ?? { iters: 0, full: 0, failed: 0, first: r.start, last: r.start };
    a.iters++; if (r.full) a.full++; a.failed += r.failed; a.last = r.start;
    agg.set(r.regime, a);
  }
  for (const [regime, a] of agg) {
    console.log(`  regime ${regime}: ${a.iters} iterations (${a.full} full-matrix + ${a.iters - a.full} skill-only) · ${a.first.slice(0, 10)}→${a.last.slice(0, 10)}${a.failed ? ` · ${a.failed} crashed cells` : ""}`);
  }
  const all = db.listSessions().filter((s) => s.skill_name === SKILL_NAME);
  const cellRows = db.cellMetricsWithSession().filter((s) => s.skill_name === SKILL_NAME).length;
  console.log(`\nDone: ${all.length} complete sessions, ${cellRows} scored cells, ${CRASHES.length} crashed cells.`);
  console.log(`Remove later with:  node scripts/seed-fake-skill.mjs --delete`);
}

if (process.argv.includes("--delete")) deleteFakeSkill();
else seedFakeSkill();

db.close();
