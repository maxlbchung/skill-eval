// Retention (design §7 step 7, §9). Every file added has a binary rule: always-delete
// working copies (output/, per-cell skill/), or always-keep snapshots (session skill/,
// prompts/, every result.json). Also drops empty stderr.log, removes transient run
// markers, and purges OLD sessions' stream.jsonl (keeping the current session + any
// failed cells for diagnosis).

import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, parseCellDir } from "./config.js";

// Whitelist of what a settled cell keeps. Everything else — output/, the skill/ copy, the
// delivered input files, transient markers (.done/.failed/supervisor.log), eval.log, and any
// scratch the agent created in its cwd — is deleted, so the immutable session never accumulates
// litter. (Inputs survive forever in the eval/ snapshot, so dropping the cell copies is lossless.)
const KEEP = new Set(["result.json", "stream.jsonl"]);

export function retainSession(db, session) {
  for (const cell of session.cells) {
    const dir = path.join(session.cellsDir, cell.dir);
    if (!fs.existsSync(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (KEEP.has(name)) continue;
      if (name === "stderr.log") {
        // keep only if it captured something
        try {
          if (fs.statSync(path.join(dir, name)).size > 0) continue;
        } catch {}
      }
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  // The eval/ snapshot is always-keep (it backs eval_hash + reproducibility). Strip only the
  // grader's __pycache__ for tidiness — eval_hash already ignores it, so this is purely cosmetic.
  stripPycache(path.join(session.sessionDir, "eval"));

  purgeOldStreams(db, session.id);
}

// Recursively remove __pycache__ directories under `root` (best effort).
function stripPycache(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === "__pycache__") fs.rmSync(full, { recursive: true, force: true });
    else stripPycache(full);
  }
}

// Delete stream.jsonl from sessions other than `keepSessionId`, except for cells that
// failed (their trajectory is worth keeping for debugging).
export function purgeOldStreams(db, keepSessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return 0;
  let purged = 0;
  for (const id of fs.readdirSync(SESSIONS_DIR)) {
    if (id === keepSessionId) continue;
    const cellsDir = path.join(SESSIONS_DIR, id, "cells");
    if (!fs.existsSync(cellsDir)) continue;

    const statusByCell = new Map(
      db.cellMetrics(id).map((c) => [`${c.model}__${c.condition}__${c.replicate}`, c.status])
    );

    for (const name of fs.readdirSync(cellsDir)) {
      const cell = parseCellDir(name);
      const status = statusByCell.get(`${cell.model}__${cell.condition}__${cell.replicate}`);
      if (status === "failed") continue; // keep failures' streams
      const stream = path.join(cellsDir, name, "stream.jsonl");
      if (fs.existsSync(stream)) {
        fs.rmSync(stream, { force: true });
        purged++;
      }
    }
  }
  return purged;
}
