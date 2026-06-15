# skill-eval — Skill Tester v2

Evaluates a skill across **models × conditions × replicates** and reports skill-vs-control
deltas in **score**, **cost**, and **effort**. Files are ground truth; the SQLite store
(`data/index.db`) is a derived, rebuildable projection of *settled* facts; live progress lives
only in server memory and is never persisted.

Full design: [`skill-building/design-v2.md`](skill-building/design-v2.md).

## Requirements

- **Node ≥ 22.5** — uses built-in `node:sqlite` (tested on 24). **Zero npm dependencies.**
- **`claude`** CLI on PATH.
- Whatever the target skill's `eval/` runner needs (e.g. `clean-csv` needs `python`).

## Run

```
node scripts/run.js --skill-dir <path-to-skill> [--config config.json]
                    [--models a,b,c] [--replicates N] [--full-matrix] [--no-serve] [--keep]
```

Runs `prepare → build (≤concurrency) → test → finalize → reindex → retention`, serving the live
dashboard + report at `http://localhost:<port>` during and after the run. `--keep` skips retention
(leaves `output/` + cell `skill/` for debugging). `--prompt` / `--prompt-file` override the build
task (recorded in `prompts/`).

`--models <a,b,c>` runs a subset of `matrix.models`; `--replicates N` overrides the per-cell count;
`--full-matrix` re-measures control instead of reusing a cached baseline. **The models + replicates
chosen when a baseline is initialized (or refreshed) become that skill's standing defaults** — but
nothing is stored to do this: with neither flag the matrix defaults to whatever the skill's last
baseline (its most recent control-bearing session) was measured with, read straight from the DB.
Precedence: **explicit flags > last baseline > `config.json`**. A skill-only reuse run isn't
control-bearing, so it never becomes the baseline — a one-off narrow/quick run can't redefine the
default.

Preflight a skill before running — read-only, writes nothing, prints one JSON object with the eval
contract status, `eval_hash`, the current baseline (models/replicates/age/day), per-model control
reuse-vs-measure, and a suggested posture (regime change? day-boundary refresh? first baseline?). The
operating agent reads this instead of inspecting files by hand:

```
node scripts/preflight.js --skill-dir <path-to-skill>
```

Browse history any time, no run:

```
node scripts/server.js
```

Rebuild a session's DB rows from its files (recovery / files-are-truth proof):

```
node scripts/reindex.js <session-id>
```

## Config (`config.json`)

`matrix.models` (full CLI ids, in display order — each version is its own series),
`matrix.conditions` (must include `skill` + `control`), `matrix.replicates` (N),
`pricing.weights` + `pricing.inputPerMTok` (per model), `maxTurns`, `concurrency`, `port`,
`schemaVersion`. Pricing is applied **at query time** — edit it and all history re-ranks; no
stored number goes stale.

`matrix.models` + `matrix.replicates` are the **fallback** defaults: once a skill has a baseline,
later runs default to the models + replicates that baseline was measured with (derived from the DB,
not stored anywhere) and these take precedence. `config.json` always defines the full model universe
and pricing.

## The test contract (what a target skill provides)

```
<skill>/eval/
  eval.md      # frontmatter (JSON values): runner ["python","run-eval.py"], required ["cleaned.csv"],
               #   inputs ["original.csv"] (delivered as files into each cell's cwd)
               #   · body: a "## Prompt" section = the build task
  <runner>     # invoked as: <runner...> <output-dir> <result-path>  (positional, from eval/)
               # writes result.json (see schema below)
```

`runner` is just an argv array — the runner can be **any executable**, not just Python. Use
whatever grades the deliverable: `["python","run-eval.py"]`, `["node","grade.mjs"]`,
`["bash","check.sh"]`, `["./grade"]`, etc. (the host just needs that interpreter/binary on PATH).
The harness spawns it from `eval/` with two positional args — the build's `output/` dir and the
path to write `result.json` to — and learns no metric semantics; the runner owns all scoring.

### `result.json` (what the runner writes)

A single JSON object written to `<result-path>`, with two top-level keys:

- **`schemaVersion`** (required) — a finite number identifying the contract version (currently `1`).
- **`tests`** (required) — a non-empty array. The harness keeps no test list of its own, so this
  array *is* the complete set of tests for the cell; there is no skip state or expected-test
  enumeration. How to treat a test that couldn't be evaluated (omit it, or report it `0`) is the
  author's call.

Each entry in `tests` describes one graded test with up to four fields:

- **`name`** (required) — a non-empty string, **unique within the file**. It is the test's
  identity and the join key for comparing the same test across cells; there are no separate ids.
- **`score`** (required) — a finite number in **`[0, 1]`, higher is better**. This is the only
  fact ingested into the DB. The runner owns grading: a graded metric (F1, similarity) reports its
  value directly, a binary check is the degenerate `0`/`1` case, and anything unbounded or
  lower-is-better (RMSE, edit distance) must be mapped into `[0, 1]` by the runner — the harness
  never learns metric semantics.
- **`description`** (optional) — a stable, run-independent explanation of *what the test measures*
  (e.g. what a low vs. high score means). Same string every run.
- **`detail`** (optional) — *this run's* computed evidence behind the score: the actual value and
  counts (e.g. `"precision=1.000 (TP=6, FP=0)"`). Changes run to run.

`description` and `detail` are free-form strings for humans inspecting the file; they stay in
`result.json` (kept forever) but **never enter the DB or the dashboard** — only `name` and `score`
are ingested. Ingestion is **strict**: a missing/invalid file, a NaN or out-of-range `score`, or a
duplicate `name` fails the whole cell — scores are never clamped (clamping would hide runner bugs).

```json
{
  "schemaVersion": 1,
  "tests": [
    {
      "name": "dedup_recall",
      "score": 1.0,
      "description": "Of the duplicate rows that should have been collapsed, the fraction the agent removed. Low = duplicates left in the output; high = every duplicate caught.",
      "detail": "recall=1.000 (TP=6, FN=0)"
    }
  ]
}
```

The harness embeds `SKILL.md` in the skill prompt and gives skill cells a `./skill/` copy in their
cwd (control cells get none — isolation is structural, no `--add-dir`); it delivers each `inputs`
file into **every** cell's cwd (skill and control alike) and spawns the runner from `eval/`. The
prompt only names the input files — the author decides what's a file (`inputs`) vs prose (the
`## Prompt`), so a large fixture never bloats the prompt. Only the `## Prompt` section reaches the
model, so a contract doc can also hold human scoring prose without leaking it.

## Read results (the served report)

Open `http://localhost:<port>` during or after a run (or `node scripts/server.js` any time).

- **Live** — multi-run: live state is derived from each session's files, so one server streams
  **every concurrent run** at once; pick which to watch from the run-picker.
- **Instance** — leads with the skill-vs-control summary, then the per-test grid below it. Score
  bars show skill vs control mean across replicates; **COST** (price-weighted tokens → dollars) is
  the headline, **EFFORT** (output tokens + steps) is the behavior axis. When a session reused a
  cached control, the comparison badges it as an **unpaired** baseline (with its age + replicate
  count) — skill this session vs control from an earlier one, so treat the delta as weaker.
- **History** — facets into one panel per **regime**, a comparable group `(model, eval/ tests,
  control epoch)`. Incomparable regimes never share a y-axis: changing the tests, the models, or
  re-measuring control starts a new panel, so you can't accidentally compare across them. Within a
  panel the **skill** is the moving line over versions and the **control** is a flat baseline
  reference (± its spread), with a marker on the sessions that actually measured it. Pick a single
  regime (default: the latest) or the faceted overview from the **regime** selector.

## Layout

```
config.json                 the matrix / pricing / run params
scripts/                    run.js · preflight.js · server.js · session.js · prompts.js ·
                            builds.js · supervisor.js · stream-metrics.js · eval-runner.js · db.js ·
                            metrics.js · live.js · reindex.js · retention.js · config.js
scripts/webpages/           the single-page app (Live · Instance · History)
data/                       runtime: index.db + immutable timestamped sessions/<id>/
```

## Notes

- Set `SKILL_EVAL_CLAUDE_BIN` to override the `claude` binary (a `.js`/`.mjs` value runs under
  Node) — useful for an alternate runner or for testing without spending tokens.
- A cell keeps only `result.json` (always) + `stream.jsonl` (purgeable; kept for the latest
  session and any failed cells) + a non-empty `stderr.log`. `output/`, the per-cell `skill/` copy,
  and any agent scratch files are deleted after tests. Session `skill/` snapshot + `prompts/` are
  kept forever (they back `skill_hash` / `prompt_hash`).
