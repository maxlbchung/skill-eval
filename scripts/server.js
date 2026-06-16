// The one web app's server (design §10). Serves the static single-page app from webpages/ plus a
// small JSON API. Everything — including live state — is now derived from files + the DB, so ONE
// long-lived server shows every concurrent run and all history. /api/live(/:id) projects the live
// view from each session's stream.jsonl + .pid marker; the rest query the DB. Started by the first
// `run.js` (and reused by later concurrent runs), or standalone via `node server.js`.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, DB_PATH, DEFAULT_CONFIG_PATH, SESSIONS_DIR, cellDirName, replicateWidth } from "./config.js";
import { openDb } from "./db.js";
import { liveSessions, liveSnapshot } from "./live.js";
import { sessionRollup, overTime } from "./metrics.js";
import { reconcileAbandoned } from "./reindex.js";

const WEB_DIR = fileURLToPath(new URL("./webpages/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.join(WEB_DIR, rel);
  // contain within WEB_DIR (no traversal)
  if (!path.resolve(full).startsWith(path.resolve(WEB_DIR))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // no-store so the dev UI (app.js/app.css/index.html) is never served stale from cache
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}

// Per-cell error logs (design: files are ground truth — the DB only knows status='failed').
// For each failed run of a session, read the on-disk log files written by the supervisor /
// test runner. Each file is clipped (head + tail) so a huge log can't bloat the response.
const ERR_LOG_FILES = [
  { key: "failed", file: ".failed" },        // terminal marker — the short failure reason
  { key: "eval", file: "eval.log" },         // test/ingest failure: message + runner stdout/stderr
  { key: "stderr", file: "stderr.log" },     // build process stderr + supervisor fatals
  { key: "supervisor", file: "supervisor.log" }, // supervisor's own phase log
];
const MAX_LOG = 8000;

function readLogClipped(full, max = MAX_LOG) {
  let s;
  try {
    s = fs.readFileSync(full, "utf-8");
  } catch {
    return null; // missing file is normal (not every failure writes every log)
  }
  if (s.trim() === "") return null;
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n\n…[${s.length - max} chars truncated]…\n\n` + s.slice(s.length - half);
}

function sessionErrors(db, cfg, id) {
  const session = db.getSession(id);
  if (!session) return null;
  const width = replicateWidth(cfg.matrix.replicates);
  const cellsDir = path.join(SESSIONS_DIR, id, "cells");
  const failed = db.cellMetrics(id).filter((c) => c.status === "failed");
  const modelOrder = (m) => { const i = cfg.matrix.models.indexOf(m); return i === -1 ? 1e9 : i; };
  const runs = failed
    .map((c) => {
      const dir = cellDirName({ model: c.model, condition: c.condition, replicate: c.replicate }, width);
      const logs = {};
      for (const { key, file } of ERR_LOG_FILES) {
        const txt = readLogClipped(path.join(cellsDir, dir, file));
        if (txt != null) logs[key] = txt;
      }
      const firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
      // .failed often holds just the exit code; fall back to a meaningful log line in that case
      let reason = firstLine(logs.failed);
      if (!reason || /^\d+$/.test(reason)) reason = firstLine(logs.eval) || (reason ? `exited ${reason}` : firstLine(logs.stderr));
      return { model: c.model, condition: c.condition, replicate: c.replicate, dir, reason, logs };
    })
    .sort((a, b) => modelOrder(a.model) - modelOrder(b.model) || a.condition.localeCompare(b.condition) || a.replicate - b.replicate);
  return { sessionId: id, failedCount: runs.length, runs };
}

async function handle(req, res, db, cfg) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "bad url" });
  }
  const p = decodeURIComponent(url.pathname);

  try {
    if (p === "/api/health") {
      // run.js probes this to decide whether to reuse an already-running server.
      return sendJson(res, 200, { ok: true, service: "skill-eval" });
    }
    if (p === "/api/live") {
      // the sessions running right now (file-derived) — the Live tab's run-picker list.
      return sendJson(res, 200, { sessions: liveSessions(db) });
    }
    const liveMatch = p.match(/^\/api\/live\/(.+)$/);
    if (liveMatch) {
      const snap = await liveSnapshot(db, cfg, liveMatch[1]); // p is already decoded
      return snap ? sendJson(res, 200, snap) : sendJson(res, 404, { error: "no such session" });
    }
    if (p === "/api/sessions") {
      return sendJson(res, 200, db.listSessions());
    }
    if (p === "/api/session/latest") {
      const latest = db.latestSession();
      return sendJson(res, 200, latest ? sessionRollup(db, cfg, latest.id) : null);
    }
    const errMatch = p.match(/^\/api\/session\/(.+)\/errors$/);
    if (errMatch) {
      const out = sessionErrors(db, cfg, errMatch[1]);
      return out ? sendJson(res, 200, out) : sendJson(res, 404, { error: "no such session" });
    }
    if (p.startsWith("/api/session/")) {
      const id = p.slice("/api/session/".length);
      const roll = sessionRollup(db, cfg, id);
      return roll ? sendJson(res, 200, roll) : sendJson(res, 404, { error: "no such session" });
    }
    if (p === "/api/metric") {
      const name = url.searchParams.get("name") || "score";
      return sendJson(res, 200, overTime(db, cfg, name));
    }
    if (p === "/api/cells") {
      // raw per-cell rows joined to their session — the chart aggregates these client-side.
      return sendJson(res, 200, db.cellMetricsWithSession());
    }
    if (p === "/api/config") {
      return sendJson(res, 200, { models: cfg.matrix.models, conditions: cfg.matrix.conditions, replicates: cfg.matrix.replicates, pricing: cfg.pricing });
    }
    if (p.startsWith("/api/")) {
      return sendJson(res, 404, { error: "unknown endpoint" });
    }
    return serveStatic(res, p);
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message || err) });
  }
}

// Bind `server` to startPort, or the next free port if it's taken (EADDRINUSE). Resolves
// with the actual port, so concurrent runs each get their own server instead of the second
// one crashing on the shared default port.
function listenWithFallback(server, startPort, maxTries = 64) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let tries = 0;
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && ++tries < maxTries) {
        server.listen(++port); // try the next port on the same server
      } else {
        cleanup();
        reject(err);
      }
    };
    const onListening = () => {
      cleanup();
      resolve(server.address().port);
    };
    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(port);
  });
}

// Returns { server, port }. port may differ from cfg.port if it was busy. One server now serves
// every session — live (file-derived) and historical — so there's no per-session server to start.
export async function startServer(db, cfg) {
  const server = http.createServer((req, res) => handle(req, res, db, cfg));
  const port = await listenWithFallback(server, cfg.port);
  return { server, port };
}

// Standalone: serve history over a DB (default index.db; --db <path> to override).
if (process.argv[1] && path.basename(process.argv[1]) === "server.js") {
  const cfg = loadConfig(DEFAULT_CONFIG_PATH);
  const i = process.argv.indexOf("--db");
  const dbPath = i !== -1 ? process.argv[i + 1] : DB_PATH;
  const db = openDb(dbPath);
  const recovered = await reconcileAbandoned(db);
  if (recovered.length) console.log(`recovered ${recovered.length} abandoned session(s): ${recovered.join(", ")}`);
  const { port } = await startServer(db, cfg);
  console.log(`skill-eval report server on http://localhost:${port}  (db: ${dbPath})${port !== cfg.port ? ` — config port ${cfg.port} was busy` : ""}`);
}
