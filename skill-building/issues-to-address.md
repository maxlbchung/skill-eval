# Issues to address — eval regimes & baseline reuse

Three connected changes that make the tester correct and cheap when **iterating a skill**
(the mutator's core loop). They share one new primitive — `eval_hash` — so build them in
order: **1 (foundation) → 2 (correct history) → 3 (cheaper runs)**.

## Background / the core idea

What you iterate is the **skill** (`skill_hash` = the SKILL.md content). What you *measure
it with* is the **regime** = `(model, eval_hash)`, where `eval_hash` hashes the whole `eval/`
folder (grader + fixtures + the build task + required/inputs — the `## Prompt` section of
`eval.md` is the build prompt and lives in `eval/`, so it's already covered).

- `skill_hash` is the **x-axis** of a trend — you *want* those points connected (the skill
  improving over versions).
- `(model, eval_hash)` is the **apparatus**. When it changes, old and new scores are not
  comparable and must **not** be pooled on the same line.

Two corollaries fall out:
- **The control depends only on `(model, eval_hash)`, not on `skill_hash`.** So re-running it
  for every skill variant is redundant — cache it per regime (Issue 3).
- **A regime change must start a new comparable group** in the history chart and trigger a
  control re-baseline (Issue 2 + 3).

**Naming decision (do NOT rename the skill).** Do *not* mint `clean-csv-v1`, `-v2` on a
test/prompt change — that versions the wrong axis and conflates "the skill changed" with "the
yardstick changed." The skill keeps one stable name; the **regime** is what gets versioned, and
only as a *derived, render-time label* (e.g. "regime 2 · tests `a1b2c3` · Opus-4.8"), never as
stored skill identity.

---

## Issue 1 — `eval_hash` + per-session `eval/` snapshot (FOUNDATION)

Hash the entire `eval/` folder into one `eval_hash`, and snapshot `eval/` per session the same
way we already snapshot the skill. The snapshot gives a **stable** hash (computed from clean
source before any run), **immutability** (a mid-run `eval/` edit can't drift from what graded),
keeps the live `eval/` clean (Python's `__pycache__` lands in the throwaway snapshot), and makes
each session reproducible.

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

## Issue 2 — Regime-segmented history chart (CORRECTNESS)

Today `drawChart` (in `scripts/webpages/app.js`) groups all of a skill's sessions by time into
one connected line — so a test/prompt/model change is silently pooled. Fix: segment by regime.

### Data
- `/api/cells` rows now carry `eval_hash` (from `cellMetricsWithSession`, Issue 1). The chart
  already has `r.skill_name`, `r.skill_hash`, `r.started_at`; add `r.eval_hash`.

### `scripts/webpages/app.js` (`drawChart` + a new control)
- After scoping `cellsData` to `selectedSkill`, compute the **distinct `eval_hash` values for
  that skill, ordered by first-seen `started_at`** → assign `regime 1, 2, …` (derived at render
  time; no storage). Model comparability is already handled by the existing model series/`mode`
  controls; the silent breaker is `eval_hash`, so segment on it.
- Add a **`regime` dropdown** to the chart controls (alongside type/model/mode/stats/metric),
  defaulting to the **current** (latest) regime, plus an "all (segmented)" option.
  - `chartState.regime` default = latest regime id.
- Default view: filter `iters` to the selected regime so every visible point is comparable.
- "all (segmented)" view: keep all iterations but **break the polyline at regime boundaries** —
  emit a separate `<polyline>` per contiguous same-`eval_hash` run (never connect across a
  boundary), draw a faint vertical divider + a label at each boundary ("tests changed").
- Caption/legend: show the active regime tag, e.g.
  `caption = "<metric> — <type> · <models> · regime <n> (tests <eval_hash[:8]>, since <date>)"`.
- Tooltip already shows `skill_name · skill_hash[:8] · when`; add `· regime <n>`.

### Optional
- Group the History **session-selector chips** by regime (a small subheading per regime) so
  picking a session for the Instance view is regime-aware too.

---

## Issue 3 — Baseline reuse: `--reuse-baseline` (COST)

The control is a function of `(model, eval_hash)`. Cache it per regime and reuse across skill
iterations: a skill run drops from `6N` builds to `3N` once a baseline exists, with a *tighter*
comparison (a well-estimated baseline shrinks the skill−control variance).

### `scripts/db.js` — baseline reader
- Add `regimeControlCells(evalHash, { maxAgeIso } = {})`: return all **control** `cell_metrics`
  rows (+ their `test_results`) from `status='complete'` sessions whose `eval_hash` matches,
  optionally filtered to `started_at >= maxAgeIso`. Group/aggregate in `metrics.js` (pool the
  replicates across the regime's sessions; the more replicates, the tighter the baseline).
- Add `regimeHasBaseline(evalHash, model, { maxAgeIso })` → boolean (used by run.js to decide).

### `scripts/run.js` — `--reuse-baseline` [+ optional `--max-baseline-age <hours>`]
- Compute `evalHash` (from prep) before launching builds.
- If `--reuse-baseline` and a fresh baseline exists for every model at `evalHash`
  (`regimeHasBaseline` per model, honoring max-age): **run skill cells only** —
  `session.cells = cells(cfg).filter(c => c.condition === "skill")`. Seed only those rows
  (don't seed control cells for this session).
- Else (no/stale baseline): run the **full matrix** this session, so the regime gets/refreshes
  its baseline. (A regime change ⇒ new `eval_hash` ⇒ no baseline ⇒ control runs automatically —
  this is the "control reruns when a new group is created" behavior, for free.)
- `builds.js`/`eval-runner.js` need no change — they iterate `session.cells`, which is now
  skill-only when reusing.

### `scripts/metrics.js` (`sessionRollup`) — fill control from the baseline
- When a session has no control cells (skill-only), build the control side of each
  `(model, condition)` comparison from `db.regimeControlCells(session.eval_hash)` aggregated per
  model (mean/spread of score, cost, steps), and tag it `fromBaseline: true`.
- The Instance/Comparison view shows skill (this session) vs control (regime baseline); surface
  a small "control: baseline (regime <n>, n=<replicates>)" note so it's clear the control wasn't
  re-run.

### Refresh triggers (already mostly automatic)
- **Regime change** (new `eval_hash`) → no baseline → control runs. ✅ automatic.
- **Model change** → not in the regime's control rows → control runs for that model. ✅
- **Provider drift** (same version id, behavior changes over weeks) is the one thing a cached
  baseline can't catch — a contemporaneous control would. Mitigate with `--max-baseline-age`
  (config `baselineMaxAgeHours`): if the newest baseline session for the regime is older than
  that, refresh (run control). For short iteration loops this is negligible.

### Statistical caveats to document in the report/UI
- Reusing a baseline makes the comparison **unpaired** (skill and control no longer run in the
  same session/conditions). It's the right trade for iteration speed, but show the baseline's
  age + replicate count so a stale/thin baseline is visible.
- **Use enough baseline replicates.** "Single baseline" means "a baseline measured with N
  replicates," not one run — otherwise the skill−control delta inherits one noisy control sample.

### Retention interaction
- A regime change forces a baseline **rebuild**, not a re-grade: `output/` is deleted after
  tests, so there's no deliverable left to re-score under the new grader. That's fine (regime
  changes are rare) — just don't expect to re-grade old control outputs.

---

## Implementation order & migration

1. **Issue 1** — `eval_hash` + `eval/` snapshot + DDL column (`ALTER TABLE` guard for existing
   DBs). Everything else depends on this. Backfill existing rows: `eval_hash` stays NULL for
   pre-change sessions; they form a single "unknown regime" — acceptable, or run `reindex` to
   compute it from each session's `eval/` snapshot (only sessions created after Issue 1 have one).
2. **Issue 2** — chart segmentation (makes history immediately correct; no run-side change).
3. **Issue 3** — `--reuse-baseline` + baseline reader + rollup fill (the cost win).

All three are **additive** (one nullable column, render-time grouping, an opt-in run flag) — no
reshape of `cell_metrics`/`test_results`, consistent with the mutation-readiness seams in
`design-v2.md §14`.
