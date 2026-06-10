// Session prep (design §5, §7 step 1). Creates an immutable, timestamped session
// directory, snapshots the skill (minus the eval harness + scratch — so the skill
// cells can never read the answer key), assembles the two prompts to disk, lays out
// the 6N cell dirs (skill cells get a ./skill/ copy), and seeds the DB rows.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, cells as cellList, isEvalExcluded } from "./config.js";
import { skillName, parseEvalMd, assemblePrompts, findEvalDoc } from "./prompts.js";

// Excluded from the skill snapshot + hash: the eval harness holds the truth/answer
// key (must never reach a skill cell), and these are non-shipping scaffolding.
const SNAPSHOT_EXCLUDE = new Set(["eval", "skill-building", ".git", "node_modules"]);

// Exclude predicates over a relative path's segments, one per snapshot.
const skillExclude = (parts) => SNAPSHOT_EXCLUDE.has(parts[0]) || parts.some((p) => p === ".git" || p === "node_modules");
const evalExclude = (parts) => isEvalExcluded(parts);

const TESTER_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;

// Windows-safe, lexically sortable session timestamp: 2026-06-08T13-59-00
export function sessionTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

// Copy a tree, dropping any path for which `shouldExclude(relParts)` is true. The two snapshots
// (skill/ and eval/) share this with different predicates.
function copyTree(src, dest, shouldExclude = () => false) {
  const root = path.resolve(src);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(root, path.resolve(s));
      if (!rel) return true;
      return !shouldExclude(rel.split(path.sep));
    },
  });
}

function walkFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) acc.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return acc;
}

// Content hash of a directory tree: sorted relpath + bytes. Stable across platforms.
export function hashTree(dir) {
  const h = crypto.createHash("sha256");
  for (const rel of walkFiles(dir).sort()) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

// Content hash of the eval/ tree (grader + fixtures + eval.md), ignoring generated/scratch
// files (EVAL_EXCLUDE, *.pyc/*.pyo, and any run-declared output names). This is eval_hash —
// the apparatus axis. The exclude keeps it stable even after the grader runs from the snapshot
// and drops __pycache__ there. Same digest scheme as hashTree, so it's directly comparable.
export function hashEvalDir(dir, extraNames = null) {
  const h = crypto.createHash("sha256");
  for (const rel of walkFiles(dir).sort()) {
    if (isEvalExcluded(rel.split("/"), extraNames)) continue;
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

// db: an open Db (db.js). Returns the session descriptor used by later phases.
export function prepareSession(db, cfg, skillDir, opts = {}) {
  if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
    throw new Error(`no SKILL.md in skill dir: ${skillDir}`);
  }
  // Pre-check the live eval contract before creating a session dir (fail fast). The session
  // grades against a SNAPSHOT of eval/ taken below, not this live folder.
  const liveEvalDir = path.join(skillDir, "eval");
  if (!findEvalDoc(liveEvalDir)) {
    throw new Error(`target skill has no eval/eval.md (the test contract) in ${liveEvalDir}`);
  }

  const name = skillName(skillDir);
  const id = `${opts.timestamp ?? sessionTimestamp()}__${name}`;
  const sessionDir = path.join(SESSIONS_DIR, id);
  if (fs.existsSync(sessionDir)) throw new Error(`session dir already exists: ${sessionDir}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  // Liveness marker: lets a later startup tell a crashed run (this PID gone) from one
  // still actively running in another process. Removed at finalize.
  fs.writeFileSync(path.join(sessionDir, ".pid"), String(process.pid));

  // 1. Snapshot the skill (excludes eval/) → skill/ ; hash = skill_hash (mutation seam).
  const snapshotDir = path.join(sessionDir, "skill");
  copyTree(skillDir, snapshotDir, skillExclude);
  const skillHash = hashTree(snapshotDir);

  // 1b. Snapshot the eval harness (grader + fixtures + eval.md) → eval/ ; hash = eval_hash —
  //     the apparatus axis (Issue 1). This is the answer key: it lives ONLY here, is read by the
  //     test runner from session.evalDir, and is NEVER copied into a cell.
  const evalSnapshot = path.join(sessionDir, "eval");
  copyTree(liveEvalDir, evalSnapshot, evalExclude);
  const evalMdPath = findEvalDoc(evalSnapshot);
  const evalSpec = parseEvalMd(evalMdPath);
  let evalHash = hashEvalDir(evalSnapshot, new Set(evalSpec.required || []));
  // A --prompt/--prompt-file override bypasses eval.md's prompt, so fold it into eval_hash: an
  // ad-hoc task is its own regime and must never pool with the eval.md-derived one.
  if (opts.promptOverride) {
    evalHash = crypto.createHash("sha256").update(evalHash).update("\0").update(opts.promptOverride).digest("hex");
  }

  // 2. Assemble the two prompts from the IMMUTABLE snapshots (skill body from skill/, input
  //    fixtures from eval/); write → prompts/ ; read the bytes back (load-bearing: builds launch
  //    from these exact bytes, so the kept artifact can't drift).
  const assembled = assemblePrompts({ skillDir: snapshotDir, evalDir: evalSnapshot, evalSpec, promptOverride: opts.promptOverride });
  const promptsDir = path.join(sessionDir, "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, "skill.md"), assembled.skill);
  fs.writeFileSync(path.join(promptsDir, "control.md"), assembled.control);
  const promptText = {
    skill: fs.readFileSync(path.join(promptsDir, "skill.md"), "utf-8"),
    control: fs.readFileSync(path.join(promptsDir, "control.md"), "utf-8"),
  };
  const promptHash = crypto
    .createHash("sha256")
    .update(promptText.skill)
    .update("\0")
    .update(promptText.control)
    .digest("hex");

  // 2b. Baseline-reuse decision (Issue 3). The control depends only on (model, eval_hash), so if a
  //     fresh control baseline already exists we run SKILL cells only for that model and reuse the
  //     cached control. --full-matrix forces the full paired matrix. A regime change yields a new
  //     eval_hash with no baseline → control runs automatically. Decisions are per-model.
  const prevRegime = db.latestRegimeInfo(name); // the previous apparatus, before this session exists
  const regimeChanged = prevRegime?.evalHash != null && prevRegime.evalHash !== evalHash;
  const reuseModels = new Set();
  if (!opts.fullMatrix) {
    for (const model of cfg.matrix.models) {
      if (db.regimeHasBaseline(evalHash, model, { maxAgeIso: opts.baselineMaxAgeIso })) reuseModels.add(model);
    }
  }

  // 3. Lay out cell dirs. Skill cells get a per-cell ./skill/ copy (in their cwd);
  //    control cells get none — isolation is structural, no --add-dir, no leak. A control cell is
  //    omitted entirely for a model whose control is reused from the cached baseline.
  const all = cellList(cfg).filter((c) => c.condition !== "control" || !reuseModels.has(c.model));
  const cellsDir = path.join(sessionDir, "cells");
  for (const c of all) {
    const cellDir = path.join(cellsDir, c.dir);
    fs.mkdirSync(cellDir, { recursive: true });
    c.dirPath = cellDir;
    c.promptFile = path.join(promptsDir, `${c.condition}.md`);
    if (c.condition === "skill") copyTree(snapshotDir, path.join(cellDir, "skill"));
  }

  // 4. DB: session(running) + seed 6N pending cells.
  db.insertSession({
    id,
    skill_name: name,
    skill_hash: skillHash,
    eval_hash: evalHash,
    prompt_hash: promptHash,
    status: "running",
    started_at: new Date().toISOString(),
    tester_version: TESTER_VERSION,
    schema_version: cfg.schemaVersion,
  });
  db.seedCells(id, all);

  return {
    id,
    sessionDir,
    cellsDir,
    skillDir,
    evalDir: evalSnapshot,
    skillName: name,
    skillHash,
    evalHash,
    promptHash,
    evalSpec,
    cells: all,
    reuse: {
      fullMatrix: !!opts.fullMatrix,
      reuseModels: [...reuseModels],
      regimeChanged,
      prevEvalHash: prevRegime?.evalHash ?? null,
      prevModels: prevRegime?.models ?? [],
    },
    testerVersion: TESTER_VERSION,
  };
}
