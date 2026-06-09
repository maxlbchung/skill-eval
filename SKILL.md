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
Flags: `--config <file>` (default `config.json`), `--no-serve`, `--keep` (skip cleanup),
`--prompt` / `--prompt-file` (override the build task). Runs prepare → build → test → finalize and
serves the report at `http://localhost:<port>`. Builds run real models — cost scales with the matrix.

## 3. Configure (`config.json`)

- `matrix.models` — full CLI model ids, display order (each version is its own series)
- `matrix.conditions` — must include `skill` and `control`
- `matrix.replicates` — N runs per cell (averages out model noise); total builds = models × 2 × N
- `pricing.weights` + `pricing.inputPerMTok` — derive COST at query time; safe to edit anytime
- `concurrency`, `maxTurns`, `port`

## 4. Read results

In the report: **Live** during a run, then **Instance / History**. The Instance tab leads with
the skill-vs-control summary, then the per-test grid below it. Score bars show skill vs control
mean across replicates; **COST** (price-weighted tokens → dollars) is the headline, **EFFORT**
(output tokens + steps) is the behavior axis. Browse past runs later without
a new run: `node scripts/server.js`.
