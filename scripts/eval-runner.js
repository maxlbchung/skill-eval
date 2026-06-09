// Test phase (design §7 step 4, §8). For each cell that built OK, spawn the skill's
// declared runner with two positional paths — `<output-dir> <result-path>` — from the
// skill's own eval/ dir, then STRICTLY ingest the result.json it writes. The harness
// learns no metric semantics; it only ingests {name, score∈[0,1]}. Tests run sequentially.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Strict parse of a contract result.json. Throws (→ fail the cell, never clamp) on any
// malformed/missing/NaN/out-of-range score or duplicate name. Returns [{name, score}].
export function validateResultJson(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`result.json is not valid JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("result.json must be a JSON object");
  if (!Number.isFinite(obj.schemaVersion)) throw new Error("result.json is missing a numeric schemaVersion");
  if (!Array.isArray(obj.tests)) throw new Error("result.json is missing a tests array");
  if (obj.tests.length === 0) throw new Error("result.json tests array is empty");

  const seen = new Set();
  const tests = [];
  for (const t of obj.tests) {
    if (!t || typeof t !== "object") throw new Error("each test must be an object");
    if (typeof t.name !== "string" || !t.name.trim()) throw new Error("each test needs a non-empty string name");
    if (seen.has(t.name)) throw new Error(`duplicate test name: ${t.name}`);
    seen.add(t.name);
    if (typeof t.score !== "number" || !Number.isFinite(t.score)) {
      throw new Error(`test "${t.name}" score must be a finite number`);
    }
    if (t.score < 0 || t.score > 1) throw new Error(`test "${t.name}" score ${t.score} is outside [0,1]`);
    tests.push({ name: t.name, score: t.score });
  }
  return tests;
}

function spawnRunner(runner, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(runner[0], [...runner.slice(1), ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out, err }));
    child.on("error", (e) => resolve({ code: 1, out, err: `${err}\n${e.message}` }));
  });
}

// buildResults: the array from runBuilds (cells with status 'pending' built OK).
export async function runTests(db, session, cfg, buildResults, hooks = {}) {
  const builtOk = new Map(buildResults.map((r) => [r.cell.dir, r.status]));
  const outcomes = [];

  for (const cell of session.cells) {
    if (builtOk.get(cell.dir) !== "pending") {
      outcomes.push({ cell, status: "failed", reason: "build failed — test skipped" });
      continue; // DB status already 'failed' from build-end
    }

    const cellDir = path.join(session.cellsDir, cell.dir);
    const outputDir = path.join(cellDir, "output");
    const resultPath = path.join(cellDir, "result.json");

    hooks.onTestStart?.(cell, cellDir);
    const { code, out, err } = await spawnRunner(session.evalSpec.runner, [outputDir, resultPath], session.evalDir);

    let outcome;
    try {
      if (!fs.existsSync(resultPath)) {
        throw new Error(`runner exited ${code} without writing result.json`);
      }
      const tests = validateResultJson(fs.readFileSync(resultPath, "utf-8"));
      const { scoreSum, total } = db.ingestTests(session.id, cell, tests);
      outcome = { cell, status: "complete", scoreSum, total };
    } catch (e) {
      try {
        fs.appendFileSync(
          path.join(cellDir, "eval.log"),
          `[ingest failed] ${e.message}\n--- runner exit ${code} ---\n--- stdout ---\n${out}\n--- stderr ---\n${err}\n`
        );
      } catch {}
      db.setCellStatus(session.id, cell, "failed");
      outcome = { cell, status: "failed", reason: e.message };
    }

    hooks.onTestEnd?.(cell, outcome);
    outcomes.push(outcome);
  }

  return outcomes;
}
