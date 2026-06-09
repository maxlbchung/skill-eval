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
node scripts/run.js --skill-dir <path-to-skill> [--config config.json] [--no-serve] [--keep]
```

Runs `prepare → build (≤concurrency) → test → finalize → reindex → retention`, serving the live
dashboard + report at `http://localhost:<port>` during and after the run. `--keep` skips retention
(leaves `output/` + cell `skill/` for debugging). `--prompt` / `--prompt-file` override the build
task (recorded in `prompts/`).

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

## The test contract (what a target skill provides)

```
<skill>/eval/
  eval.md      # frontmatter (JSON values): runner ["python","run-eval.py"], required ["cleaned.csv"],
               #   inputs ["original.csv"]   ·   body: a "## Prompt" section = the build task
  run-eval.py  # invoked as: <runner...> <output-dir> <result-path>  (positional, from eval/)
               # writes {schemaVersion, tests:[{name, score∈[0,1], detail?}]}
```

The harness embeds `SKILL.md` in the skill prompt and gives skill cells a `./skill/` copy in their
cwd (control cells get none — isolation is structural, no `--add-dir`); it inlines `inputs`,
spawns the runner from `eval/`, and **strictly** ingests `result.json` (missing/NaN/out-of-range
score or duplicate name fails the cell — never clamped). Only the `## Prompt` section reaches the
model, so a contract doc can also hold human scoring prose without leaking it.

## Layout

```
config.json                 the matrix / pricing / run params
scripts/                    run.js · server.js · session.js · prompts.js · builds.js ·
                            supervisor.js · stream-metrics.js · eval-runner.js · db.js ·
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
