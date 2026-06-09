// Session prep (design §5, §7 step 1). Creates an immutable, timestamped session
// directory, snapshots the skill (minus the eval harness + scratch — so the skill
// cells can never read the answer key), assembles the two prompts to disk, lays out
// the 6N cell dirs (skill cells get a ./skill/ copy), and seeds the DB rows.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, cells as cellList } from "./config.js";
import { skillName, parseEvalMd, assemblePrompts, findEvalDoc } from "./prompts.js";

// Excluded from the skill snapshot + hash: the eval harness holds the truth/answer
// key (must never reach a skill cell), and these are non-shipping scaffolding.
const SNAPSHOT_EXCLUDE = new Set(["eval", "skill-building", ".git", "node_modules"]);

const TESTER_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;

// Windows-safe, lexically sortable session timestamp: 2026-06-08T13-59-00
export function sessionTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

function copyTree(src, dest) {
  const root = path.resolve(src);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(root, path.resolve(s));
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (SNAPSHOT_EXCLUDE.has(parts[0])) return false;
      return !parts.some((p) => p === ".git" || p === "node_modules");
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

// db: an open Db (db.js). Returns the session descriptor used by later phases.
export function prepareSession(db, cfg, skillDir, opts = {}) {
  if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
    throw new Error(`no SKILL.md in skill dir: ${skillDir}`);
  }
  const evalDir = path.join(skillDir, "eval");
  const evalMdPath = findEvalDoc(evalDir);
  if (!evalMdPath) {
    throw new Error(`target skill has no eval/eval.md (the test contract) in ${evalDir}`);
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
  copyTree(skillDir, snapshotDir);
  const skillHash = hashTree(snapshotDir);

  // 2. Assemble the two prompts; write → prompts/ ; read the bytes back (load-bearing:
  //    builds launch from these exact bytes, so the kept artifact can't drift).
  const evalSpec = parseEvalMd(evalMdPath);
  const assembled = assemblePrompts({ skillDir, evalSpec, promptOverride: opts.promptOverride });
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

  // 3. Lay out cell dirs. Skill cells get a per-cell ./skill/ copy (in their cwd);
  //    control cells get none — isolation is structural, no --add-dir, no leak.
  const all = cellList(cfg);
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
    evalDir,
    skillName: name,
    skillHash,
    promptHash,
    evalSpec,
    cells: all,
    testerVersion: TESTER_VERSION,
  };
}
