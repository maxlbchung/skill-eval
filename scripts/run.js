// Orchestrator entry (design §7.1). Runs one full session end to end:
//   prepare → build (≤concurrency) → test (sequential) → finalize → reindex → retention
// and, unless --no-serve, serves the live dashboard + report over HTTP for the run.
//
//   node scripts/run.js --skill-dir <dir> [--config config.json] [--prompt "..."]
//                       [--prompt-file <path>] [--no-serve] [--keep]

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { loadConfig, withOverrides, baselineMaxAgeIso, DB_PATH, DEFAULT_CONFIG_PATH } from "./config.js";
import { openDb } from "./db.js";
import { prepareSession } from "./session.js";
import { runBuilds } from "./builds.js";
import { runTests } from "./eval-runner.js";
import { reindexSession, reconcileAbandoned } from "./reindex.js";
import { retainSession } from "./retention.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const skillDir = flag("--skill-dir");
if (!skillDir) {
  console.error(
    "Usage: node scripts/run.js --skill-dir <dir> [--config config.json] [--replicates N] [--full-matrix] [--prompt ...] [--prompt-file ...] [--no-serve] [--keep]"
  );
  process.exit(1);
}
const configPath = flag("--config", DEFAULT_CONFIG_PATH);
const promptOverride =
  flag("--prompt") ?? (flag("--prompt-file") ? fs.readFileSync(flag("--prompt-file"), "utf-8") : null);
const serve = !has("--no-serve");
const keep = has("--keep");
const fullMatrix = has("--full-matrix"); // opt out of baseline reuse: force the full paired matrix
const replicatesArg = flag("--replicates") != null ? Number(flag("--replicates")) : null;

let cfg = loadConfig(configPath);
try {
  cfg = withOverrides(cfg, { replicates: replicatesArg }); // --replicates overrides matrix.replicates
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const db = openDb(DB_PATH);

// Recover any session a previous orchestrator left 'running' after a crash.
const recovered = await reconcileAbandoned(db);
if (recovered.length) console.log(`▶ recovered ${recovered.length} abandoned session(s): ${recovered.join(", ")}`);

console.log(`▶ preparing session for ${skillDir}`);
const session = prepareSession(db, cfg, skillDir, {
  promptOverride,
  fullMatrix,
  baselineMaxAgeIso: baselineMaxAgeIso(cfg),
});
console.log(
  `  ${session.id}  —  ${session.cells.length} cells  ` +
    `(eval_hash ${session.evalHash.slice(0, 8)}, ${cfg.matrix.replicates} replicates)`
);
announceBaseline(session, cfg);

// Live server. Live state is now derived from files (stream.jsonl + DB), so ONE server shows every
// concurrent run — reuse an instance already listening on cfg.port instead of starting a second.
// Only start one if none answers; if we start it, it stays up after the run (Ctrl-C to stop).
let server = null;
let port = cfg.port;
let reusedServer = false;
if (serve) {
  reusedServer = await probeHealth(cfg.port);
  if (reusedServer) {
    console.log(`  live: http://localhost:${port}  (reusing the running server)`);
  } else {
    try {
      const mod = await import("./server.js");
      ({ server, port } = await mod.startServer(db, cfg));
      console.log(`  live: http://localhost:${port}${port !== cfg.port ? `  (config port ${cfg.port} was busy)` : ""}`);
    } catch (err) {
      console.warn(`  (live server not started: ${err.message})`);
    }
  }
}

console.log(`▶ building (concurrency ${cfg.concurrency})`);
const builds = await runBuilds(db, session, cfg);
console.log(`  built ${builds.filter((b) => b.status === "pending").length}/${builds.length}`);

console.log(`▶ testing`);
const tests = await runTests(db, session, cfg, builds);
console.log(`  scored ${tests.filter((t) => t.status === "complete").length}/${tests.length}`);

// finalize → reindex (safety) → retention
db.finalizeSession(session.id, "complete", new Date().toISOString());
db.reconcileStaleCells(session.id);
try {
  await reindexSession(db, session.sessionDir, session.id);
} catch (err) {
  console.warn(`  reindex skipped: ${err.message}`);
}
if (!keep) retainSession(db, session);
fs.rmSync(path.join(session.sessionDir, ".pid"), { force: true }); // settled — no longer abandonable
// the .pid is gone now, so liveSessions() stops listing this run the instant it finalizes

printSummary(db, session);

if (serve && server) {
  console.log(`\n✓ done — report at http://localhost:${port}  (Ctrl-C to stop the server)`);
} else {
  if (serve && reusedServer) console.log(`\n✓ done — report at http://localhost:${port}  (served by the running instance)`);
  db.close();
}

// Probe an already-running skill-eval server on `port`. Resolves true only if /api/health answers
// 200 with our marker, so we never collide with an unrelated service on the same port.
function probeHealth(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body)?.service === "skill-eval");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Issue 4 "inform, don't ask": report the baseline posture the harness chose. A regime change
// (new eval_hash) re-baselines automatically and is ANNOUNCED — it is mandatory for comparability,
// not a user decision. Reused vs freshly-measured control is reported per model so a mixed session
// reads correctly. The day-boundary refresh decision is the agent's (SKILL.md), not run.js's.
function announceBaseline(session, cfg) {
  const r = session.reuse;
  if (r.regimeChanged) {
    console.log(
      `  ⚠ regime change — the eval/ tests changed ` +
        `(eval_hash ${session.evalHash.slice(0, 8)} ≠ previous ${String(r.prevEvalHash).slice(0, 8)}).`
    );
    console.log(`    Measuring a fresh control baseline this session; older results are a different regime and won't be pooled.`);
  }
  const reused = r.reuseModels;
  const fresh = cfg.matrix.models.filter((m) => !reused.includes(m));
  if (r.fullMatrix && !r.regimeChanged) console.log(`  ● --full-matrix: measuring control for all models (no reuse).`);
  if (reused.length) console.log(`  ↺ reusing cached control baseline (skill cells only) for: ${reused.join(", ")}`);
  if (fresh.length && (reused.length || r.fullMatrix)) console.log(`  ● measuring control (full matrix) for: ${fresh.join(", ")}`);
}

function printSummary(db, session) {
  const rows = db.cellMetrics(session.id);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model} · ${r.condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log("\n  mean score across replicates:");
  for (const [key, rs] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const scored = rs.filter((r) => r.total > 0);
    const mean = scored.length ? scored.reduce((a, r) => a + r.score_sum / r.total, 0) / scored.length : 0;
    const failed = rs.filter((r) => r.status === "failed").length;
    console.log(
      `    ${key.padEnd(46)} ${(mean * 100).toFixed(1)}%   ` +
        `(${scored.length}/${rs.length} scored${failed ? `, ${failed} failed` : ""})`
    );
  }
  console.log(`\n  session dir: ${session.sessionDir}`);
}
