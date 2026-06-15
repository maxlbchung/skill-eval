// Assembles the two build prompts for a session (design §2, §8). The model is a
// CLI flag, not part of the prompt, so there are only ever TWO texts per session:
//   skill.md   — embeds the SKILL.md body verbatim (what the harness injects in
//                production) + points at ./skill/ for supporting files + the task.
//   control.md — the task only (required output names / element IDs); no skill.
// The build task, input fixtures, required outputs, and the runner command all
// come from the target skill's eval/eval.md (a small, harness-owned contract doc).

import fs from "node:fs";
import path from "node:path";

// Split a leading `--- ... ---` frontmatter block from the body. Tolerates BOM/CRLF.
export function splitFrontmatter(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: "", body: text };
  return { fm: m[1], body: m[2] };
}

export function frontmatterName(fm, fallback) {
  const m = /^name:\s*(.+?)\s*$/m.exec(fm);
  return m ? m[1].trim() : fallback;
}

export function skillName(skillDir) {
  const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  return frontmatterName(splitFrontmatter(text).fm, path.basename(skillDir));
}

export function skillBody(skillDir) {
  const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
  return splitFrontmatter(text).body.trim();
}

// Locate the eval contract doc case-insensitively (eval.md / EVAL.md) so it resolves
// on both case-sensitive and case-insensitive filesystems.
export function findEvalDoc(evalDir) {
  if (!fs.existsSync(evalDir)) return null;
  const match = fs.readdirSync(evalDir).find((f) => /^eval\.md$/i.test(f));
  return match ? path.join(evalDir, match) : null;
}

// The build prompt is the section under a "## Prompt" (or "# Prompt" / "Build Prompt")
// heading, bounded by the next heading at the same-or-higher level. Extracting only
// this section lets the contract doc ALSO carry human scoring prose without that prose
// leaking into the model's prompt. Returns null if there is no such section.
function extractPromptSection(body) {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(?:build\s+)?prompt\s*$/i.exec(lines[i].trim());
    if (m) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const h = /^(#{1,6})\s+/.exec(lines[i]);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim() || null;
}

// eval.md frontmatter values are JSON (zero-dep, unambiguous), e.g.
//   runner: ["python", "run-eval.py"]
//   required: ["cleaned.csv"]
//   inputs: ["original.csv"]
// The build prompt is the "## Prompt" section of the body, falling back to the whole
// body for a greenfield doc whose body is nothing but the prompt.
export function parseEvalMd(evalMdPath) {
  const text = fs.readFileSync(evalMdPath, "utf-8");
  const { fm, body } = splitFrontmatter(text);
  const spec = { runner: null, required: [], inputs: [], elements: [] };
  for (const line of fm.split(/\r?\n/)) {
    const mm = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (!mm) continue;
    let value = mm[2].trim();
    try {
      value = JSON.parse(value);
    } catch {
      /* keep raw string */
    }
    spec[mm[1]] = value;
  }
  if (!Array.isArray(spec.runner) || spec.runner.length === 0 || spec.runner.some((x) => typeof x !== "string")) {
    throw new Error(`eval.md frontmatter must set runner to a non-empty string array, e.g. runner: ["python","run-eval.py"]`);
  }
  for (const k of ["required", "inputs", "elements"]) {
    if (spec[k] == null) spec[k] = [];
    else if (!Array.isArray(spec[k])) spec[k] = [spec[k]];
  }
  const fmPrompt = typeof spec.prompt === "string" ? spec.prompt.trim() : "";
  spec.prompt = fmPrompt || extractPromptSection(body) || body.trim();
  if (!spec.prompt) throw new Error("eval.md must contain a build prompt (a '## Prompt' section, or a prompt body)");
  return spec;
}

function buildTaskBlock(spec) {
  const out = [`# Task\n\n${spec.prompt}\n`];

  if (spec.inputs.length) {
    // Inputs are delivered as real files in the cell's cwd (session.js), not inlined — the author
    // decides what's a file (eval.md `inputs`) vs what's prose (the `## Prompt`). The prompt only
    // names them, so a large fixture doesn't bloat the prompt or get framed as pasted text.
    const list = spec.inputs.map((f) => "`" + f + "`").join(", ");
    const one = spec.inputs.length === 1;
    out.push(
      `\n## Input files\n\nThe input ${one ? "file is" : "files are"} in your current working ` +
        `directory — read ${one ? "it" : "them"} as needed: ${list}.\n`
    );
  }

  if (spec.required.length || spec.elements.length) {
    out.push(`\n## Required output\n`);
    if (spec.required.length === 1) {
      out.push(
        `\nWrite your result to \`output/${spec.required[0]}\` (relative to your current working directory). Create the \`output/\` directory if it does not exist.\n`
      );
    } else if (spec.required.length > 1) {
      const list = spec.required.map((f) => "`" + f + "`").join(", ");
      out.push(
        `\nWrite your deliverables into the \`output/\` directory (relative to your current working directory): ${list}. Create \`output/\` if it does not exist.\n`
      );
    }
    if (spec.elements.length) {
      const ids = spec.elements.map((e) => "`" + e + "`").join(", ");
      out.push(`\nThe output must include these element IDs: ${ids}.\n`);
    }
  }
  return out.join("");
}

// Returns { skill, control } prompt texts. `skillDir` is passed explicitly so the caller can point
// it at the immutable per-session skill/ snapshot rather than the live source — guaranteeing the
// kept prompts can't drift from what actually graded. (Input files are delivered to each cell's
// cwd by session.js; the prompt only names them, so it no longer reads the eval/ dir.)
export function assemblePrompts({ skillDir, evalSpec, promptOverride }) {
  const spec = promptOverride ? { ...evalSpec, prompt: promptOverride } : evalSpec;
  const task = buildTaskBlock(spec);

  const control = `${task}\n`;
  const skill =
    `${skillBody(skillDir)}\n\n` +
    `---\n\n` +
    `The files bundled with this skill are available in \`./skill/\` — read them as needed.\n\n` +
    `${task}\n`;

  return { skill, control };
}
