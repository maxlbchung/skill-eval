// Dev helper: seed data/demo.db with synthetic multi-iteration data so the History
// "metrics over iterations" chart can be explored without running real evals.
// Also seeds a few FAILED runs with on-disk error logs (stderr.log / eval.log / .failed),
// so the Report run-status filter and the Error-logs section have something to show.
//   node scripts/_seed-demo.mjs   then:   node scripts/server.js --db data/demo.db
import fs from "node:fs";
import path from "node:path";
import { loadConfig, cells, DATA_DIR, SESSIONS_DIR, cellDirName, replicateWidth } from "./config.js";
import { openDb } from "./db.js";

const base = loadConfig();
const cfg = { ...base, matrix: { ...base.matrix, replicates: 4 } };
const dbPath = path.join(DATA_DIR, "demo.db");
for (const e of ["", "-wal", "-shm"]) fs.rmSync(dbPath + e, { force: true });
const db = openDb(dbPath);

const [m0, m1, m2] = base.matrix.models;
const level = { [m0]: 0.92, [m1]: 0.8, [m2]: 0.62 }; // opus > sonnet > haiku
const rnd = (a, b) => a + Math.random() * (b - a);
const cl = (x) => Math.max(0, Math.min(1, x));
const ITERS = 6;
const tokens = () => ({ input: Math.round(rnd(20, 80)), cacheCreation: Math.round(rnd(5000, 15000)), cacheRead: Math.round(rnd(80000, 260000)), output: Math.round(rnd(300, 900)), steps: Math.round(rnd(4, 16)) });

// Synthetic per-cell error logs, written where a real supervisor / test runner would.
function writeBuildFailLogs(cellDir, model, started) {
  fs.mkdirSync(cellDir, { recursive: true });
  fs.writeFileSync(path.join(cellDir, "stderr.log"),
    `node:internal/process/promises:288\n            triggerUncaughtException(err, true /* fromPromise */);\nError: model stream closed before a result event (model=${model})\n    at ChildProcess.<anonymous> (claude/stream.js:204:13)\n[supervisor fatal] build produced no result.json\n`);
  fs.writeFileSync(path.join(cellDir, "supervisor.log"),
    `[${started}] spawn claude model=${model} maxTurns=50 cwd=${cellDir}\n[${started}] child exit code=1\n[${started}] finish state=failed exitCode=1\n`);
  fs.writeFileSync(path.join(cellDir, ".failed"), "model stream closed before a result event — no result.json written");
}
function writeIngestFailLogs(cellDir, model, started) {
  fs.mkdirSync(cellDir, { recursive: true });
  fs.writeFileSync(path.join(cellDir, "eval.log"),
    `[ingest failed] result.json is not valid JSON: Unexpected end of JSON input\n--- runner exit 0 ---\n--- stdout ---\nscoring 5 checks against output/clean.csv ...\n--- stderr ---\nTraceback (most recent call last):\n  File "eval/score.py", line 51, in <module>\n    json.dump({"schemaVersion": 1, "tests": tests}, fh)\n  File "eval/score.py", line 33, in dedup_check\n    raise ValueError("output column count drifted mid-file")\nValueError: output column count drifted mid-file\n`);
  fs.writeFileSync(path.join(cellDir, "supervisor.log"),
    `[${started}] spawn claude model=${model} maxTurns=50\n[${started}] result seen + grace elapsed → finishing complete\n[${started}] finish state=complete exitCode=0\n`);
  fs.writeFileSync(path.join(cellDir, ".failed"), "ingest failed: result.json is not valid JSON");
}

for (let k = 0; k < ITERS; k++) {
  const day = String(10 + k).padStart(2, "0");
  const id = `2026-05-${day}T12-00-00__clean-csv`;
  const skillHash = (k < 3 ? "a1" : "b2").padEnd(64, "0"); // two skill versions
  const started = `2026-05-${day}T12:00:00.000Z`;
  // fresh on-disk session dir for this demo session (so reseeds don't leave stale logs)
  const sessionDir = path.join(SESSIONS_DIR, id);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  const cellsDir = path.join(sessionDir, "cells");

  db.insertSession({ id, skill_name: "clean-csv", skill_hash: skillHash, prompt_hash: "demo".padEnd(64, "0"), status: "complete", started_at: started, ended_at: started, tester_version: "demo", schema_version: 1 });
  const cs = cells(cfg);
  db.seedCells(id, cs);
  for (const c of cs) {
    const cellDir = path.join(cellsDir, c.dir);
    // Two seeded failure modes: a haiku/control build crash in every session, and a
    // sonnet/skill ingest failure once the skill is on its second version (k >= 3).
    const buildFail = c.model === m2 && c.condition === "control" && c.replicate === 0;
    const ingestFail = k >= 3 && c.model === m1 && c.condition === "skill" && c.replicate === 3;

    if (buildFail) {
      db.writeBuildMetrics(id, c, tokens(), "failed");
      writeBuildFailLogs(cellDir, c.model, started);
      continue;
    }
    if (ingestFail) {
      db.writeBuildMetrics(id, c, tokens(), "pending");
      db.setCellStatus(id, c, "failed");
      writeIngestFailLogs(cellDir, c.model, started);
      continue;
    }

    const lvl = level[c.model] ?? 0.7;
    const center = c.condition === "skill" ? cl(lvl * (0.7 + 0.05 * k)) : cl(lvl * 0.35); // skill trends up; control flat/low
    const tests = [
      { name: "file_creation", score: 1 },
      { name: "file_testability", score: Math.random() < 0.95 ? 1 : 0 },
      { name: "dedup", score: Number(cl(center + rnd(-0.15, 0.15)).toFixed(3)) },
      { name: "nulls", score: Number(cl(center + rnd(-0.15, 0.15)).toFixed(3)) },
      { name: "encoding", score: Number(cl(center + rnd(-0.15, 0.15)).toFixed(3)) },
    ];
    db.writeBuildMetrics(id, c, tokens(), "pending");
    db.ingestTests(id, c, tests);
  }
}
console.log(`seeded ${dbPath} with ${ITERS} iterations × ${cells(cfg).length} cells (incl. seeded failures + logs under ${SESSIONS_DIR})`);
db.close();
