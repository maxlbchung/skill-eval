// Reindex (design §7 step 6). Rebuilds a session's DB rows purely from its files —
// stream.jsonl → token counts/steps, result.json → per-test scores + score_sum/total.
// Proves files-are-truth and is the recovery path if the DB is lost/corrupt. Run at
// finalize as a safety reconcile, and available standalone:  node scripts/reindex.js <session-id>

import fs from "node:fs";
import path from "node:path";
import { parseCellDir, SESSIONS_DIR } from "./config.js";
import { parseStreamMetrics } from "./stream-metrics.js";
import { validateResultJson } from "./eval-runner.js";

export async function reindexSession(db, sessionDir, sessionId) {
  const cellsDir = path.join(sessionDir, "cells");
  if (!fs.existsSync(cellsDir)) return { cells: 0 };

  let n = 0;
  for (const name of fs.readdirSync(cellsDir)) {
    const dir = path.join(cellsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const cell = parseCellDir(name);

    const streamPath = path.join(dir, "stream.jsonl");
    const resultPath = path.join(dir, "result.json");
    const failedMarker = fs.existsSync(path.join(dir, ".failed"));

    const metrics = fs.existsSync(streamPath) ? await parseStreamMetrics(streamPath) : null;

    let tests = null;
    if (fs.existsSync(resultPath)) {
      try {
        tests = validateResultJson(fs.readFileSync(resultPath, "utf-8"));
      } catch {
        tests = null; // invalid result → treat as no tests (cell failed)
      }
    }

    // status: complete if we have valid tests; else failed if the build failed or
    // produced nothing usable; else pending (built, untested).
    let buildStatus;
    if (tests) buildStatus = "pending";
    else if (failedMarker || !metrics || metrics.failed || !metrics.resultSeen) buildStatus = "failed";
    else buildStatus = "pending";

    if (metrics) {
      db.writeBuildMetrics(sessionId, cell, metrics, buildStatus);
    }
    if (tests) {
      db.clearTestResults(sessionId, cell);
      db.ingestTests(sessionId, cell, tests); // sets status 'complete'
    } else {
      db.setCellStatus(sessionId, cell, buildStatus);
    }
    n++;
  }
  return { cells: n };
}

// Is a process still running? Used to tell an actively-running session (orchestrator
// alive) from an abandoned one (orchestrator gone).
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user
  }
}

function orchestratorPid(sessionId) {
  try {
    const pid = Number(fs.readFileSync(path.join(SESSIONS_DIR, sessionId, ".pid"), "utf-8").trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Recover sessions left status='running' by a crashed orchestrator (design §7.1, §15:
// the DB must be rebuildable from files). Salvages whatever is on disk via reindex,
// flips never-run cells to failed, and finalizes the session. SKIPS the caller's own
// active session and any whose orchestrator process is still alive — so it can run
// safely at every startup without clobbering a concurrent run.
export async function reconcileAbandoned(db, { activeId = null } = {}) {
  const recovered = [];
  for (const s of db.listSessions()) {
    if (s.status !== "running" || s.id === activeId) continue;
    const pid = orchestratorPid(s.id);
    if (pid != null && pidIsAlive(pid)) continue; // genuinely running elsewhere

    const dir = path.join(SESSIONS_DIR, s.id);
    try {
      await reindexSession(db, dir, s.id);
    } catch {
      /* best effort — fall through to reconcile + finalize */
    }
    db.reconcileStaleCells(s.id);
    db.finalizeSession(s.id, "complete", new Date().toISOString());
    try {
      fs.rmSync(path.join(dir, ".pid"), { force: true });
    } catch {}
    recovered.push(s.id);
  }
  return recovered;
}

// CLI: node scripts/reindex.js <session-id>
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("reindex.js")) {
  const id = process.argv[2];
  if (id) {
    const { openDb } = await import("./db.js");
    const { DB_PATH } = await import("./config.js");
    const db = openDb(DB_PATH);
    const dir = path.join(SESSIONS_DIR, id);
    const r = await reindexSession(db, dir, id);
    console.log(`reindexed ${r.cells} cells for ${id}`);
    db.close();
  }
}
