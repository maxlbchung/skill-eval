# Issues to address — eval regimes & baseline reuse

Four connected changes that make the tester correct and cheap when **iterating a skill**
(the mutator's core loop). They share one new primitive — `eval_hash` — so build them in
order: **1 (foundation) → 2 (correct history) → 3 (cheaper runs) → 4 (operating procedure)**.

## Background / the core idea

What you iterate is the **skill** (`skill_hash` = the SKILL.md content). What you *measure
it with* is the **apparatus**, and the apparatus has three parts that each break comparability:

1. `eval_hash` — hashes the whole `eval/` folder (grader + fixtures + the build task +
   required/inputs — the `## Prompt` section of `eval.md` is the build prompt and lives in
   `eval/`, so it's already covered).
2. the **model**.
3. the **control epoch** — *which* control measurement the skill was scored against. The same
   `(model, eval_hash)` can be measured more than once over time (a staleness refresh), and the
   provider can drift between measurements, so each measurement is its own apparatus snapshot.

So the full grouping key is **`(model, eval_hash, control_epoch)`**. A new comparable group
starts when *any* of the three changes: edit the tests, change the model, **or re-measure the
control**.

- `skill_hash` is the **x-axis** of a trend — you *want* those points connected (the skill
  improving over versions) *within one group*.
- The apparatus is everything else. When it changes, old and new scores are not comparable and
  must **not** be pooled, connected, or share a chart axis.

**The control is the last fresh control run — not a pool over all history.** Within one
`(model, eval_hash)` the *only* reason control re-runs is a staleness refresh, and a refresh
**supersedes** the stale baseline; it never averages with it (that would re-mix exactly the
data the refresh exists to discard — making `--max-baseline-age` pointless). Pooling applies
*only* across control runs that are **both** inside the freshness window (e.g. two full-matrix
sessions back-to-back) — there it's a legit tighter estimate. In the normal loop there is
exactly **one** control run per regime, so "the baseline" is literally that one run.

Corollaries:
- **The control depends only on `(model, eval_hash)` + when it was last measured, never on
  `skill_hash`.** So re-running it for every skill variant is redundant — reuse it (Issue 3).
  **Reuse is the default, auto-detected** — not an opt-in flag.
- **A control change (test edit / model change / refresh) starts a new group** that must never
  share a chart axis with another group (Issue 2: faceted panels), and triggers a re-baseline
  (Issues 3 + 4).
- **Within a group, control is a flat horizontal reference, never a step.** By construction a
  group has one `eval_hash`, one model, one control measurement — so the only thing that moves
  is the skill series. A control that "moved" means the apparatus changed, which means a *new
  group*, not a step on the same line.

**Naming decision (do NOT rename the skill).** Do *not* mint `clean-csv-v1`, `-v2` on a
test/prompt change — that versions the wrong axis and conflates "the skill changed" with "the
yardstick changed." The skill keeps one stable name; the **regime/group** is what gets
versioned, and only as a *derived, render-time label* (e.g. "regime 2 · tests `a1b2c3` ·
control 2026-06-08 · Opus-4.8"), never as stored skill identity.

---

## Issue 1 — `eval_hash` + per-session `eval/` snapshot (FOUNDATION)

Hash the entire `eval/` folder into one `eval_hash`, and snapshot `eval/` per session the same
way we already snapshot the skill. The snapshot gives a **stable** hash (computed from clean
source before any run), **immutability** (a mid-run `eval/` edit can't drift from what graded),
keeps the live `eval/` clean (Python's `__pycache__` lands in the throwaway snapshot), and makes
each session reproducible.

> `eval_hash` is the apparatus axis stored on each session. The **control epoch** (the third
> part of the group key) is *derived at render time* from which sessions actually ran control —
> see Issue 2 — so it needs no new column.

### `scripts/config.js`
- Add a generated-file ignore set and an eval hasher:
  ```js
  export const EVAL_EXCLUDE = new Set(["__pycache__", ".DS_Store", "Thumbs.db"]);
  // also skip by extension: .pyc .pyo
  ```
- Export `hashEvalDir(dir)` — like `hashTree` in session.js but skipping `EVAL_EXCLUDE` dirs,
  `*.pyc/*.pyo`, and any file matching the runner's declared output (e.g. a stray `results.json`).
  Computing the hash with the exclude (not just at copy time) guarantees stability even if
  `__pycache__` later appears in the snapshot.

### `scripts/session.js` (`prepareSession`)
- After the skill snapshot, **snapshot `eval/`**: copy `skillDir/eval` → `sessionDir/eval/`
  using a `copyTree` filter that drops `EVAL_EXCLUDE` + `*.pyc/*.pyo`. (Generalize the existing
  `copyTree(src, dest)` to take an optional `exclude` predicate; reuse it for both snapshots.)
- `const evalSnapshot = path.join(sessionDir, "eval");`
- `const evalHash = hashEvalDir(evalSnapshot);`
- **Point everything downstream at the snapshot, not the live folder:**
  - `findEvalDoc(evalSnapshot)` instead of `findEvalDoc(skillDir/eval)`.
  - `parseEvalMd(<snapshot eval.md>)`.
  - `assemblePrompts(...)` must read `inputs` from the snapshot — **refactor `assemblePrompts`
    to accept `evalDir` explicitly** instead of deriving `path.join(skillDir,"eval")` inside
    `buildTaskBlock`. Pass `evalSnapshot`.
  - Set `session.evalDir = evalSnapshot` (the test runner already spawns from `session.evalDir`).
  - Read `skillName`/`skillBody` from the **skill snapshot** (`sessionDir/skill`) for the same
    immutability guarantee (optional but consistent).
- **`--prompt`/`--prompt-file` override:** the override bypasses `eval.md`, so fold it into the
  regime — `evalHash = sha256(evalHash + "\0" + promptOverride)` when an override is set, so an
  ad-hoc task is its own regime.
- Pass `eval_hash: evalHash` into `db.insertSession(...)`.
- Confirm the model still never sees `eval/`: cell `./skill/` copies come from the **skill**
  snapshot (which already excludes `eval/`); the `eval/` snapshot lives only at `sessionDir/eval`
  and is used by the runner. Do not copy it into cells.

### `scripts/eval-runner.js`
- No change needed if `session.evalDir` now points at the snapshot — `spawnRunner(runner,
  [outputDir, resultPath], session.evalDir)` will run the grader from the snapshot, so
  `__pycache__` is created there (throwaway), not in the live skill folder.

### `scripts/db.js`
- DDL: add `eval_hash TEXT` to `sessions` (nullable → existing rows stay valid; new rows set it).
  `CREATE TABLE IF NOT EXISTS` won't alter an existing table, so also run a one-time
  `ALTER TABLE sessions ADD COLUMN eval_hash TEXT` guarded by a check (catch/ignore if it exists).
- `insertSession(s)`: include `eval_hash`.
- `cellMetricsWithSession()`: add `s.eval_hash` to the SELECT (the chart + baseline need it):
  ```sql
  SELECT cm.*, s.skill_name, s.skill_hash, s.eval_hash, s.started_at
    FROM cell_metrics cm JOIN sessions s ON s.id = cm.session_id
   WHERE s.status = 'complete'
  ```

### `scripts/retention.js`
- Keep `sessionDir/eval/` forever (same always-keep tier as `skill/` + `prompts/` — it backs
  `eval_hash` and reproducibility). Optionally strip `eval/**/__pycache__` for tidiness; the
  hash already ignores it.

### `scripts/reindex.js`
- Optional, for full files-are-truth recovery: recompute `eval_hash` via `hashEvalDir(
  sessionDir/eval)` and `UPDATE sessions SET eval_hash` so the DB is rebuildable from files. Use
  the same exclude so the value matches the prep-time hash.

### Notes
- `eval_hash` subsumes the earlier idea of a separate `control_prompt_hash` (the control prompt
  is fully derived from `eval/`). `prompt_hash` can stay as-is; it's no longer needed for
  grouping.
- Whole-folder hashing is deliberately **conservative**: a cosmetic edit (reformatting
  `score.py`, editing scoring prose) starts a new regime + re-baseline even though nothing
  meaningful changed. That's *safe* (it never pools incomparable data) and far simpler than
  hashing only "semantic" bytes. Accept it.

---

## Issue 2 — Regime-faceted history (CORRECTNESS)

Today `drawChart` (in `scripts/webpages/app.js`) pools all of a skill's sessions into one
connected line. Two problems: (a) a test/model/control change is silently pooled; (b) even
*segmenting* on one shared time-axis (the earlier "break the polyline + vertical divider" idea)
still puts incomparable y-values on **one y-axis**, inviting eyeball comparison across the
break. **Fix: facet into one panel per group; within a panel the control is a flat line.**

### Group key (render-time, derived — no storage)
- Per model series, group by **`(eval_hash, control_epoch)`**.
- Derive `control_epoch` from the data: within an `eval_hash`, order sessions by `started_at`;
  **each session that actually ran control opens a new epoch**; a skill-only session attaches to
  the **most recent prior control epoch**. (Sessions with NULL `eval_hash` from before Issue 1
  collapse into a single "unknown" group.)
- Assign human labels `regime 1, 2, …` by first-seen `started_at` (render-time only, no rename
  of skill identity).

### Data
- `/api/cells` rows now carry `eval_hash` (from `cellMetricsWithSession`, Issue 1). The chart
  already has `r.skill_name`, `r.skill_hash`, `r.started_at`; add `r.eval_hash`. Which sessions
  ran control is visible from the rows (a session with `condition='control'` cells = a control
  epoch).

### Rendering — faceted small-multiples (replaces single-axis segmentation)
- **One panel per group**, time-ordered left→right. Default: the **current** (latest) group
  rendered full-size; older groups as smaller panels you can click to expand. A **`regime`
  dropdown** still lets you pin a single group, plus an "all (faceted)" overview.
- **Each panel has its own y-axis** — never share a scale across groups. The gap between panels
  *is* the boundary; there are **no** connecting lines, dividers, or shared axes between them.
- **Control inside a panel = a horizontal reference line** (the baseline mean) with a shaded
  ±sd band across the panel's x-span. Sessions where control was *actually measured* get a solid
  marker (provenance); skill-only sessions inherit the line. The control never steps within a
  panel — a moved control is a new panel.
- **Skill = the moving polyline.** `difference` type = skill − control(flat) per iteration;
  it's unpaired, so the baseline's variance propagates into the difference band.
- Label each panel: `regime n · tests <eval_hash[:8]> · control <date> · <models>`.
- Tooltip already shows `skill_name · skill_hash[:8] · when`; add `· regime n`.

### Optional
- Group the History **session-selector chips** by panel/regime (a small subheading per group) so
  picking a session for the Instance view is regime-aware too.

---

## Issue 3 — Baseline reuse (COST) — default, with refresh control

**Reuse is the default, auto-detected.** The control is a function of `(model, eval_hash)`;
once a fresh baseline exists, run **skill cells only** (`6N → 3N`), with a *tighter* comparison
(a well-estimated baseline shrinks the skill−control variance). The opt-*out* is `--full-matrix`.

### `scripts/run.js` — auto-reuse decision + flags
- Compute `evalHash` (from prep) before launching builds, and detect the latest stored regime
  for this skill (for the change-announcement in Issue 4).
- **Per selected model**, decide:
  - A **fresh** baseline exists at `evalHash` (`regimeHasBaseline` per model, honoring
    freshness) → reuse it; **run skill cells only** for that model.
  - No / stale baseline → run that model's **full matrix** this session (establishes/refreshes
    the baseline). A regime change ⇒ new `eval_hash` ⇒ no baseline ⇒ control runs automatically.
  - Mixed is fine and per-model: e.g. an added model with no baseline runs full-matrix while
    the others reuse → one session can be skill-only for some models, full for others.
  - Build `session.cells` from the union of per-model decisions
    (`cells(cfg).filter(...)`); **seed only the rows that will run** (don't seed control cells
    that are being reused).
- **"fresh"** = the newest control-bearing session for the regime is from **today** (same
  calendar day). The day-boundary is the human-facing trigger (Issue 4 asks the user);
  `baselineMaxAgeHours` (config) is the **headless fallback** for non-interactive runs.
- Flags:
  - `--full-matrix` — force the full paired matrix (refresh the baseline and/or get a
    contemporaneous *paired* delta). **Replaces** the old `--reuse-baseline` (reuse is now the
    default; this is the opt-out).
  - `--replicates <n>` — override `matrix.replicates` for this run (the interactive replicate
    answer from Issue 4 maps straight to this flag).
- `builds.js`/`eval-runner.js` need no change — they iterate `session.cells`, which is now the
  reduced set when reusing.

### `scripts/db.js` — baseline reader (last fresh run, not pool-everything)
- `regimeBaseline(evalHash, model, { maxAgeIso } = {})`: return the **most recent fresh**
  control-bearing session's control `cell_metrics` (+ their `test_results`) for
  `(model, eval_hash)` — i.e. **the last control run**, not a pool over all history. If two
  control runs fall **both** inside the freshness window, pool *those* (more replicates =
  tighter); **never** pool across a staleness boundary.
- `regimeHasBaseline(evalHash, model, { maxAgeIso })` → boolean (used by run.js).
- (This supersedes the earlier `regimeControlCells` "pool all sessions in the regime" sketch,
  which contradicted the staleness/refresh semantics.)

### `scripts/metrics.js` (`sessionRollup`) — fill control from the baseline
- When a session has no control cells for a model (skill-only), build the control side of that
  `(model, condition)` comparison from `db.regimeBaseline(session.eval_hash, model)` aggregated
  (mean/spread of score, cost, steps), and tag it `fromBaseline: true` with `{ epoch, n, age }`.
- The Instance/Comparison view shows skill (this session) vs control (baseline). Badge it
  **per-(model, condition)** so a mixed session reads correctly:
  `control: baseline · regime <n> · n=<replicates> · age <…>`.

### Statistical caveats to surface in the report/UI
- Reusing a baseline makes the comparison **unpaired** (skill and control no longer run in the
  same session/conditions). It's the right trade for iteration speed, but show the baseline's
  **age + replicate count** so a stale/thin baseline is visible.
- **Use enough baseline replicates.** "Baseline" means "a control measured with N replicates,"
  not one run — otherwise the skill−control delta inherits one noisy control sample. (The *last
  control run* is itself N replicates; this is what makes "last run" and "well-estimated"
  compatible.)

### Retention interaction
- A refresh / regime change forces a baseline **rebuild**, not a re-grade: `output/` is deleted
  after tests, so there's no deliverable left to re-score under a new grader. That's fine
  (refreshes are rare) — just don't expect to re-grade old control outputs.

---

## Issue 4 — Baseline lifecycle & operating procedure (the agent's `AskUserQuestion`)

This is behavior of the **agent operating the skill** (codified in SKILL.md), not the Node
scripts. Before each run the agent (a) decides the baseline posture, (b) asks the user the two
decisions that are genuinely theirs via **one `AskUserQuestion` call**, and (c) *announces* any
automatic re-baseline. The split is deliberate:

> **Inform, don't ask, for a correctness change. Ask for a judgment call.**
> A **regime change** (tests or model changed) re-baselines **automatically** and is only
> *announced* — it's mandatory for comparability (and a new `eval_hash` has no baseline anyway).
> A **day-boundary** refresh is a judgment call about provider drift, so it's *asked*.

### Detection (agent reads it from the DB / run.js prep before launching)
- **Regime change** — the computed `eval_hash` or the model set differs from the latest stored
  regime for this skill. → **Automatic `--full-matrix` re-baseline. Do NOT ask. Inform** the
  user, e.g. *"Tests/model changed (new regime) — running a fresh control baseline this
  session (the old baseline isn't comparable)."*
- **New day, same regime** — a fresh baseline exists, but its newest control run is from an
  **earlier calendar day** than today. → **Ask** (question 1 below).
- **Same day, same regime** — reuse silently (skill-only). No baseline question; the replicate
  question (question 2) is still asked at run start.

### The `AskUserQuestion` call (one call, up to two questions)
1. **(only when "new day, same regime")** — *"Your control baseline is from `<date>`
   (`<n>` replicates). Provider behavior can drift across days. Re-run the control baseline
   today?"*
   - **Reuse `<date>` baseline (Recommended)** — keep the cached control; run skill-only.
   - **Refresh baseline now** — maps to `--full-matrix` (re-measures control today; a *new
     control epoch* ⇒ a new comparable group in History, Issue 2).
2. **(always, at run start)** — *"How many replicates per cell for this run?"*
   - **3 (Recommended)** / **5** / **10** / Other → maps to `--replicates <n>`.

Then the agent invokes:
`node scripts/run.js --skill-dir <…> --replicates <n> [--full-matrix]`

### SKILL.md changes
- Add an **"Operating procedure"** section that codifies the detection + the single
  `AskUserQuestion` call + the inform-don't-ask rule, so the operating agent runs it **every
  time** (not just when it remembers to).
- Add `--replicates <n>` and `--full-matrix` to the flags list in §2, and note that reuse is the
  default (control is not re-run every session).

---

## Implementation order & migration

1. **Issue 1** — `eval_hash` + `eval/` snapshot + DDL column (`ALTER TABLE` guard for existing
   DBs). Everything else depends on this. Backfill: `eval_hash` stays NULL for pre-change
   sessions; they form a single "unknown regime" — acceptable, or run `reindex` to compute it
   from each session's `eval/` snapshot (only sessions created after Issue 1 have one).
2. **Issue 2** — faceted history (makes history immediately correct; no run-side change). The
   `control_epoch` grouping is render-time and needs no new storage.
3. **Issue 3** — auto-reuse (default) + `regimeBaseline` reader + rollup fill + `--full-matrix` /
   `--replicates` (the cost win).
4. **Issue 4** — SKILL.md operating procedure + the thin run.js regime-change detection/print.
   Depends on 1 (`eval_hash`) and 3 (baseline reader + flags).

Issues 1–3 are **additive** (one nullable column, render-time grouping, default-on reuse with an
opt-out flag) — no reshape of `cell_metrics`/`test_results`, consistent with the
mutation-readiness seams in `design-v2.md §14`. Issue 4 is a SKILL.md/agent change plus one
informational log line.
