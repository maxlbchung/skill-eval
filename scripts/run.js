// Orchestrator entry (design §7.1). Runs one full session end to end:
//   prepare → build (≤concurrency) → test (sequential) → finalize → reindex → retention
// and, unless --no-serve, serves the live dashboard + report over HTTP for the run.
//
//   node scripts/run.js --skill-dir <dir> [--config config.json] [--prompt "..."]
//                       [--prompt-file <path>] [--no-serve] [--keep]

import fs from "node:fs";
import path from "node:path";
import { loadConfig, DB_PATH, DEFAULT_CONFIG_PATH } from "./config.js";
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
  console.error("Usage: node scripts/run.js --skill-dir <dir> [--config config.json] [--prompt ...] [--prompt-file ...] [--no-serve] [--keep]");
  process.exit(1);
}
const configPath = flag("--config", DEFAULT_CONFIG_PATH);
const promptOverride =
  flag("--prompt") ?? (flag("--prompt-file") ? fs.readFileSync(flag("--prompt-file"), "utf-8") : null);
const serve = !has("--no-serve");
const keep = has("--keep");

const cfg = loadConfig(configPath);
const db = openDb(DB_PATH);

// Recover any session a previous orchestrator left 'running' after a crash.
const recovered = await reconcileAbandoned(db);
if (recovered.length) console.log(`▶ recovered ${recovered.length} abandoned session(s): ${recovered.join(", ")}`);

console.log(`▶ preparing session for ${skillDir}`);
const session = prepareSession(db, cfg, skillDir, { promptOverride });
console.log(
  `  ${session.id}  —  ${session.cells.length} cells ` +
    `(${cfg.matrix.models.length} models × ${cfg.matrix.conditions.length} conditions × ${cfg.matrix.replicates} replicates)`
);

// Optional live server + hooks (server.js, Step 4). Falls back to no-op hooks if absent.
let live = {};
let server = null;
let port = cfg.port;
if (serve) {
  try {
    const mod = await import("./server.js");
    const started = await mod.startSession?.(db, session, cfg);
    if (started) ({ live, server, port } = started);
    if (server) console.log(`  live: http://localhost:${port}${port !== cfg.port ? `  (config port ${cfg.port} was busy)` : ""}`);
  } catch (err) {
    console.warn(`  (live server not started: ${err.message})`);
  }
}

console.log(`▶ building (concurrency ${cfg.concurrency})`);
const builds = await runBuilds(db, session, cfg, live);
console.log(`  built ${builds.filter((b) => b.status === "pending").length}/${builds.length}`);

console.log(`▶ testing`);
const tests = await runTests(db, session, cfg, builds, live);
console.log(`  scored ${tests.filter((t) => t.status === "complete").length}/${tests.length}`);

// finalize → reindex (safety) → retention
db.finalizeSession(session.id, "complete", new Date().toISOString());
db.reconcileStaleCells(session.id);
try {
  await reindexSession(db, session.sessionDir, session.id);
} catch (err) {
  console.warn(`  reindex skipped: ${err.message}`);
}
live.onSessionEnd?.();
if (!keep) retainSession(db, session);
fs.rmSync(path.join(session.sessionDir, ".pid"), { force: true }); // settled — no longer abandonable

printSummary(db, session);

if (serve && server) {
  console.log(`\n✓ done — report at http://localhost:${port}  (Ctrl-C to stop the server)`);
} else {
  db.close();
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
