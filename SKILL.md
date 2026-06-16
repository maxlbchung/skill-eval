---
name: skill-eval
description: Evaluate a skill by running various models with and without a skill, then grading output with a set list of deterministic graders, token usage, and tool call count. Track agent progress with a live dashboard and visualize test results in a final HTML report.
---

# skill-eval

Build a deliverable with several models **with** a target skill vs **without** it (control),
grade each build with the target skill's own deterministic tests, and report the skill-vs-control
delta in score, cost, and effort. Matrix = `models × {skill, control} × replicates`.

## 1. Prerequisite — the target skill must expose an eval contract

**Start by running preflight — it does all the §1/§3 file + DB inspection for you so you don't have
to reason it out by hand:**

```
node scripts/preflight.js --skill-dir <path>   # read-only, writes nothing; prints one JSON object
```

It returns `contract` (present? runner/required/inputs, or *why* it's missing), `evalHash`, the
current `baseline` (models, replicates, age, day), `perModelControl` (reuse vs measure per model),
and a `decision` block (posture + which questions to ask). Read it and act on it — don't re-derive
these facts manually. If `contract.present` is `false`, author `eval/eval.md` + a runner first:

`eval/eval.md` (frontmatter values are JSON; only the `## Prompt` section reaches the model, so
scoring notes elsewhere are safe):

```
---
runner: ["python", "run-eval.py"]   # argv prefix the harness spawns
required: ["cleaned.csv"]            # output file name(s) the build must produce
inputs: ["original.csv"]            # files (relative to eval/) placed in each cell's cwd
---
## Prompt
<the build task to give the model>
```

The runner (e.g. `eval/run-eval.py`) is spawned from `eval/` as `<runner> <output-dir> <result-path>`.
It grades the deliverable in `<output-dir>` and writes `<result-path>`:

```
{ "schemaVersion": 1, "tests": [ { "name": "dedup", "score": 0.87, "detail": "..." } ] }
```

`score` is a number in `[0,1]`, higher is better (binary checks use 0 or 1). The runner owns all
grading. Ingest is strict — a missing/NaN/out-of-range score or duplicate name fails that cell.

## 2. Run

```
node scripts/run.js --skill-dir <path-to-target-skill>
```

Needs Node ≥ 22.5, the `claude` CLI on PATH, and whatever the runner needs (e.g. `python`).
Flags: `--config <file>` (default `config.json`), `--models <a,b,c>` (run a subset of
`config.matrix.models` this session), `--replicates <n>` (override per-cell runs for this run),
`--full-matrix` (re-measure control instead of reusing a cached baseline — **reuse is the
default**), `--no-serve`, `--keep` (skip cleanup), `--prompt` / `--prompt-file` (override the
build task). Runs prepare → build → test → finalize and serves the report at
`http://localhost:<port>` — **reusing an already-running server** if one is up, so several
concurrent runs share one site (the Live tab lists every running session). Builds run real models
— cost scales with the matrix.

The **models + replicates chosen when a baseline is initialized become that skill's standing
defaults** — not via any stored preference, but because later runs default to whatever the skill's
last baseline (its most recent control-bearing session) was measured with, read from the DB. Run
with no `--models`/`--replicates` and that selection applies. Precedence is **explicit flags > last
baseline > `config.json`**; pass a flag only to *change* the selection ("direct otherwise"). A
skill-only reuse run isn't control-bearing, so it never becomes the baseline — a quick one-off
(`--replicates 1`, a single `--models`) can't silently redefine the default.

By default the harness **reuses the last fresh control baseline** for each `(model, eval/ tests)`
and runs **skill cells only** (`6N → 3N`) — control depends only on the apparatus, not on the
skill version. It re-measures control automatically when the apparatus changes (a new regime) or
the baseline is stale; `--full-matrix` forces a re-measure. See §3.

## 3. Operating procedure — run this before every evaluation

The harness reuses a cached control baseline by default and only re-measures control when it must.
**You ask the user how to compose a baseline only when one is being initialized; once chosen, that
selection is the skill's standing default and later sessions inherit it.** The governing rule:

> **Inform, don't ask, for a correctness change. Ask for a judgment call.**
> A **regime change** (the `eval/` tests changed → a new `eval_hash`) re-baselines automatically —
> the old baseline isn't comparable — so just *announce* it (an added model is handled the same way
> per-model: it has no baseline, so its control just measures). A **day-boundary** refresh is a
> judgment call about provider drift, so *ask*. **Composing a baseline** (which models, how many
> replicates) is a judgment call too — but only the *first* time per skill/regime, since later runs
> default to whatever the last baseline used.

**Detect** — don't reason this out; run `node scripts/preflight.js --skill-dir <path>` and read its
`decision` block. It computes the posture for you and tells you exactly which questions to ask:

| preflight field | what it means | what you do |
| --- | --- | --- |
| `decision.announceRegimeChange: true` | `eval/` tests changed → new `eval_hash`, old baseline not comparable | **Announce** (don't ask): control re-measures this session. |
| `decision.announceStaleBaseline: true` | baseline is past the freshness window | **Announce**: control auto-refreshes this session. |
| `decision.askComposition: true` | a baseline is being initialized/refreshed | **Ask** Q2 + Q3; pre-fill from `baseline.models` / `baseline.replicates`. |
| `decision.askDayBoundaryRefresh: true` | fresh baseline, but from an earlier day | **Ask** Q1 (provider drift is the judgment call). |
| all asks `false` (`posture: "reuse"`) | same-day fresh baseline | **Ask nothing**; run with no `--models`/`--replicates`. |

`perModelControl` shows reuse-vs-measure per model, and `decision.suggestedInvocation` is the base
command. (`run.js` re-prints the regime/refresh notes when it actually runs, so the announce is also
visible in its output.)

**Ask** — one `AskUserQuestion` call, including only the questions preflight flagged:
1. *(when `askDayBoundaryRefresh`)* "Your control baseline is from `<baseline.lastMeasured>`
   (`<baseline.replicates>` replicates). Provider behaviour can drift across days — re-run the
   control baseline today?"
   - **Reuse baseline (recommended)** — keep the cached control; run skill-only.
   - **Refresh baseline now** — adds `--full-matrix` (re-measures control → a *new control epoch*,
     i.e. a new comparable group in History) and re-initializes the baseline (now also ask Q2 + Q3).
2. *(when `askComposition`)* "Which models should this baseline cover?" — **multi-select**, options =
   `config.models`, default **all (recommended)** (pre-select `baseline.models` if present) → maps to
   `--models <ids>`.
3. *(when `askComposition`)* "How many replicates per cell?" — **3 (recommended)** / **5** / **10** /
   Other (default to `baseline.replicates` if present) → maps to `--replicates <n>`.

On a `reuse` posture ask **none** of these — the last baseline's matrix applies automatically. Then
invoke (omit `--models`/`--replicates` entirely on a reuse run so the last baseline's selection is
inherited):

```
node scripts/run.js --skill-dir <path> [--models <ids>] [--replicates <n>] [--full-matrix]
```

Afterwards, `run.js` reports the effective models + replicates and their source (flags / last
baseline / config), which models reused control vs re-measured it, and — when a baseline was
initialized — that this session is now the baseline later runs default to. The report badges a
reused control as **unpaired** (skill this session vs control from an earlier session).

## 4. Configure (`config.json`)

- `matrix.models` — full CLI model ids, display order (each version is its own series). The
  universe a `--models` selection draws from; also the model set shown across the dashboard
- `matrix.conditions` — must include `skill` and `control`
- `matrix.replicates` — N runs per cell (averages out model noise); total builds = models × 2 × N.
  The **fallback** default — a skill that has initialized a baseline overrides this with the count
  that baseline used (below)
- `pricing.weights` + `pricing.inputPerMTok` — derive COST at query time; safe to edit anytime
- `baselineMaxAgeHours` — headless freshness window for baseline reuse (default 24): a cached
  control older than this auto-refreshes on a non-interactive run (the §3 day-boundary ask is the
  interactive trigger)
- `concurrency`, `maxTurns`, `port`

`config.json` is the **fallback** for `matrix.models` + `matrix.replicates`. Per skill, later runs
default instead to the models + replicates its **last baseline** (most recent control-bearing
session) was measured with — derived from the DB, not stored anywhere — and that takes precedence
(see §2/§3). With no prior baseline, `config.json` applies.

## 5. Report results to the user

`run.js` prints the numeric per-cell summary to stdout (mean score, what reused vs re-measured) —
that's your source for telling the user how it went; you don't open the dashboard yourself. Point
them at the served report (`http://localhost:<port>`, Instance tab for the skill-vs-control
summary) and surface the two interpretation caveats:

- **Unpaired control** — when control was reused, the comparison is skill (this session) vs control
  (an earlier session), badged **unpaired** with its age + replicate count. Flag it as a weaker
  delta than a paired (`--full-matrix`) run.
- **Don't compare across regimes** — History is faceted one panel per regime `(model, eval/ tests,
  control epoch)`; scores in different panels aren't comparable. Only the skill trend *within* a
  panel is a like-for-like comparison.

`node scripts/server.js` browses past runs (and keeps a server up for all runs) without a new run.
The full dashboard tour (Live/Instance/History) is in the README's "Read results".
