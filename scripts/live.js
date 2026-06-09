// The ephemeral live channel (design §6, §7.2). Lives ONLY in server memory; never
// persisted. Build-phase tokens/steps are derived by tailing each cell's stream.jsonl;
// the test phase has no stream, so its only signal is status:testing + a startedAt
// anchor. Elapsed is computed client-side. If the server restarts, this is re-derivable
// by re-tailing the append-only feeds.

import fs from "node:fs";
import path from "node:path";
import { parseStreamMetrics } from "./stream-metrics.js";

function tokensOf(m) {
  if (!m) return null;
  return { input: m.input, cacheCreation: m.cacheCreation, cacheRead: m.cacheRead, output: m.output };
}

export function createLiveChannel(session) {
  const cells = new Map();
  for (const c of session.cells) {
    cells.set(c.dir, {
      model: c.model,
      condition: c.condition,
      replicate: c.replicate,
      status: "pending", // pending | building | built | testing | done | failed
      startedAt: null,
      streamPath: path.join(session.cellsDir, c.dir, "stream.jsonl"),
      tokens: null,
      steps: 0,
    });
  }
  const cache = new Map(); // dir -> { size, metrics }
  let ended = false;

  const patch = (cell, p) => {
    const s = cells.get(cell.dir);
    if (s) Object.assign(s, p);
  };

  async function liveParse(dir, streamPath) {
    let size = 0;
    try {
      size = fs.statSync(streamPath).size;
    } catch {
      return null;
    }
    const cached = cache.get(dir);
    if (cached && cached.size === size) return cached.metrics;
    const metrics = await parseStreamMetrics(streamPath);
    cache.set(dir, { size, metrics });
    return metrics;
  }

  return {
    onBuildStart: (cell) => patch(cell, { status: "building", startedAt: Date.now() }),
    onBuildEnd: (cell, { status, metrics }) =>
      patch(cell, {
        status: status === "failed" ? "failed" : "built",
        tokens: tokensOf(metrics),
        steps: metrics?.steps ?? 0,
      }),
    onTestStart: (cell) => patch(cell, { status: "testing", startedAt: Date.now() }),
    onTestEnd: (cell, outcome) => patch(cell, { status: outcome.status === "complete" ? "done" : "failed" }),
    onSessionEnd: () => {
      ended = true;
    },

    async snapshot() {
      const out = [];
      for (const [dir, s] of cells) {
        let { tokens, steps } = s;
        if (s.status === "building") {
          const live = await liveParse(dir, s.streamPath);
          if (live) {
            tokens = tokensOf(live);
            steps = live.steps;
          }
        }
        out.push({
          model: s.model,
          condition: s.condition,
          replicate: s.replicate,
          status: s.status,
          startedAt: s.startedAt,
          tokens,
          steps,
        });
      }
      return { sessionId: session.id, skill: session.skillName, ended, cells: out };
    },
  };
}
