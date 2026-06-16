// File-derived live view (design §6, §7.2). The live state is a PURE PROJECTION of files +
// settled DB rows — not in-memory orchestrator state — so a single long-lived server can show
// every concurrent run at once: each orchestrator just writes stream.jsonl + cell_metrics rows,
// and the server tails them on demand. A session is "live" while its .pid marker names a running
// process and its DB status is still 'running'. If the server restarts, nothing is lost.

import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, cellDirName, replicateWidth } from "./config.js";
import { parseStreamMetrics } from "./stream-metrics.js";

// Is a process still alive? (signal 0 = existence check; EPERM = exists but not ours.)
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
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

// The sessions running RIGHT NOW: DB status 'running' AND a live orchestrator pid behind the .pid
// marker (so a crashed run that hasn't been reconciled yet doesn't masquerade as live). Newest
// first (listSessions is id-DESC = newest first).
export function liveSessions(db) {
  return db
    .listSessions()
    .filter((s) => s.status === "running")
    .filter((s) => {
      const pid = orchestratorPid(s.id);
      return pid != null && pidAlive(pid);
    })
    .map((s) => ({ sessionId: s.id, skill: s.skill_name, startedAt: s.started_at }));
}

// Cache stream parses by (path → size) so a 1.5s poll doesn't re-read an unchanged trajectory.
const streamCache = new Map();
async function tail(streamPath) {
  let st;
  try {
    st = fs.statSync(streamPath);
  } catch {
    return null; // no stream yet
  }
  const cached = streamCache.get(streamPath);
  if (cached && cached.size === st.size) return cached;
  const metrics = await parseStreamMetrics(streamPath);
  const out = { size: st.size, metrics, startedAt: Math.round(st.birthtimeMs || st.mtimeMs || 0) || null };
  streamCache.set(streamPath, out);
  return out;
}

const tokensOfStream = (m) => (m ? { input: m.input, cacheCreation: m.cacheCreation, cacheRead: m.cacheRead, output: m.output } : null);
const tokensOfRow = (r) =>
  r.input_tokens == null && r.output_tokens == null
    ? null
    : { input: r.input_tokens || 0, cacheCreation: r.cache_creation_tokens || 0, cacheRead: r.cache_read_tokens || 0, output: r.output_tokens || 0 };

// A live snapshot for ONE session, derived entirely from files + the seeded cell rows. Phase for an
// in-flight cell is read from its stream: no stream → queued; stream present → building; stream's
// terminal `result` event seen → testing (build done, grade pending). Settled cells come from the DB.
export async function liveSnapshot(db, cfg, sessionId) {
  const session = db.getSession(sessionId);
  if (!session) return null;
  const rows = db.cellMetrics(sessionId);
  const width = replicateWidth(cfg.matrix.replicates);
  const cellsDir = path.join(SESSIONS_DIR, sessionId, "cells");
  const ended = session.status !== "running";

  const cells = [];
  for (const r of rows) {
    let status, tokens = null, steps = r.steps ?? 0, startedAt = null;

    if (r.status === "complete") {
      status = "done";
      tokens = tokensOfRow(r);
    } else if (r.status === "failed") {
      status = "failed";
      tokens = tokensOfRow(r);
    } else {
      // in-flight (DB 'pending'): derive phase + live tokens from files
      const dir = cellDirName({ model: r.model, condition: r.condition, replicate: r.replicate }, width);
      const cellDir = path.join(cellsDir, dir);
      if (fs.existsSync(path.join(cellDir, ".failed"))) {
        status = "failed";
      } else {
        const live = await tail(path.join(cellDir, "stream.jsonl"));
        if (!live) {
          status = ended ? "failed" : "pending"; // never-started cell of a finished session = failed
        } else {
          startedAt = live.startedAt;
          tokens = tokensOfStream(live.metrics);
          steps = live.metrics?.steps ?? 0;
          status = live.metrics?.failed ? "failed" : live.metrics?.resultSeen ? "testing" : "building";
        }
      }
    }
    cells.push({ model: r.model, condition: r.condition, replicate: r.replicate, status, startedAt, tokens, steps });
  }
  return { sessionId, skill: session.skill_name, started_at: session.started_at, ended, cells };
}
