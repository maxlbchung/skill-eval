---
name: skill-eval
description: Evaluate a skill by running various models with and without a skill, then grading output with a set list of deterministic graders, token usage, and tool call count. Track agent progress with a live dashboard and visualize test results in a final HTML report.
---

# skill-eval

Build a deliverable with several models **with** a target skill vs **without** it (control),
grade each build with the target skill's own deterministic tests, and report the skill-vs-control
delta in score, cost, and effort. Matrix = `models × {skill, control} × replicates`.

## 1. Prerequisite — the target skill must expose an eval contract

Check the target skill for `eval/eval.md` + a runner. If missing, author them first:

`eval/eval.md` (frontmatter values are JSON; only the `## Prompt` section reaches the model, so
scoring notes elsewhere are safe):

```
---
runner: ["python", "run-eval.py"]   # argv prefix the harness spawns
required: ["cleaned.csv"]            # output file name(s) the build must produce
inputs: ["original.csv"]            # files (relative to eval/) inlined into the build prompt
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
Flags: `--config <file>` (default `config.json`), `--replicates <n>` (override per-cell runs for
this run), `--full-matrix` (re-measure control instead of reusing a cached baseline — **reuse is
the default**), `--no-serve`, `--keep` (skip cleanup), `--prompt` / `--prompt-file` (override the
build task). Runs prepare → build → test → finalize and serves the report at
`http://localhost:<port>` — **reusing an already-running server** if one is up, so several
concurrent runs share one site (the Live tab lists every running session). Builds run real models
— cost scales with the matrix.

By default the harness **reuses the last fresh control baseline** for each `(model, eval/ tests)`
and runs **skill cells only** (`6N → 3N`) — control depends only on the apparatus, not on the
skill version. It re-measures control automatically when the apparatus changes (a new regime) or
the baseline is stale; `--full-matrix` forces a re-measure. See §3.

## 3. Operating procedure — run this before every evaluation

The harness reuses a cached control baseline by default and only re-measures control when it must.
Before launching, decide the baseline posture, then ask the user the two decisions that are
genuinely theirs in **one `AskUserQuestion` call**. The governing rule:

> **Inform, don't ask, for a correctness change. Ask for a judgment call.**
> A **regime change** (the `eval/` tests or the model set changed) re-baselines automatically — a
> new `eval_hash` has no comparable baseline — so just *announce* it. A **day-boundary** refresh is
> a judgment call about provider drift, so *ask*.

**Detect** from the most recent completed session for this skill (the harness prints what it chose):
- **Regime change** — the `eval/` contract or model set differs from the last run. → The harness
  measures a fresh control baseline automatically (`run.js` prints `⚠ regime change …`). Do **not**
  ask; *tell* the user the baseline is being re-measured because the tests changed (the old one
  isn't comparable).
- **New day, same regime** — a baseline exists but its newest control run is from an earlier
  calendar day. → **Ask** question 1; pass `--full-matrix` only if they choose refresh.
- **Same day, same regime** — reuse silently (skill cells only). Ask question 2 only.

**Ask** — one `AskUserQuestion` call, up to two questions:
1. *(only on a new day, same regime)* "Your control baseline is from `<date>` (`<n>` replicates).
   Provider behaviour can drift across days — re-run the control baseline today?"
   - **Reuse `<date>` baseline (recommended)** — keep the cached control; run skill-only.
   - **Refresh baseline now** — adds `--full-matrix` (re-measures control → a *new control epoch*,
     i.e. a new comparable group in History).
2. *(always)* "How many replicates per cell for this run?" — **3 (recommended)** / **5** / **10** /
   Other → maps to `--replicates <n>`.

Then invoke:

```
node scripts/run.js --skill-dir <path> --replicates <n> [--full-matrix]
```

Afterwards, `run.js` reports which models reused control vs re-measured it; the report badges a
reused control as **unpaired** (skill this session vs control from an earlier session).

## 4. Configure (`config.json`)

- `matrix.models` — full CLI model ids, display order (each version is its own series)
- `matrix.conditions` — must include `skill` and `control`
- `matrix.replicates` — N runs per cell (averages out model noise); total builds = models × 2 × N
- `pricing.weights` + `pricing.inputPerMTok` — derive COST at query time; safe to edit anytime
- `baselineMaxAgeHours` — headless freshness window for baseline reuse (default 24): a cached
  control older than this auto-refreshes on a non-interactive run (the §3 day-boundary ask is the
  interactive trigger)
- `concurrency`, `maxTurns`, `port`

## 5. Read results

In the report: **Live** during a run, then **Instance / History**. The Instance tab leads with
the skill-vs-control summary, then the per-test grid below it. Score bars show skill vs control
mean across replicates; **COST** (price-weighted tokens → dollars) is the headline, **EFFORT**
(output tokens + steps) is the behavior axis. When a session reused a cached control, the
comparison badges it as an **unpaired** baseline (with its age + replicate count).

**History** facets into one panel per **regime** — a comparable group `(model, eval/ tests,
control epoch)`. Incomparable regimes never share a y-axis: changing the tests, the models, or
re-measuring control starts a new panel. Within a panel the **skill** is the moving line over
versions and the **control** is a flat baseline reference (± its spread), with a marker on the
sessions that actually measured it. Pick a single regime (default: the latest) or the faceted
overview from the **regime** selector. The **Live** tab is now multi-run: live state is derived
from each session's files, so one server streams **every concurrent run** at once — pick which to
watch from the run-picker. Browse past runs later (or keep a server up for all runs) without a new
run: `node scripts/server.js`.
