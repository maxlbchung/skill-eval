// Per-cell build supervisor (design §3, §7). One of these runs per cell, spawned by
// builds.js. It runs a single `claude -p` build inside the cell's own cwd and produces
// FILES ONLY — stream.jsonl (the feed), stderr.log, supervisor.log, and a terminal
// .done/.failed marker. It never touches the DB and writes no shared results file, so
// there is no lock contention (the orchestrator parses stream.jsonl once at build-end).
//
// Differences from v1's run-claude-build.js: no --add-dir (skill cells already carry a
// ./skill/ copy in cwd; control cells get nothing — isolation is structural), no
// results.json / updateBuildFromStream / file-lock, and the model is the full version
// string passed straight through (no label→id mapping).
//
// Usage:
//   node supervisor.js --cell-dir <dir> --prompt-file <path> --model <id> [--max-turns 50]

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseStreamMetrics } from "./stream-metrics.js";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}

const cellDir = flag("--cell-dir");
const promptFile = flag("--prompt-file");
const model = flag("--model");
const maxTurns = flag("--max-turns", "50");
const progressMs = Number(flag("--progress-ms", "2000"));
const resultGraceMs = Number(flag("--result-grace-ms", "8000"));

// A test/ops seam: point at a fake or alternate claude binary without changing code.
const CLAUDE_BIN = process.env.SKILL_EVAL_CLAUDE_BIN || "claude";

if (!cellDir || !promptFile || !model) {
  console.error("Usage: node supervisor.js --cell-dir <dir> --prompt-file <path> --model <id> [--max-turns 50]");
  process.exit(2);
}

const streamPath = path.join(cellDir, "stream.jsonl");
const stderrPath = path.join(cellDir, "stderr.log");
const supervisorLog = path.join(cellDir, "supervisor.log");
const donePath = path.join(cellDir, ".done");
const failedPath = path.join(cellDir, ".failed");

function log(msg) {
  try {
    fs.appendFileSync(supervisorLog, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

let settled = false;
let finished = false;
let sawSuccessfulResultAt = null;
let timer = null;
let child = null;

// A supervisor crash must never leave the orchestrator waiting forever: write a
// terminal marker no matter what.
function handleFatal(err) {
  if (settled) return;
  settled = true;
  const reason = err?.stack || err?.message || String(err);
  log(`FATAL ${reason}`);
  try {
    fs.appendFileSync(stderrPath, `\n[supervisor fatal] ${reason}\n`);
  } catch {}
  try {
    fs.writeFileSync(failedPath, String(reason).slice(0, 1000));
  } catch {}
  try {
    fs.writeFileSync(donePath, "");
  } catch {}
  process.exit(1);
}
process.on("uncaughtException", handleFatal);
process.on("unhandledRejection", handleFatal);

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function closeFd(fd) {
  try {
    fs.closeSync(fd);
  } catch {}
}

let stdoutFd = null;
let stderrFd = null;

async function finish(state, exitCode, { terminateChild = false } = {}) {
  if (finished) return;
  finished = true;
  settled = true;
  if (timer) clearInterval(timer);
  if (terminateChild && child) terminateProcessTree(child.pid);
  closeFd(stdoutFd);
  closeFd(stderrFd);
  if (state !== "complete") {
    try {
      fs.writeFileSync(failedPath, String(exitCode ?? state));
    } catch {}
  }
  fs.writeFileSync(donePath, "");
  log(`finish state=${state} exitCode=${exitCode}`);
  process.exit(exitCode ?? (state === "complete" ? 0 : 1));
}

function main() {
  if (!fs.existsSync(promptFile)) handleFatal(new Error(`prompt file not found: ${promptFile}`));
  fs.mkdirSync(cellDir, { recursive: true });
  fs.rmSync(donePath, { force: true });
  fs.rmSync(failedPath, { force: true });
  fs.writeFileSync(streamPath, "");
  fs.writeFileSync(stderrPath, "");

  const prompt = fs.readFileSync(promptFile, "utf-8");
  stdoutFd = fs.openSync(streamPath, "a");
  stderrFd = fs.openSync(stderrPath, "a");

  // A Node-based runner (test fake or alternate) is run under node; a real binary
  // (claude.exe) is spawned directly.
  let bin = CLAUDE_BIN;
  let preArgs = [];
  if (/\.(mjs|cjs|js)$/i.test(CLAUDE_BIN)) {
    bin = process.execPath;
    preArgs = [CLAUDE_BIN];
  }

  log(`spawn ${bin} model=${model} maxTurns=${maxTurns} cwd=${cellDir}`);
  child = spawn(
    bin,
    [
      ...preArgs,
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--disable-slash-commands",
      "--max-turns",
      String(maxTurns),
      "--dangerously-skip-permissions",
    ],
    { cwd: cellDir, stdio: ["ignore", stdoutFd, stderrFd], windowsHide: true }
  );

  timer = setInterval(async () => {
    try {
      const m = await parseStreamMetrics(streamPath);
      if (m.resultSeen && !m.failed) {
        sawSuccessfulResultAt ??= Date.now();
        const grace = Number.isFinite(resultGraceMs) && resultGraceMs >= 0 ? resultGraceMs : 8000;
        if (Date.now() - sawSuccessfulResultAt >= grace) {
          log("result seen + grace elapsed → finishing complete");
          await finish("complete", 0, { terminateChild: true });
        }
      }
    } catch {}
  }, Number.isFinite(progressMs) && progressMs > 0 ? progressMs : 2000);

  child.on("error", async (error) => {
    try {
      fs.appendFileSync(stderrPath, `\n${error.stack || error.message}\n`);
    } catch {}
    log(`child error ${error.message}`);
    await finish("failed", 1);
  });

  child.on("exit", async (code) => {
    log(`child exit code=${code}`);
    await finish(code === 0 ? "complete" : "failed", code ?? 1);
  });
}

main();
