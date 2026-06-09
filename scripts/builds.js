// Build scheduler (design §3, §7 step 3). Launches one supervisor child per cell, up
// to config.concurrency at a time. When a supervisor exits, parses that cell's
// stream.jsonl ONCE and writes the four token counts + steps to cell_metrics (the
// build-end boundary write). The orchestrator process owns the DB; supervisors never do.
// `hooks` lets the live channel observe phase transitions (no DB involvement).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseStreamMetrics } from "./stream-metrics.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("./supervisor.js", import.meta.url));

function spawnSupervisor({ cellDir, promptFile, model, maxTurns }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_PATH,
        "--cell-dir",
        cellDir,
        "--prompt-file",
        promptFile,
        "--model",
        model,
        "--max-turns",
        String(maxTurns),
      ],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function runOneBuild(db, session, cfg, cell, hooks) {
  const cellDir = path.join(session.cellsDir, cell.dir);
  const promptFile = path.join(session.sessionDir, "prompts", `${cell.condition}.md`);
  hooks.onBuildStart?.(cell, cellDir);

  await spawnSupervisor({ cellDir, promptFile, model: cell.model, maxTurns: cfg.maxTurns });

  const metrics = await parseStreamMetrics(path.join(cellDir, "stream.jsonl"));
  const failed = fs.existsSync(path.join(cellDir, ".failed")) || metrics.failed || !metrics.resultSeen;
  const status = failed ? "failed" : "pending"; // 'pending' = built OK, tests still owed
  db.writeBuildMetrics(session.id, cell, metrics, status);

  hooks.onBuildEnd?.(cell, { status, metrics });
  return { cell, status, metrics };
}

// Runs all cells through the build phase, capped at cfg.concurrency. Resolves when
// every cell has settled (built or failed).
export async function runBuilds(db, session, cfg, hooks = {}) {
  const cells = session.cells;
  const limit = Math.max(1, cfg.concurrency);
  const results = [];
  let next = 0;
  let active = 0;

  return new Promise((resolve) => {
    const pump = () => {
      if (next >= cells.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && next < cells.length) {
        const cell = cells[next++];
        active++;
        runOneBuild(db, session, cfg, cell, hooks)
          .then((r) => results.push(r))
          .catch((err) => results.push({ cell, status: "failed", error: String(err) }))
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    pump();
  });
}
