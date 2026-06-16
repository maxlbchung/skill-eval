# Skill Tester v3 — Task Suites, Public Benchmarks & the Mutation Loop

An **additive extension of [design-v2](./design-v2.md)**. v2 evaluates one skill against **one
task** (`eval/eval.md` → one build prompt, one populated cwd, one grader) across the
`model × condition × replicate` grid. v3 generalizes that single task into a **task suite** — N
tasks per session — so the tester can be driven by public benchmarks like **SWE-bench**, and so a
**mutator** can select on a *train* suite and prove meaningfulness on a disjoint *test* suite.

Everything here is a superset of v2: every existing skill, the fake-skill seed, and every stored
row keep working unchanged (a legacy `eval.md` is just a one-task suite, id `default`). v3 reshapes
nothing — it adds one identity axis, one DB column, one populate primitive, and generalizes the
baseline-reuse key from per-regime to per-task.

> Read v2 first. This doc assumes its vocabulary: `skill_hash`, `eval_hash`, the regime/baseline
> machinery, COST/EFFORT, the `result.json` contract, and the §-references below point at **v2**
> unless prefixed `v3 §`.

---

## Table of contents

1. [Why v3 — the circularity a public benchmark fixes](#1-why-v3)
2. [The two roles a benchmark plays (and the wall between them)](#2-two-roles)
3. [The core change: `task` is the 4th identity axis](#3-task-axis)
4. [Contract refactor: `eval/` becomes a task suite](#4-contract)
5. [Database schema (additive, one rebuild)](#5-schema)
6. [Per-task baseline reuse — the load-bearing seam](#6-baseline-reuse)
7. [Directory layout & data flow deltas](#7-layout)
8. [The SWE-bench adapter](#8-swebench)
9. [Mutation design spec](#9-mutation)
10. [Dashboard & reporting deltas](#10-dashboard)
11. [Configuration deltas](#11-config)
12. [Implementation sequencing](#12-sequencing)
13. [Invariants & rules (v3 additions)](#13-invariants)
14. [What v3 deliberately does NOT change](#14-non-changes)

---

## 1. Why v3 — the circularity a public benchmark fixes <a id="1-why-v3"></a>

v2's `run-eval` is **author-written**: the same person writes the skill *and* the test. That is fine
for measuring a fixed skill, but the moment a **mutator** selects against that test, the loop
Goodharts — it optimizes the skill to *your* checks, not to the underlying capability. A skill that
"improves" on a self-authored eval may be a test-specific artifact with no transferable value.

A public benchmark (SWE-bench, etc.) breaks the circle by supplying an **external task universe the
author did not write** and, crucially, a **held-out split the mutator never selects on**. The
benchmark's job is not to produce a leaderboard number — it is to expose the **generalization gap**:

```
   Δ_select  = skill − control   on the suite the mutator optimized   (train)
   Δ_holdout = skill − control   on a disjoint suite it never saw      (test)

   Δ_select ≈ Δ_holdout  > 0   →  the skill captured transferable capability   ✅
   Δ_select ≫ Δ_holdout ≈ 0    →  the mutator overfit to the train tasks       ❌  (artifact)
```

That gap is the meaningfulness proof. v3 is the storage + loop shape that makes it cheap to produce.

---

## 2. The two roles a benchmark plays (and the wall between them) <a id="2-two-roles"></a>

A benchmark is used **twice**, and the two uses must never touch:

| Role | Where it lives | Cadence | Who reads it |
|------|----------------|---------|--------------|
| **Selection signal** (fitness) | *inside* the eval→mutate loop | every generation | the mutator |
| **Held-out validation** | *outside* the loop | champions only | you — never the mutator's selection step |

The wall is enforced **at the query layer, not in storage**: storage records *every* task in *both*
splits identically; the mutator's selection query filters `WHERE split='train'`. If selection ever
reads a `test` row, the held-out number is just training accuracy with a costume on.

**The claim is the delta, not the leaderboard rank.** Report within-session `skill − control` with a
confidence interval. The delta cancels two confounds an absolute SWE-bench number cannot:

- **Contamination** — SWE-bench instances predate model cutoffs and are partly memorized; that
  inflates *both* arms equally, so it largely cancels in `skill − control`. Treat absolute resolve
  rates as suspect; treat the delta as the signal.
- **Scaffold** — a leaderboard number is "model + scaffold." v2's structural isolation already holds
  the scaffold fixed between `skill` and `control`, so the delta isolates *skill content*.

Use a published baseline only as a **harness sanity check**: if `control` resolve rate is wildly off
the known model number, the scaffold is broken and is the confound — fix that before trusting deltas.

---

## 3. The core change: `task` is the 4th identity axis <a id="3-task-axis"></a>

A **cell is one build solving one task** — one `claude -p` session, one populated cwd, one grader
run. `task` slots in as a 4th identity axis, *above* the existing `name` (the within-task test list):

```
   v2 cell identity:   model × condition × replicate
   v3 cell identity:   model × condition × task × replicate

   cell_metrics PK:    (session_id, model, condition, task, replicate)
   test_results PK:    (session_id, model, condition, task, replicate, name)
   cell dir:           <model>__<condition>__<task>__<replicate>
```

```
              SKILL                         CONTROL
        ┌───────────────────────┬───────────────────────┐
  OPUS  │ task₀ rep 00..N-1     │ task₀ rep 00..N-1     │
        │ task₁ rep 00..N-1     │ task₁ rep 00..N-1     │   each (model,condition) now spans
        │ …                     │ …                     │   T tasks × N replicates instead of
        │ task_{T-1} rep 00..   │ task_{T-1} rep 00..   │   just N — "tasks per replicate"
        ├───────────────────────┼───────────────────────┤
 SONNET │ …                     │ …                     │
        └───────────────────────┴───────────────────────┘   cells per session = M × 2 × T × N
```

- A session evaluates **one skill version against one suite**. That is exactly the unit a mutator
  selects on, which is why `task` belongs *inside* the session, not as a separate session per task.
- `task` ids are **`__`-free** (validated at suite load) so `parseCellDir` can split from the right:
  `replicate` (last), `task`, `condition`, and `model` = the remaining left segments — the same
  right-split rule v2 already uses, extended by one segment.
- Per-task and per-suite roll-ups (resolve rate over tasks, mean over replicates) stay **query-time**
  derivations over the cell rows — never stored, same rule as COST/EFFORT and the v2 replicate
  roll-up. There are now **two** axes to average over (`task`, `replicate`); both are query-time.

**Rejected alternative — "task = its own session."** Zero PK migration (each per-task session keeps
v2's `eval_hash`/baseline verbatim), but it explodes `sessions` T× per generation, duplicates the
`skill/` snapshot + `prompts/` + `eval/` per task, and needs a `suite_run_id` grouping column
anyway. The selection unit then becomes T sessions instead of one. Chosen the 4-axis model; the
price is a one-time table rebuild (§5).

---

## 4. Contract refactor: `eval/` becomes a task suite <a id="4-contract"></a>

A suite is a **strict superset** of the v2 contract. If `eval/` has no suite manifest, the existing
`eval.md` is treated as a **one-task suite with id `default`** — every current skill is unchanged.

```
<target-skill>/eval/
├── suite.md            # frontmatter: name, split ("train"|"test"|"dev"), runner, provision (optional)
│                       #   body: shared human scoring prose (never reaches the model)
├── tasks.jsonl         # one row per task: { id, prompt, inputs?, required?, elements? }
├── run-eval            # the shared grader — now: run-eval <task-id> <cell-cwd> <result-path>
└── fixtures/<task-id>/ # OPTIONAL per-task static input files (the v2 copy path, scoped per task)
```

Three changes, each a superset of v2 §8:

1. **The runner gains a leading `task-id` and receives the cell cwd.** v2: `run-eval <output-dir>
   <result-path>`. v3: `run-eval <task-id> <cell-cwd> <result-path>`. The runner resolves the
   **deliverable** itself — greenfield skills keep the `output/` convention (`<cwd>/output`);
   SWE-bench's runner takes `git -C <cwd> diff` as the patch. The deliverable is no longer assumed
   to be `output/`; that assumption was the one thing blocking benchmarks whose answer is a tree
   mutation rather than a fresh file. Greenfield runners get a one-line shim (ignore `task-id`, read
   `<cwd>/output`).

2. **A `provision` hook — the one genuinely new primitive.** v2 populates a cell only by *copying*
   declared `inputs`. A benchmark task often needs a *generated* cwd (a repo at `base_commit`). When
   `suite.md` declares `provision: ["python","provision.py"]`, the harness invokes
   `provision <task-id> <cell-cwd>` during cell prep to materialize the populated dir. `inputs`
   (static copy) and `provision` (generated) are the two ways to populate a cell; a task may use
   either or both. The answer key still lives only in `eval/` and is never provisioned into a cell.

3. **`prompts/` becomes per-task.** Each task has its own `# Task` block, so prompts are written to
   `prompts/<task-id>/{skill,control}.md`. The skill **body is constant across tasks** (same skill);
   only the task block differs — so it is still "2 prompt texts × T tasks," never multiplied by
   models. `prompt_hash` = hash over all of them.

**`task.prompt`, `task.inputs`, `task.required`, `task.elements`** mirror the fields `parseEvalMd`
already extracts (`prompts.js`) — `tasks.jsonl` just carries one such spec per row instead of one per
`eval.md`. `assemblePrompts` is called once per task with that row's spec.

---

## 5. Database schema (additive, one rebuild) <a id="5-schema"></a>

Bump `schemaVersion` **1 → 2**. New DBs get the new DDL; existing DBs run a one-time migration that
**rebuilds the two metric tables** (SQLite `ALTER TABLE` cannot add a column to a `PRIMARY KEY`):

```sql
-- migration v1 → v2 (idempotent, files-are-truth so reindex can also rebuild):
--   CREATE cell_metrics_v2 (… task TEXT NOT NULL DEFAULT 'default' …, PK incl. task)
--   INSERT INTO cell_metrics_v2 SELECT …, 'default' AS task, … FROM cell_metrics
--   DROP cell_metrics; ALTER cell_metrics_v2 RENAME TO cell_metrics    -- same for test_results
```

```sql
CREATE TABLE cell_metrics (
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  model                 TEXT NOT NULL,
  condition             TEXT NOT NULL,
  task                  TEXT NOT NULL,          -- NEW 4th identity axis; legacy rows = 'default'
  replicate             INTEGER NOT NULL,
  score_sum             REAL,                   -- per-cell (= per-task-instance) Σ scores
  total                 INTEGER,
  input_tokens          INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  output_tokens         INTEGER,
  steps                 INTEGER,
  status                TEXT,
  PRIMARY KEY (session_id, model, condition, task, replicate)
);

CREATE TABLE test_results (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model      TEXT NOT NULL,
  condition  TEXT NOT NULL,
  task       TEXT NOT NULL,                      -- NEW
  replicate  INTEGER NOT NULL,
  name       TEXT NOT NULL,                       -- within-task test identity (unchanged role)
  score      REAL NOT NULL,
  PRIMARY KEY (session_id, model, condition, task, replicate, name)
);

-- sessions: three new columns + a repurpose
ALTER TABLE sessions ADD COLUMN parent_hash TEXT; -- NEW mutation-lineage seam: the skill_hash this
                                                  --   session's skill was mutated FROM; NULL for a
                                                  --   hand-authored / root skill. A plain column add
                                                  --   (NOT a PK change) → a simple idempotent ALTER,
                                                  --   exactly like eval_hash. Recorded from day one so
                                                  --   lineage accretes before the mutator exists;
                                                  --   variants (§9) later normalizes it.
ALTER TABLE sessions ADD COLUMN suite_id TEXT;    -- e.g. "swebench-lite"
ALTER TABLE sessions ADD COLUMN split    TEXT;    -- "train" | "test" | "dev"  (the held-out wall)
--   sessions.eval_hash is REPURPOSED as the SUITE hash = hash(sorted task_hashes). The
--   session-level "is this the same apparatus / regime change" check stays session-level; the
--   finer per-task grain lives in session_tasks below.

-- new: the per-task apparatus identity that control-reuse keys on
CREATE TABLE session_tasks (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task       TEXT NOT NULL,
  task_hash  TEXT NOT NULL,        -- hash(this task's prompt + inputs/provision spec + grader bytes)
  PRIMARY KEY (session_id, task)
);

CREATE INDEX IF NOT EXISTS idx_cell_metrics_task ON cell_metrics(session_id, task);
CREATE INDEX IF NOT EXISTS idx_test_results_task ON test_results(session_id, task);
```

**Backfill is trivial and meaning-preserving:** every legacy row → `task='default'`; the legacy
`eval_hash` becomes the lone `task_hash` of a one-task suite (`suite_id=NULL`, `split=NULL`);
`parent_hash=NULL` (every pre-mutation skill is a root). No row's meaning changes — the same §14
additivity property the mutator tables already rely on.

**Why `parent_hash` lives on `sessions` now, not only in `variants` later.** It sits right beside
`skill_hash` — the existing mutation seam — so a session can record *both* the variant it evaluated
(`skill_hash`) and the variant it descended from (`parent_hash`) from day one, with no `variants`
table yet. Lineage therefore accretes in the immutable session log itself; when the mutator lands,
`variants` is a normalized projection of facts already on disk, not a new source of truth. This is
the same move v2 made with `skill_hash`: lay the seam as an additive column long before the machinery
that consumes it.

`score_sum`/`total` keep their v2 meaning **per cell** (now per task-instance). The suite-level
resolve rate is `mean over (task × replicate) of (score_sum/total)` — a query-time roll-up in
`metrics.js`, never stored.

---

## 6. Per-task baseline reuse — the load-bearing seam <a id="6-baseline-reuse"></a>

v2's killer property: control depends only on `(model, eval_hash)`, never on `skill_hash`, so a new
skill variant reuses cached control and pays only for skill cells (`session.js` reuse decision,
`db.regimeBaseline`). v3 **generalizes the key from per-regime to per-task**:

```
   v2 baseline key:   (model, eval_hash)          -- one regime per session
   v3 baseline key:   (model, task_hash)          -- one per task in the suite
```

This is what makes benchmark-scale mutation affordable:

| Action | task_hashes affected | What actually re-runs |
|--------|----------------------|------------------------|
| **Mutate the skill** (new `skill_hash`) | none | **only skill cells** — 100% control reuse across the whole suite |
| **Add a benchmark instance** | one new task_hash | control for the *new task only*; every existing baseline untouched |
| **Edit one task's grader/prompt** | that one task_hash | that task's control re-measures; the rest reuse |

A mutator generation of **K** children over **T** tasks × **M** models × **N** replicates costs
**K × (skill cells only)** — control is paid once per `(model, task_hash)` and amortized across every
variant that ever runs that suite. Critically, **adding a task does not invalidate the suite's
existing baselines** — exactly the property "append an instance to swebench-train" requires.

`session.js` deltas:
- The reuse decision loops over `(model, task)` pairs (was: over `model`); `db.regimeBaseline`/
  `regimeHasBaseline` take `task_hash` instead of `eval_hash`.
- `seedCells` seeds `control` cells only for `(model, task)` pairs lacking a fresh baseline; `skill`
  cells are always seeded for every `(model, task, replicate)`.
- `session_tasks` is written at prep so reindex can rebuild the reuse keys from files.

---

## 7. Directory layout & data flow deltas <a id="7-layout"></a>

```
data/sessions/2026-…__<skill>/
├── skill/                       # unchanged — one snapshot per session (skill is task-independent)
├── eval/                        # snapshot of the suite (manifest + tasks.jsonl + grader + fixtures);
│                                #   the answer key — never copied into a cell
├── prompts/
│   └── <task-id>/{skill,control}.md     # NEW: per-task prompts (skill body constant, task block varies)
└── cells/
    └── <model>__<condition>__<task>__<replicate>/
        ├── skill/               # skill cells only (unchanged)
        ├── <provisioned cwd>    # NEW: provision <task-id> <cwd> populated this (or static inputs/)
        ├── stream.jsonl         # build feed (unchanged)
        ├── result.json          # grader output for THIS task (unchanged shape)
        └── output/              # greenfield deliverable convention; SWE-bench uses git diff instead
```

Orchestration (v2 §7.1) is unchanged in shape — prep → build (≤concurrency) → test → finalize →
reindex → retention — only the cell *count* grows by T× and prep gains the provision + per-task
prompt/baseline steps. The concurrency cap still applies across the full `M × 2 × T × N` cell set.

Retention (v2 §9) is unchanged per cell, but per-session disk now scales in **T × N**: the
purge-old-`stream.jsonl` and always-delete-the-provisioned-cwd policies matter more. SWE-bench's
provisioned repos are large → delete with `output/` after tests, same always-delete rule.

---

## 8. The SWE-bench adapter <a id="8-swebench"></a>

A thin adapter that **implements the §4 contract** — no special-casing in the harness.

| Contract piece | SWE-bench implementation |
|----------------|---------------------------|
| `tasks.jsonl` | one row per instance from the HF dataset: `{ id: instance_id, prompt: problem_statement }`. The **two SWE-bench datasets → two suites** (`swebench-…-train`, `swebench-…-test`) → the `split` column. The train/test split already exists upstream. |
| `provision <id> <cwd>` | clone-from-cache + `git checkout base_commit` into `<cwd>` (or `docker cp` out of the instance image). Deliverable = the mutated tree. |
| `run-eval <id> <cwd> <result>` | apply `git -C <cwd> diff` + the instance `test_patch` in the instance's Docker image; run `FAIL_TO_PASS` + `PASS_TO_PASS`; write `result.json`. |
| `result.json` score | **partial credit**: `score = fraction(FAIL_TO_PASS now passing)`, **gated to 0 if any `PASS_TO_PASS` regresses**. One test entry per instance (or one per FAIL_TO_PASS subtest). |

Two adapter properties that matter for the loop:

- **Continuous score feeds the §v2-14 gradient seam.** Binary resolved/unresolved gives selection a
  staircase where most mutations move the mean by exactly zero; the FAIL_TO_PASS fraction gives
  gradient on every eval, so non-inferiority tests converge with far fewer replicates.
- **Control = "same scaffold, no skill."** `claude -p` over the same provisioned repo + issue prompt
  with no `./skill/` — structurally isolated exactly as v2. The headline stays the within-session
  `skill − control` delta (§2), not an absolute resolve rate.

**Cost discipline (log what you drop):** the full Verified set × 2 conditions × M models × N
replicates × an agentic build is enormous and Docker-heavy. Use a **stratified train slice** (by
repo + difficulty) for selection and a **disjoint held-out slice** for validation; run the test
suite **only on promotion candidates** (§9). If a slice subsamples the dataset, `log()` it — a
stratified subsample reads as "ran SWE-bench" when it did not.

---

## 9. Mutation design spec <a id="9-mutation"></a>

This is where v2 §14's *"mutation-readiness (deferred)"* lands. Nothing here was built in v1/v2, and
the point is unchanged: adding it is **additive** — new tables, new columns, a new directory, never a
reshape of what already ships. v3 carries the tester to the very edge of the mutator (the
`parent_hash`, `task_hash`, and `split` seams), so the mutator itself becomes a purely additive layer.

```
   PHASE 1: TESTER (v2)                  files + index.db
   ┌──────────────────────────────────┐  sessions · cell_metrics · test_results
   │ one skill × one task × the grid  │
   └──────────────┬───────────────────┘   add a column + an axis, no reshape
                  ▼
   PHASE 2: SUITE + SPLIT (v3 tester)    same DB + task axis, suite_id/split,
   ┌──────────────────────────────────┐  session_tasks, sessions.parent_hash
   │ one skill × a SUITE × the grid;  │  (lineage captured per session, before any mutator)
   │ train/test wall; per-task reuse  │
   └──────────────┬───────────────────┘   add tables + genomes/
                  ▼
   PHASE 3: MUTATOR
   ┌──────────────────────────────────┐  + variants(hash PK, parent_hash, generation,
   │ select → mutate → eval → promote │            mutation_op, seed, created_at)
   │ — the eval→mutate loop           │  + queue(variant_hash, suite_id, status, …)
   └──────────────────────────────────┘  + genomes/<hash>/   (content-addressed skills)
                                          sessions.skill_hash → variants.hash (FK)
```

**The seams that make the mutator additive** (v2's two, plus v3's three):

1. **`skill_hash` on every session** (v2) — the content hash of the evaluated skill. Today it is just
   the evaluated skill; later, mutated variants get their own hashes.
2. **`parent_hash` on every session** (v3, NEW — §5) — the `skill_hash` this session's skill was
   mutated *from*; `NULL` for a hand-authored / root skill. Recorded as a plain column from day one,
   so **lineage accretes before the mutator exists** and `variants` later just normalizes it. This is
   the edge a recursive-CTE lineage walk follows (`child.parent_hash = parent.skill_hash`).
3. **Immutable, append-only sessions** (v2) — the population accretes; nothing is overwritten. Within
   one session the N replicates — and now the T tasks (§3) — give a variance estimate per skill
   version; across sessions, repeat evals of the same `skill_hash` accrete on top. Both feed the
   noise-averaging the mutator's selection needs, so it averages out LLM noise instead of chasing a
   single run.
4. **`task_hash` per task** (v3 — §6) — per-task control reuse: a child variant reuses the parent's
   control across the whole suite and pays only for skill cells. The efficiency seam that makes a
   generation affordable at benchmark scale.
5. **`split` per session** (v3 — §2) — the held-out wall: selection reads `train`, meaningfulness is
   proven on `test`.

A sixth, **accidental** seam carries over from v2 §14 unchanged: **continuous scores** (v2 §8). A
binary 23-check suite gives selection a 24-step staircase — most mutations move the score by exactly
zero — while a graded metric (SWE-bench partial credit, §8) gives gradient on *every* eval, and
non-inferiority tests on a continuous mean converge with far fewer repeat evals than on a binomial
pass rate.

**The added tables** (`sessions.skill_hash` → `variants.hash` FK on backfill):

```
variants(hash PK, parent_hash, generation, mutation_op, seed, created_at)
queue(variant_hash, suite_id, status, claimed_by, claimed_at)
genomes/<hash>/                                   -- content-addressed skill folders
```

**The loop, and which seam carries each step:**

```
   ┌─ 1. SELECT ───────────────────────────────────────────────────────────────┐
   │  fitness = minimize COST  s.t.  mean score statistically NON-INFERIOR,      │
   │  computed ONLY over split='train' sessions  (WHERE split='train').          │
   │  Variance for the non-inferiority test comes from the (task × replicate)    │
   │  cells + repeat sessions of the same skill_hash. Pick top-k.                │
   ├─ 2. MUTATE ───────────────────────────────────────────────────────────────┤
   │  LLM edits SKILL.md / references → child skill_hash, parent_hash lineage,   │
   │  written to genomes/<hash>/.                                                 │
   ├─ 3. EVALUATE on TRAIN ────────────────────────────────────────────────────┤
   │  run a tester session vs the train suite. Control is 100% REUSED (child     │
   │  shares the parent's task_hashes, §6) → the generation costs skill cells    │
   │  only. This is the per-task baseline reuse doing the heavy lifting.          │
   ├─ 4. PROMOTION GATE = the GENERALIZATION GAP ──────────────────────────────┤
   │  when a child beats the incumbent on TRAIN with significance, run it ONCE    │
   │  vs the disjoint TEST suite. Promote only if Δ_test (skill−control on held-  │
   │  out instances) is non-inferior to Δ_train. Selection NEVER reads test rows. │
   └────────────────────────────────────────────────────────────────────────────┘
```

- **The wall is a query filter, not a storage rule.** Test-suite sessions are stored identically to
  train ones; the selection step (step 1) filters `split='train'`. Recording test results the
  mutator can't select on is the whole point — `Δ_train ≫ Δ_test ≈ 0` is overfitting made visible,
  the diagnostic a self-authored eval can never produce.
- **Selection objective** is v2 §15's rule, scoped to train: *minimize COST subject to
  statistically non-inferior mean score* — never point-equality on one noisy run, never a raw token
  sum. The continuous SWE-bench score is what lets the non-inferiority test converge cheaply.
- **Repeat-eval accretion** (v2 §14 seam) still applies: across generations, repeat train evals of
  the same `skill_hash` accrete and tighten its variance estimate; immutable sessions make the
  population accrete with no reshape.

**Backfill when mutation lands:** one `variants` row per existing distinct `skill_hash`, with
`parent_hash` copied straight from the session's already-recorded `sessions.parent_hash` (`NULL` for
roots) — the lineage is *already on disk*, so backfill is a projection, not a reconstruction.
**No existing row changes.**

When the mutator exists, its loop reads the DB — top-k selection over `split='train'`, recursive-CTE
lineage over `parent_hash`, atomic `queue` claims — and writes `genomes/`. That is the workload where
the DB stops being optional and becomes load-bearing (v2 §3); everything before it is a single
time-series a JSONL could have served.

---

## 10. Dashboard & reporting deltas <a id="10-dashboard"></a>

The comparison view's headline bar (v2 §10) rolls up over **two** axes now — `mean over (task ×
replicate)` per `(model, condition)`, drawn with a spread so the `skill − control` gap reads against
its noise. Per-task breakdown is a drill-down beneath the headline. Two new facets:

- **split** — train vs test shown side by side; the generalization gap (`Δ_train` vs `Δ_test`) is the
  headline number for "does the skill do something meaningful," with the wall annotated.
- **per-task** — a resolve-rate-by-task grid (which instances the skill flips), the SWE-bench-native
  view; still a query-time roll-up over cell rows, nothing stored.

`/api/session/:id` gains the `task` grouping and the `split`; `/api/metric` groups by
`(skill_hash, model, split)` so "metric over time" charts keep train and test as separate series.

---

## 11. Configuration deltas <a id="11-config"></a>

Config (v2 §11) gains a small `suites` block; the matrix's `models/conditions/replicates` are
unchanged — `tasks` come from the suite, not config, because they are data, not policy.

```jsonc
{
  "suites": {
    "swebench-lite-train": { "dir": "eval/swebench-lite-train", "split": "train" },
    "swebench-lite-test":  { "dir": "eval/swebench-lite-test",  "split": "test"  }
  },
  "provisionTimeoutSec": 600,        // cap per-task provision (docker/clone can hang)
  "maxTasksPerSession": null          // optional safety cap on T (null = whole suite)
}
```

`run.js` gains `--suite <name>` (defaults to the legacy one-task `eval/` when absent). The split is a
property of the suite, so selecting a suite selects a split — there is no separate `--split` flag to
get wrong.

---

## 12. Implementation sequencing <a id="12-sequencing"></a>

Each step is additive; nothing reshapes a shipped table or contract. Steps 1–5 make the tester
**suite-capable for any benchmark** and stand alone; 6–7 are the SWE-bench + mutation layer.

```
   1  Schema v2        rebuild cell_metrics/test_results with task in PK; add suite_id/split +
                       session_tasks; backfill task='default'. Bump schemaVersion 1→2.
   2  Suite loader     parse suite.md + tasks.jsonl; legacy eval.md → one-task suite 'default'.
                       cells(cfg, tasks), <model>__<condition>__<task>__<replicate>, parseCellDir.
   3  Populate + run   provision hook; runner signature <task-id> <cwd> <result>; deliverable
                       generalization (greenfield shim reads <cwd>/output).
   4  Per-task reuse   regimeBaseline keyed on task_hash; per-(model,task) seeding; write session_tasks.
   5  Dashboard        comparison rolls up over (task × replicate); per-task + split facets.
   6  SWE-bench adapter tasks.jsonl from HF; provision (clone+checkout); Docker run-eval; partial credit.
   7  Mutator          variants/queue/genomes tables; the loop; the split='train' selection wall.
```

Dependency order: 1 → 2 → 3 → 4 → (5 in parallel) → 6 → 7.

---

## 13. Invariants & rules (v3 additions) <a id="13-invariants"></a>

Everything in v2 §15 still holds. v3 adds:

```
   ┌─ `task` is the 4th identity axis — part of both PKs, stored per row. Per-task AND per-replicate
   │  roll-ups are QUERY-TIME, never stored (same rule as COST/EFFORT and the replicate roll-up).
   ├─ A session evaluates ONE skill version against ONE suite (one split). The suite is the task
   │  universe; the runner owns it (v2 §8) — there is still no harness-side test enumeration.
   ├─ A legacy eval.md is a one-task suite, id 'default' — every v2 skill runs unchanged.
   ├─ Control-reuse keys on (model, task_hash), NOT (model, eval_hash). Adding a task never
   │  invalidates an existing baseline; mutating the skill reuses control for the whole suite.
   ├─ Every session records parent_hash — the skill_hash it was mutated FROM (NULL for a hand-
   │  authored root) — beside skill_hash (the variant evaluated). Lineage is captured from day one,
   │  before any mutator; variants (§9) later normalizes it. No backfill ever rewrites a row.
   ├─ THE TRAIN/TEST WALL IS A QUERY FILTER, NOT A STORAGE RULE. Storage records every task in both
   │  splits identically; the mutator's selection step filters split='train' and NEVER reads a test
   │  row. Test results are recorded only to measure the generalization gap.
   ├─ The reported claim is the within-session skill−control DELTA with a CI — never an absolute
   │  benchmark resolve rate (contamination + scaffold inflate both arms; the delta cancels them).
   ├─ A benchmark slice that subsamples the dataset must log() the sampling — silent truncation reads
   │  as full coverage. Selection scores must be continuous where the benchmark allows (partial
   │  credit), so non-inferiority converges instead of stalling on a binary staircase.
   ├─ The deliverable is whatever the runner resolves from the cell cwd (output/ by convention, or a
   │  git diff) — no longer assumed to be output/. The answer key still lives only in eval/.
   └─ provision <task-id> <cwd> and static inputs/ are the two ways to populate a cell; the answer
      key is never provisioned in. The provisioned cwd is always-delete, same as output/.
```

---

## 14. What v3 deliberately does NOT change <a id="14-non-changes"></a>

- **The `result.json` contract** (v2 §8) — strict ingest of `{name, score∈[0,1]}`, higher-better,
  no clamping. A task's grader emits exactly this; `task` is added by the harness from which cell
  invoked the runner, never by the runner.
- **The live channel** — still ephemeral server memory derived from the build feed; T× more cells,
  same mechanism, nothing new persisted.
- **COST / EFFORT** — still query-time from the four raw counts + steps; never stored, never
  flat-summed. The mutator still minimizes COST subject to non-inferior score.
- **Files are truth; the DB is rebuildable** — reindex rebuilds `task`/`session_tasks` from the
  session's `eval/` snapshot + cell dir names, same files-are-truth guarantee as v2.
- **The original seams** — `skill_hash` (the evaluated variant) and immutable sessions (accretion)
  are untouched; v3 adds `parent_hash` (lineage), `task_hash` (per-task reuse), and `split` (the
  held-out wall) alongside them.
```
