# Skill Tester v2 — Design & Implementation Spec

A from-scratch rewrite of the skill tester that **generalizes to any skill** (not just
`web-gpu-llm` / Playwright), backs results with a **SQLite database**, and is shaped so a
future **skill mutator** can be added without reworking storage.

---

## Table of contents

1. [Goals](#1-goals)
2. [The evaluation matrix](#2-the-evaluation-matrix)
3. [Architecture overview](#3-architecture-overview)
4. [Storage model](#4-storage-model)
5. [Directory layout](#5-directory-layout)
6. [Database schema](#6-database-schema)
7. [Data flow](#7-data-flow)
8. [The test contract (framework-agnostic)](#8-the-test-contract-framework-agnostic)
9. [Per-cell files & retention](#9-per-cell-files--retention)
10. [Web app & reporting](#10-web-app--reporting)
11. [Configuration](#11-configuration)
12. [What transfers from v1](#12-what-transfers-from-v1)
13. [Implementation plan](#13-implementation-plan)
14. [Mutation-readiness (deferred)](#14-mutation-readiness-deferred)
15. [Invariants & rules](#15-invariants--rules)
16. [v1 issues fixed by this design](#16-v1-issues-fixed-by-this-design)

---

## 1. Goals

- **Generalize to any skill.** The tester must not assume Playwright or any specific app
  type. The target skill supplies its own test runner behind a documented contract.
- **Externalize the matrix.** Models, conditions, and the model→CLI mapping live in one
  config, not hardcoded across five files.
- **DB-backed results.** SQLite holds exactly what we query across runs: per-test scores,
  tokens, and step counts — settled facts only. Raw artifacts (the build trajectory) stay on
  disk.
- **Live state is ephemeral.** Progress timers, climbing token counts, and in-flight status
  live in the web-server's memory (derived from the build feed + harness-measured timers) and
  are served via `/api/live`. They never enter `index.db`; the DB is written only at phase
  boundaries.
- **One report.** A single web app reads the DB through a small API — no per-run inlined
  HTML snapshots.
- **Mutation-ready.** Two seams (`skill_hash` + immutable sessions) make a future mutator
  a purely additive change.

---

## 2. The evaluation matrix

Each session evaluates one skill across **3 models × 2 conditions × N replicates** — `6N`
cells. The grid below shows the 6 distinct **(model, condition)** combinations; each is run
**N times** (the replicate axis, coming out of the page).

```
                 ┌────────────────┬────────────────┐
                 │     SKILL      │    CONTROL      │
   ┌─────────────┼────────────────┼────────────────┤
   │   OPUS      │  opus-skill    │  opus-control   │
   ├─────────────┼────────────────┼────────────────┤
   │   SONNET    │  sonnet-skill  │  sonnet-control │
   ├─────────────┼────────────────┼────────────────┤
   │   HAIKU     │  haiku-skill   │  haiku-control  │
   └─────────────┴────────────────┴────────────────┘
```

- **N replicates per cell** averages out LLM nondeterminism. One skill-vs-control reading is a
  single noisy sample; running each `(model, condition)` cell `N` times turns every cell into a
  *distribution*, so the dashboard shows a mean with a real spread and the skill effect becomes
  a statistical comparison, not a one-run anecdote. `N` lives in config (§11); the replicate is
  a zero-based index carried in the cell's directory name and DB rows (§5, §6). Mean & variance
  across replicates are **query-time** roll-ups, never stored — the same rule as COST/EFFORT.
- **skill** cells get the full `SKILL.md` body **embedded in the build prompt**, plus a
  per-cell copy of the whole skill folder at `./skill/` for supporting files. This mirrors
  production: when a skill triggers, the harness injects the SKILL.md body into context
  verbatim, and the model reads supporting files (`references/`, scripts) on demand. Embedding
  also forces 100% exposure, so the skill-vs-control delta measures the content — not each
  model's willingness to go read a folder.
- **control** cells get only the required file names / element IDs — and **no `./skill/`
  copy**. Isolation is structural: there is nothing in the cell to leak and no launch flag
  to forget.
- The model is a CLI flag, not part of the prompt — so there are only **2 distinct prompt
  texts** per session, not `6N` — every replicate of a given condition reuses the same prompt.
- Cell identity uses the **full model version string** (e.g. `claude-opus-4-6`); `opus` /
  `sonnet` / `haiku` above are just shorthand. A new model version is therefore a new series,
  not folded into the old one.

---

## 3. Architecture overview

Files are truth; the DB is a derived, queryable projection of *settled* facts; a separate
ephemeral live channel (server memory) carries *transient* progress. The web app reads the
live channel for the Live tab and the DB for history — both over the API.

```
┌───────────────────────────────────────────────────────────────────┐
│                         WEB APP (one page)                         │
│    Live tab ── /api/live ──┐            ┌── /api/session ── History  │
└────────────────────────────┼────────────┼────────────────────────────┘
                            ░ │            │ █   HTTP (tiny static server)
              transient       │            │      durable
┌────────────────────────────▼───┐    ┌───▼────────────────────────────┐
│  LIVE CHANNEL (server memory)   │    │      QUERY LAYER (index.db)    │
│  climbing tokens/steps,         │    │  sessions · cell_metrics ·     │
│  in-flight status, elapsed      │    │  test_results                  │
│  — NEVER persisted              │    │  derived · rebuildable         │
└────────────────▲────────────────┘    └────────────────▲───────────────┘
       ░ tail build feed                       █ boundary writes + reindex
┌────────────────┴───────────────────────────────────────┴───────────┐
│                     GROUND TRUTH (files on disk)                    │
│   skill/ · prompts/ · cells/*/stream.jsonl · cells/*/result.json    │
│                   immutable · append-only · diffable               │
└─────────────────────────────────────────────────────────────────────┘
```

**Why a DB at all:** it earns its place for cross-session *"metric over time"* queries and
becomes load-bearing once the mutator needs selection / lineage / a work queue. For a single
fixed time-series a JSONL would do; the DB is chosen because it is forward-compatible with
that future and removes write-contention on one big JSON. Live state is kept out of it
entirely (see the live channel below), so the DB only ever takes settled, boundary writes.

---

## 4. Storage model

| Layer            | Home                                   | Lifetime              | Authoritative? |
|------------------|----------------------------------------|-----------------------|----------------|
| Ground truth     | files (`skill/`, `prompts/`, cells)    | permanent, immutable  | **yes**        |
| Query / history  | `index.db`                             | derived               | no — rebuildable |
| Live state       | web-server memory (`/api/live`)        | transient             | no             |

**Principle:** everything in the DB can be rebuilt by scanning the files, *except* tokens/
steps once their `stream.jsonl` is purged (then the DB is authoritative for those numbers).
Test results stay rebuildable from `result.json`.

```
   rebuild paths
   ─────────────
   result.json      ──▶ test_results, cell_metrics(score_sum,total)  (always rebuildable)
   stream.jsonl     ──▶ cell_metrics(token counts, steps)          (until stream purged)
   skill/           ──▶ the evaluated skill content; skill_hash = hash(skill/)
   prompts/         ──▶ the two assembled prompt texts → prompt_hash
   DB-authoritative ──▶ tester_version                             (not stored on disk separately)
```

---

## 5. Directory layout

```
data/
├── index.db                          # SQLite — derived query/history store
└── sessions/
    └── 2026-06-04T10-22-31__web-gpu-llm/      # immutable, timestamped
        ├── orchestrator.log          # top-level process's own log — session-scoped
        ├── skill/                    # canonical snapshot of the evaluated skill (whole folder,
        │                             #   copied at session prep) — source of skill_hash; KEPT
        ├── prompts/
        │   ├── skill.md              # assembled skill prompt — embeds the SKILL.md body and
        │   │                         #   points at ./skill/ for supporting files
        │   └── control.md            # assembled control prompt
        └── cells/                                   # <model>__<condition>__<replicate>; model = full
            │                                        #   version string, replicate = zero-padded index
            ├── claude-opus-4-6__skill__00/             # replicate 00 — every cell repeats N times
            │   ├── skill/            # per-cell duplicate of the session snapshot — inside the
            │   │                     #   agent's cwd (no --add-dir needed); purged at test-end
            │   ├── stream.jsonl      # build log → tokens/steps. NEVER in DB. purgeable.
            │   ├── result.json       # test results → DB. contract + rebuild source.
            │   ├── stderr.log        # build CLI stderr — kept only if non-empty
            │   ├── supervisor.log    # supervisor's own stdout/stderr — transient, crash diag
            │   ├── .done             # transient marker — orchestrator waits on this
            |   ├── .failed           # transient marker — written instead of .done on failure
            │   └── output/           # the deliverable — is produced here during the run, then DELETED after tests
            │   
            ├── claude-opus-4-6__skill__01/ … __<N-1>/    # the remaining opus-skill replicates
            ├── claude-opus-4-6__control__00/ … __<N-1>/  # control cells have NO skill/ — isolation
            ├── claude-sonnet-4-6__skill__00/ … __<N-1>/  #   is structural, not a launch flag
            ├── claude-sonnet-4-6__control__00/ … __<N-1>/
            ├── claude-haiku-4-5-20251001__skill__00/ … __<N-1>/
            └── claude-haiku-4-5-20251001__control__00/ … __<N-1>/   # 6 × N cell dirs total
```

Notes:
- **Cell dirs use the full model version string** (e.g. `claude-opus-4-6`) to match the DB
  `model` column and the config — no short-label mapping to maintain. `__` separates the three
  identity segments, `<model>__<condition>__<replicate>`, because the model string itself
  contains hyphens; the replicate is a **zero-padded index** (`00`, `01`, …) so cell dirs sort
  in run order. There are `6N` cell dirs per session.
- **Logs follow process scope.** `orchestrator.log` is the single top-level process's own log
  (session-scoped); each cell's `supervisor.log` is that per-cell supervisor process's log. The
  `6N` supervisors run concurrently (up to the configured concurrency cap, §11), so keeping
  them per cell avoids interleaving into one file.
- **`.done` / `.failed` / `supervisor.log` / `orchestrator.log` are transient run-control** —
  markers the orchestrator blocks on, plus the process logs for crash diagnosis. They hold no
  analytical data and are purged with the session.
- **No `session.json`** — it was a derived roll-up of the cells; the DB holds it instead.
- **No `live.json`** — live state lives in the web-server's ephemeral channel (memory),
  derived by tailing the build feed; it is never written to disk or the DB.
- **No `meta.json`** — its fields are already in the DB (`sessions` row; the `model` column
  holds the exact version string), and the skill content is preserved as the session `skill/`
  snapshot, so `skill_hash` is rebuildable from files; only `tester_version` stays
  DB-authoritative. The dir stays self-describing via `skill/` + `prompts/`.
- **Skill delivery mirrors production.** The build prompt embeds the SKILL.md body (what the
  harness injects when a skill triggers); supporting files are read from the `./skill/` copy
  inside the cell's own cwd (what the model reads on demand) — no `--add-dir`, no permission
  edge cases, and no path outside the cell. Cells never read the live skill directory, so
  mid-session edits to the skill cannot drift from `skill_hash`.
- **`prompts/` is load-bearing, not a courtesy copy.** Builds are launched from the bytes of
  `prompts/skill.md` / `control.md` (assemble → write → read back → spawn), so the kept
  artifact is guaranteed to be exactly what every cell saw — it can never drift from an
  in-memory original.
- **No per-run `report.html`** — one web app over the API.
- **No `latest ->` symlink** — "newest session" is a DB query (and symlinks are painful on
  Windows). A `latest.txt` is the fallback only if a no-DB path is ever needed.

---

## 6. Database schema

```
        ┌──────────────────────────┐
        │ sessions                 │
        │──────────────────────────│
        │ id               PK      │
        │ skill_name               │
        │ skill_hash         ◄──────── mutation seam (content hash of evaluated skill)
        │ prompt_hash              │
        │ status                   │  running | complete | failed
        │ started_at               │  ◄─ provenance (derivable from id), not the analysis axis
        │ ended_at                 │
        │ tester_version           │
        │ schema_version           │
        └───────────┬──────────────┘
                    │ 1
          ┌─────────┴───────────────────┐
          │ N                           │ N
   ┌──────▼──────────────────┐   ┌──────▼─────────────┐
   │ cell_metrics            │   │ test_results       │
   │─────────────────────────│   │────────────────────│
   │ session_id FK           │   │ session_id   FK    │
   │ model                   │   │ model              │   model = full version
   │ condition               │   │ condition          │     string (identity +
   │ replicate               │   │ replicate          │     provenance)
   │ score_sum               │   │ name               │
   │ total                   │   │ score              │  REAL 0..1 — the graded fact
   │ input_tokens            │   │                    │
   │ cache_creation_tokens   │   │ PK(session_id,     │   name = the test's identity,
   │ cache_read_tokens       │   │    model,          │     runner-assigned (no ids)
   │ output_tokens           │   │    condition,      │
   │ steps                   │   │    replicate,      │   four RAW usage counts —
   │ status                  │   │    name)           │     COST & EFFORT are
   │                         │   └────────────────────┘   query-time derivations,
   │ PK(session_id, model,   │                            never stored (§11)
   │   condition, replicate) │                            replicate = 0..N-1; per-cell
   └─────────────────────────┘                            mean/variance = query-time
```

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,          -- e.g. 2026-06-04T10-22-31__web-gpu-llm
  skill_name     TEXT NOT NULL,
  skill_hash     TEXT NOT NULL,             -- content hash of the evaluated skill (the seam)
  prompt_hash    TEXT,
  status         TEXT NOT NULL,             -- running | complete | failed
  started_at     TEXT NOT NULL,             -- provenance only (derivable from id); NOT the
                                            --   analysis axis (that is skill_hash / model version)
  ended_at       TEXT,                      -- session lifecycle; wall-clock duration is not a metric
  tester_version TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE cell_metrics (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model      TEXT NOT NULL,                 -- FULL version string = identity + provenance, e.g. claude-opus-4-6
  condition  TEXT NOT NULL,                 -- skill | control
  replicate  INTEGER NOT NULL,              -- 0..N-1 — repeat index; 3rd identity axis (model ×
                                            --   condition × replicate). N from config (§11)
  score_sum  REAL,                          -- Σ test scores, written ONCE at test-end (from result.json)
  total      INTEGER,                       -- COUNT of reported tests, written ONCE at test-end
  input_tokens          INTEGER,            -- ┐ the four RAW usage counts (API metering — the
  cache_creation_tokens INTEGER,            -- │   billable facts), written ONCE at build-end,
  cache_read_tokens     INTEGER,            -- │   parsed from stream.jsonl. NEVER store any
  output_tokens         INTEGER,            -- ┘   summed/weighted token number (see below).
  steps      INTEGER,                       -- COUNT of tool calls, written ONCE at build-end
  status     TEXT,                          -- SETTLED outcome only: pending | complete | failed
                                            --   (live building/testing status is ephemeral, not here)
  PRIMARY KEY (session_id, model, condition, replicate)
);

CREATE TABLE test_results (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model      TEXT NOT NULL,
  condition  TEXT NOT NULL,
  replicate  INTEGER NOT NULL,              -- 0..N-1 — which repeat of this cell produced the score
  name       TEXT NOT NULL,                 -- the test's identity — runner-assigned, unique per cell-replicate
  score      REAL NOT NULL,                 -- 0..1, higher is better; binary checks report exactly 0 or 1
  PRIMARY KEY (session_id, model, condition, replicate, name)
);
```

**Two derived metrics — computed at query time, never stored:**

| Metric | Formula | Question it answers |
|--------|---------|---------------------|
| **COST** | `(input·1 + cache_creation·1.25 + cache_read·0.1 + output·5) × base $/MTok` — weights & base rates from config (§11) | "What does the skill route cost?" — the headline, and what a skill author optimizes directly. Because the weights track per-token compute (decode is sequential and dear; a cache read skips recompute, so ~0.1×), the same number doubles as a **proxy for compute** — dollars are the unit, compute is what they stand in for. The skill's own carry cost (embedded-body cache write, per-turn cache reads, reference-file reads) is deliberately INCLUDED — correcting it out would bias the comparison in the skill's favor. Cross-model comparisons are in dollars only. |
| **EFFORT** | `output_tokens + steps` (unweighted) | "Did the skill change the model's behavior?" — insensitive to prompt size and cache semantics, so it isolates induced work from carried content. |

A flat sum (weights 1/1/1/1) is the one banned aggregation: it overprices a cache read ~10×
and underprices an output token ~5×, so over a ~40-turn build one token of SKILL.md body
*appears* ~40× as expensive as one output token when in real cost they are roughly at par.
Anything ranked on a flat sum — a dashboard column or, worse, mutator selection — optimizes
skill *length*, not skill *quality*.

**Deliberately NOT stored** (decided during design):
- per-test `duration_ms` / timestamps — live-dashboard only, useless afterward.
- per-cell wall-clock `duration_ms` (build *and* test) — noisy; tokens/steps and pass/total are
  the real axes. Test-phase duration is harness-measured and shown live, but it mostly measures
  the suite + the built app, not the model/skill — keep it live-only (a weak optional column at
  most, never a headline metric).
- live status (`building` / `testing`), the in-flight activity pointer, and all elapsed timers —
  ephemeral; see below.
- raw stream events / per-tool-call records — stay in `stream.jsonl` on disk. Only the five
  derived scalars (the four raw token counts + `steps`) cross into the DB.
- any summed or weighted token number — prices are provider policy, not run facts; they change
  over time and differ per model. The DB stores what was metered, config stores what it costs,
  and COST/EFFORT are recomputed at query time — so history re-ranks correctly after any
  price change.
- per-`(model, condition)` aggregates across the N replicates — mean score, variance / CI,
  mean cost & effort. Each is a query-time roll-up over the replicate rows (like COST/EFFORT),
  so the spread re-derives correctly if a replicate is later added or repaired.

**Live state is NOT in the DB at all** (not even transient columns). It lives in the
web-server's memory, derived two ways and served from `/api/live`:
- **build phase** — the server tails each cell's `stream.jsonl` for the climbing
  `tokens` / `steps` and current activity;
- **test phase** — the harness wraps the `run-eval` spawn and measures wall-clock itself, so
  the only test-phase live signal is `status:testing` + a `startedAt` anchor.

Elapsed clocks are computed **client-side** from that `startedAt` anchor, so even the timers
never become stored facts. If the server restarts mid-session, live state is re-derived by
re-tailing the append-only feeds.

Because the DB is written **only at phase boundaries** (build-end, test-end, session
start/finalize) — never per tick — there is no per-tick write contention. **WAL mode** is still
recommended so the boundary writers and the dashboard's history reads never block; on Node 22+,
prefer the built-in `node:sqlite` to avoid a native dependency.

---

## 7. Data flow

### 7.1 Orchestration (whole session)

```
        ┌────────────┐
        │  CLI start │   node run.js --skill-dir <dir> [--prompt ... | --prompt-file ...]
        └─────┬──────┘
              ▼
   ┌────────────────────────┐
   │ 1. prepare session     │  copy skill → skill/ (snapshot); skill_hash = hash(skill/);
   │                        │  build skill+control prompts → prompts/; copy snapshot into
   │                        │  each cells/*__skill__*/skill/;
   │                        │  INSERT sessions(status=running) + 6N cell_metrics(status=pending,
   │                        │    one row per model × condition × replicate)
   └──────────┬─────────────┘
              ▼
   ┌────────────────────────┐
   │ 2. start web server    │  serves the app + /api/live (ephemeral) + /api/session (DB)
   └──────────┬─────────────┘
              ▼
   ┌────────────────────────┐      ┌──── per cell ×6N (parallel, ≤ cap) ──────┐
   │ 3. launch 6N builds    │─────▶│  claude -p  →  stream.jsonl (feed)        │
   │    (supervised)        │      │  server TAILS feed → /api/live (live      │
   │                        │      │     tokens/steps/activity)                │
   │                        │      │  at BUILD-END: parse once →               │
   │                        │      │    UPDATE cell_metrics(token counts,steps)│
   └──────────┬─────────────┘      └───────────────────────────────────────────┘
              │  wait for all 6N .done
              ▼
   ┌────────────────────────┐      ┌──── per cell ×6N (sequential) ───────────┐
   │ 4. run tests           │─────▶│  run-eval <output-dir> <result-path>     │
   │    (contract)          │      │    (harness times the phase)              │
   │                        │      │  live: status=testing + elapsed (memory)  │
   │                        │      │  runner writes result.json → <result-path>│
   │                        │      │  at TEST-END: read once → test_results +  │
   │                        │      │     cell_metrics(score_sum,total,status)  │
   │                        │      │  DELETE output/ + cell skill/ copy        │
   └──────────┬─────────────┘      └───────────────────────────────────────────┘
              ▼
   ┌────────────────────────┐
   │ 5. finalize            │  sessions.status = complete; reconcile any stale rows;
   │                        │  reindex from files (safety)
   └──────────┬─────────────┘
              ▼
   ┌────────────────────────┐
   │  report ready          │  same web app, history view
   └────────────────────────┘
```

### 7.2 Per-cell lifecycle — durable facts vs. an ephemeral live channel

```
   CELL: opus-skill (replicate 00 of N)   ░ transient (memory, never persisted)  █ durable (DB)

   ── BUILD PHASE ───────────────────────────────────────────────────────────
   claude -p
      │ append per turn: {usage, tool_use[id], result}
      ▼
   stream.jsonl  (feed, grows — ground truth)
      │ ░ server tails ───────────▶ /api/live  {tokens, steps, activity, startedAt}
      │ █ at BUILD-END: parse ONCE ─▶ cell_metrics{ input, cache_creation, cache_read,
      │                                 output (4 raw counts), steps=COUNT(tool_use) }
      │   (raw per-call records stay in stream.jsonl — never in the DB; COST/EFFORT are
      │    computed at query time from the four counts — §6)

   ── TEST PHASE ────────────────────────────────────────────────────────────
   harness spawns run-eval <output-dir> <result-path>; measures wall-clock start→exit
      │ ░ ───────────────────────▶ /api/live  {status:testing, startedAt}
      │
      │ runner writes ONE plain file to <result-path> at the end (no events, no live):
      ▼
   result.json  { "tests": [ {name, score} ] }
      │ █ at TEST-END: read ONCE ─▶ test_results{ name, score }
      │                          ─▶ cell_metrics{ score_sum, total, status }
      │
      └─ output/ + skill/ copy DELETED

   LIVE-ONLY (in /api/live, never persisted): climbing tokens/steps, activity,
   status (building/testing), elapsed timers (elapsed = now − startedAt, client-side).
```

Key points: the DB is written **only at the two phase boundaries** (build-end, test-end) —
never per tick. The test phase has **no live stream**: the skill produces one plain
`result.json` at the end, read once into the DB; the only live test signal is the harness's
own `status:testing` + elapsed clock.

---

## 8. The test contract (framework-agnostic)

The target skill owns *how* tests run; the tester owns *how results are stored*. The skill
exposes a minimal contract under its directory:

```
<target-skill>/
├── SKILL.md                       # name in frontmatter
└── eval/
    ├── eval.md                    # build Prompt + Required file names + Required element IDs
    └── run-eval <output-dir> <result-path>
                                   # runs tests against the deliverable at <output-dir>;
                                   #   writes ONE plain result.json to <result-path>
                                   #   (final score list — no live stream)
```

**Invocation:** the harness spawns `run-eval` from the runner's own directory (so its
config/deps resolve normally) and passes two absolute paths: the deliverable to test
(`cells/<cell>/output/`) and the exact file to write results to (`cells/<cell>/result.json`).
Both are the caller's decision — the runner hardcodes no placement: test `argv[1]`, write
`argv[2]`. That keeps the layout entirely the harness's business, and lets a skill maker run
the same script by hand against anything (`run-eval ./my-build ./tmp/results.json`).

This is the **floor every test framework can hit for free**: run the tests, dump a final
list of scores. No reporter hooks, no event schema, no id alignment. Playwright becomes *one
implementation behind this contract* rather than a tester assumption (its wrapper is one line
of mapping: passed → `1`, anything else → `0`). The v1 coupling (the reporter wrote the
harness's storage directly via `SKILL_TESTER_RESULTS` env vars) is gone: the runner writes a
documented file, and the **harness ingests it once** at test-end.

**`result.json` (the only required test output):**

```json
{
  "schemaVersion": 1,
  "tests": [
    { "name": "chat input produces a response", "score": 1 },
    { "name": "row-level F1 vs ground truth",   "score": 0.873, "detail": "P=0.91 R=0.84" },
    { "name": "send disabled during generation", "score": 0 }
  ]
}
```

`score` is a required number in `[0,1]`, **higher is better** — the only graded fact the
harness ingests. Binary checks are the degenerate case: exactly `0` or `1`. **The runner owns
grading**: a graded metric (F1, BLEU, cell-level similarity) reports its value directly;
anything unbounded or lower-is-better (RMSE, edit distance) is the author's job to map into
`[0,1]`. The harness never learns metric semantics — that is what keeps the contract
framework-agnostic. `detail` is an optional free-form string (raw precision/recall, an error
message) — it stays in `result.json` (always-keep tier, §9) and never enters the DB.

**The harness has no test universe of its own — `result.json` IS the test list.** There is
no skip state and no expected-test enumeration to check against: whatever the runner reports
is everything the harness knows, and how to treat a test that couldn't be evaluated (omit it,
or report it scored `0`) is entirely the skill author's call. `name` is the test's identity —
runner-assigned, unique within one result file, and the join key for per-test comparison
across cells; there are no test ids anywhere. `score_sum` = Σ scores, `total` = list length;
display order follows file order. Ingest is strict: a missing, NaN, or out-of-range score —
or a duplicate name — rejects the whole file and fails the cell; never clamp, clamping hides
runner bugs. The harness measures the test phase's wall-clock itself, so the skill never
reports timing.

**Why no live per-test stream (deliberately dropped):** a streamed `test-events.jsonl` would
force skill authors to instrument their framework's per-test lifecycle into our event schema —
real burden, for a phase that runs in seconds. The build phase (minutes long) already has rich
live progress for free, derived by the harness from `stream.jsonl`. So live per-test progress
is **not required**; the dashboard shows `testing… (elapsed)` then the full per-test grid the
moment the cell finishes. If richer live test progress is ever wanted, add it as an *optional*
enhancement (e.g. tester-shipped reporter adapters for Playwright/pytest that emit an event
stream) — never a gate on authoring a skill. `list-tests` is likewise unnecessary:
`result.json` already enumerates every test that ran.

---

## 9. Per-cell files & retention

| File          | Phase | Produced by        | Unique data                       | In DB? | Retention                         |
|---------------|-------|--------------------|-----------------------------------|--------|-----------------------------------|
| `stream.jsonl`| build | `claude -p`        | full build trajectory + token usage | no (only the 4 token counts + steps) | **purgeable** — keep latest + failures, drop old |
| `result.json` | test  | skill `run-eval`  | per-test scores (plain, final only) | feeds `test_results` + `cell_metrics(score_sum,total)` | keep (tiny, contract + rebuild)   |
| `stderr.log`  | build | claude CLI stderr  | CLI crashes/warnings              | no     | keep **only if non-empty**        |
| `output/`     | build | the model          | the deliverable under test        | no     | **never saved** — deleted after tests |
| cell `skill/` | prep  | session prep copy  | none — duplicate of session `skill/` | no  | deleted after tests (same purge as `output/`) |

```
   DISK PRESSURE  (largest → smallest)
   output/         ██████████████████████   → deleted every run
   stream.jsonl    ████████                 → purge old sessions
   cell skill/     █  (tiny duplicate)      → deleted every run
   stderr.log      █  (often empty)         → keep if non-empty
   result.json     ▏  (tiny)                → always keep
```

With **N replicates**, a session now holds `6N` `stream.jsonl` and `output/` dirs instead of 6,
so per-session disk scales linearly in N — the purge-old-`stream.jsonl` policy matters more, but
the rules are unchanged (working copies always-delete, snapshots always-keep).

The session-level `skill/` snapshot and `prompts/` are the opposite degenerate case:
kilobytes that never grow, backing `skill_hash` and `prompt_hash` — keep forever, no policy
needed. `prompts/` is additionally the only record of the treatment when a `--prompt` /
`--prompt-file` override is used (the assembled text is not derivable from the skill
snapshot). Every file this design adds has a binary retention rule: always-delete (working
copies) or always-keep (the snapshots).

---

## 10. Web app & reporting

One static page, served by the tiny existing server, with a small JSON API querying the DB.
The **live dashboard** and the **historical report** become two views of the same app — no
hardcoded/inlined data, no per-run HTML.

```
   ┌───────────────────────────────────────────────┐
   │  index.html   (tabs)                          │
   │  ┌─────────┬───────────┬──────────┬─────────┐ │
   │  │  Live   │ Comparison│ Instance │ History │ │
   │  └─────────┴───────────┴──────────┴─────────┘ │
   │            fetch() ── /api/* ──▶ index.db     │
   └───────────────────────────────────────────────┘
```

The **Live tab** polls `/api/live` (the ephemeral channel, served from server memory); the
**Comparison / Instance / History** tabs read the DB through the other endpoints. Two sources
is fine — a real-time feed and a historical query have different freshness needs.

Suggested endpoints:

| Endpoint                     | Returns                                             |
|------------------------------|-----------------------------------------------------|
| `GET /api/live`              | current session's transient snapshot — 6N cells × {live tokens/steps, status, startedAt}; from server memory, NOT the DB |
| `GET /api/sessions`          | list of sessions (id, skill, status, started_at)    |
| `GET /api/session/:id`       | one session: per-replicate cells + per-test results, plus query-time per-`(model, condition)` roll-ups (mean score, spread) |
| `GET /api/session/latest`    | newest session (replaces the `latest ->` symlink)   |
| `GET /api/metric?name=...`   | a metric across sessions for "over time" charts — grouped by (`skill_hash`, `model`): one point per skill version (mean over its replicates, pooled across all sessions of that version), in version order |

**Why an API and not "read the .db":** a static page can't run SQL against a binary `.db`.
Options considered:
1. **Small JSON API on the existing server — chosen.** Minimal new code; always current.
2. DB → JSON export after each run (static page reads `data.json`) — only as fresh as last export.
3. `sql.js` (WASM SQLite) in the browser — true single static file, but ~1 MB dep + downloads
   the whole DB. Fall back to this only if a zero-server setup is ever required.

**Example of what the report renders** (ASCII mock of the comparison bars):

```
   Score                skill ▓   control ░
   ────────────────────────────────────────────
   Opus     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  20/23
            ░░░░░░░░░░░░░░░░░░    18/23
   Sonnet   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    87.3%
            ░░░░░░░░░░░░          61.0%
   Haiku    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓        16/23
            ░░░░░░░░               9/23
```

Each `(model, condition)` now has **N replicates**, so the bar is the **mean across replicates**
of each replicate's mean score (`score_sum / total`), drawn with a spread (±SD or a min–max
whisker) so the skill-vs-control gap can be read against its noise. Only the **label** is derived
at render time: when every score in the cell is an integer (a purely binary suite), render the
familiar fraction `20/23`; if any score is fractional, render the mean as a percentage. Nothing
about the display — neither the mean nor the spread — is stored; it all rolls up at query time
over the N replicate rows. Alongside the score bars, the comparison view derives two token
columns per cell, each **averaged over replicates**, from the four raw counts: **cost**
(price-weighted per §11, skill carry included — the headline) and **effort** (output tokens +
steps — the behavior axis). Neither is stored; both are computed in the API/report layer.

---

## 11. Configuration

One config externalizes everything that v1 hardcoded across `live-results.js`,
`build-report.js`, `report.js`, `test-progress.html`, and `run-claude-build.js`.

```jsonc
{
  "matrix": {
    "models": [
      "claude-opus-4-6",              // exact CLI model IDs, in display order
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001"
    ],
    "conditions": ["skill", "control"],
    "replicates": 5                   // N — repeats of every (model, condition) cell, to average
                                      //   out LLM noise. Builds per session = models × conditions
                                      //   × replicates (= 6N); cost & wall-clock scale linearly in N.
  },
  "pricing": {
    "weights": {                      // relative to base input price — applied at QUERY time,
      "input": 1.0,                   //   never baked into stored rows (counts are facts,
      "cacheCreation": 1.25,          //   cost is an interpretation)
      "cacheRead": 0.1,
      "output": 5.0
    },
    "inputPerMTok": {                 // base $/M input tokens per model — multiplies the
      "claude-opus-4-6": 5.00,        //   weighted sum into DOLLARS; required for any
      "claude-sonnet-4-6": 3.00,      //   cross-model cost comparison
      "claude-haiku-4-5-20251001": 1.00
    }
  },
  "maxTurns": 50,
  "concurrency": 6,                   // max builds running at once; 6N can be large, so cap it
  "port": 5210,
  "schemaVersion": 1
}
```

The matrix (including the replicate count `N`), model→CLI mapping, the dashboard's column count
and per-cell spread, the report's grouping, the build concurrency cap, and the cost computation
(§6) all derive from this single object.

**Why pricing lives in config (not the DB):** prices are provider policy, not run facts — they
change over time and differ per model. The DB stores the four metered counts (what happened);
config stores the exchange rate (what it costs). A price change is a one-line config edit and
every historical session re-ranks correctly under the new prices — nothing stored goes stale.
The weights are currently uniform across Anthropic models (output 5×, cache write 1.25×, cache
read 0.1× of base input) and track each token type's *compute* — decode is sequential and
memory-bandwidth bound (dear), a cache read skips recompute (~0.1×). So the cost number serves
twice: it is what a skill author optimizes directly, **and** — because the weights track compute
— a proxy for the compute the skill route burns. (Price is compute *plus* margin, so the proxy
is approximate; but the relative weights across token types track compute well, which is all the
metric needs.) The per-model base rate turns weighted tokens into dollars, the only unit valid
for cross-model cost comparison.

**Why store the full model name as identity (not a short label):** the full version string is
the `model` value in the DB, the run-id suffix, and the x-axis identity for "metric over time."

- Each model version is its **own series** — a `-4-6` → `-4-8` bump is a different system, and a
  trend that spanned both would hide that confound. Separation is the methodologically honest
  default for a *skill* tester.
- The full name is both identity **and** provenance, so no separate `model_cli` column is needed.
- A short display name (`Opus`) is **derived at render time**; column **ordering** comes from the
  order of `models` in this config. Neither needs to be stored.

The skill-vs-control comparison is always within one session and one model, so it stays valid
regardless — model version only matters across sessions, which is exactly where you want the
series separated.

---

## 12. What transfers from v1

| Tier | Action | Files |
|------|--------|-------|
| **1 — near-verbatim** | copy, loosen matrix assumptions | `report-template.html`, `report.css`, `report.js`, `test-progress.html` |
| **2 — light edits**   | copy, externalize matrix/model-map | `file-lock.js`, `serve-progress.js`, `start-progress.js`, `live-results.js` (esp. `parseStreamMetrics`), `run-claude-build.js`, `build-report.js`, `write-summary.js` |
| **3 — rewrite / generalize** | replace Playwright assumption with the contract; DB ingest | `run-skill-test.js`, `prepare-runs.js`, `init-results.js` |
| **drop** | generated/one-off, or made obsolete by the plain-`result.json` contract (no live test stream, no `list-tests`) | `runs/_sessions/**`, `runs/*.json`, `tmp/**`, `references/output.json`, `_make-prompts.js`, `_launch-builds.sh`, `_run-remaining.sh`, `_cleanup-stale.ps1`, `extract-test-names.js`, `playwright-progress.config.mjs`, `progress-reporter.js`, `merge-results.js`, `mark-test-phase.js`, `write-fallback-tests.js` |

The gem to preserve: `parseStreamMetrics` in `live-results.js` — the token/step accounting
from `claude --output-format stream-json`. It is reused as-is, feeding both the live feed tail
and the single parse at build-end. It already computes the four-way usage breakdown (input /
cache creation / cache read / output) that v2's `cell_metrics` stores — no new parsing needed.

---

## 13. Implementation plan

```
   STEP 1  Config + skeleton
           └─ config.json (matrix, model map, pricing), data/ dir, open index.db, run DDL

   STEP 2  Session prep
           └─ copy skill folder → skill/ (canonical snapshot); skill_hash = hash(skill/);
              assemble skill+control prompts → prompts/ (skill.md embeds the SKILL.md
              body + points at ./skill/); copy snapshot → each cells/*__skill__*/skill/;
              INSERT sessions(status=running) +
              6N cell_metrics(status=pending; one row per model × condition × replicate)

   STEP 3  Build supervisor   (port parseStreamMetrics + run-claude-build.js)
           └─ spawn claude -p per cell (6N cells, launched up to the concurrency cap)
              → stream.jsonl; server tails feed → /api/live
              (live tokens/steps); at BUILD-END parse once → UPDATE cell_metrics
              (4 token counts, steps, status); write .done/.failed; reconcile on crash

   STEP 4  Web app + API       (port server + dashboard + report into one page)
           └─ /api/live (ephemeral), /api/sessions, /api/session/:id,
              /api/session/latest, /api/metric

   STEP 5  Test contract + ingest
           └─ run skill eval/run-eval <output-dir> <result-path> (spawned from the
              runner's own dir; harness times the phase; result-path = the cell's
              result.json); read it ONCE → test_results + cell_metrics(score_sum,total,status);
              DELETE output/ + the cell's skill/ copy

   STEP 6  Finalize + reindex
           └─ sessions.status=complete; reindex(session) rebuilds DB rows from files

   STEP 7  Retention
           └─ delete output/ + cell skill/ copies always; purge old stream.jsonl;
              drop empty stderr.log; the session skill/ snapshot is always kept
```

Dependency order: 1 → 2 → 3 → (4 in parallel) → 5 → 6 → 7.

---

## 14. Mutation-readiness (deferred)

Nothing below is built now. The point is that adding it is **additive** — new tables, new
columns, a new directory — never a reshape of what ships in v1.

```
   PHASE 1: TESTER  (this spec)
   ┌────────────────────────────────────────────┐
   │ files + index.db                           │
   │ sessions · cell_metrics · test_results     │
   └────────────────────────────────────────────┘
                │   add only, no reshape
                ▼
   PHASE 2: ANALYTICS
   ┌────────────────────────────────────────────┐
   │ same DB, richer queries                    │
   │ "metric over time" views in the History tab│
   └────────────────────────────────────────────┘
                │   add tables + genomes/
                ▼
   PHASE 3: MUTATOR
   ┌────────────────────────────────────────────┐
   │ + variants(hash PK, parent_hash, generation,│
   │            mutation_op, seed, created_at)    │
   │ + queue(variant_hash, status, claimed_by,   │
   │         claimed_at)                          │
   │ + genomes/<hash>/  (content-addressed skills)│
   │ sessions.skill_hash → variants.hash (FK)     │
   │ meta.json gains parentHash/mutationOp/seed   │
   └────────────────────────────────────────────┘
```

The two seams that make this work:
1. **`skill_hash` on every session** — today it's just the hash of the evaluated skill;
   later, mutated variants get their own hashes with `parent_hash` lineage.
2. **Immutable, append-only sessions** — the population accretes. Within one session the **N
   replicates** (§2) already give a variance estimate per skill version; across sessions, repeat
   evals of the same `skill_hash` accrete on top. Both feed the noise-averaging the mutator's
   selection needs, so it averages out LLM noise instead of chasing a single run.

Continuous scores (§8) are a third, accidental seam: a binary 23-test suite gives selection a
24-step staircase — most mutations move the score by exactly zero — while a graded metric
gives gradient on every eval, and non-inferiority tests on a continuous mean converge with
far fewer repeat evals than on a binomial pass rate.

Backfill when mutation lands: one `variants` row per existing distinct `skill_hash`
(`parent_hash = NULL`). **No existing row changes.**

When the mutator exists, its loop reads the DB (top-k selection, recursive-CTE lineage,
atomic queue claims) and writes genomes — the workload where the DB stops being optional and
becomes load-bearing.

---

## 15. Invariants & rules

```
   ┌─ FILES are authoritative; the DB is derived & rebuildable.
   ├─ NEVER overwrite — sessions are immutable and timestamped.
   ├─ stream.jsonl is canonical for tokens/steps; the DB caches the parsed scalars.
   ├─ The raw stream never enters the DB — only the derived scalars do: the FOUR raw token
   │  counts (input, cache_creation, cache_read, output) plus steps (COUNT of tool calls);
   │  per-call records stay on disk.
   ├─ NEVER persist any summed or weighted token number. Pricing weights live in config and
   │  are applied at query time only — counts are facts, cost is an interpretation.
   ├─ COST = price-weighted sum, skill carry INCLUDED — the headline metric. Cross-model
   │  cost comparisons are in dollars, never token counts.
   ├─ EFFORT = output_tokens + steps — the behavior axis; never price-weighted.
   ├─ No metric ever flat-sums token components — 1/1/1/1 overprices cache reads ~10× and
   │  underprices output ~5×; ranking on it optimizes skill length, not skill quality.
   ├─ Mutator selection (when built): minimize COST subject to statistically non-inferior
   │  mean score (multiple evals — never point-equality on one noisy run, and never a raw
   │  token sum).
   ├─ LIVE STATE NEVER TOUCHES THE DB. Timers, climbing token counts, and in-flight status
   │  live in the web-server's memory (/api/live), derived from the build feed + harness
   │  timers; elapsed is computed client-side. The DB is written ONLY at phase boundaries.
   ├─ The test contract requires only a final plain result.json — no live test stream is
   │  required (live per-test progress is an optional enhancement, never a gate).
   ├─ result.json is the runner→harness contract: run-eval <output-dir> <result-path>.
   │  The runner hardcodes no placement — both paths are the caller's decision.
   ├─ SCORES ARE FACTS; pass/fail is an interpretation. A test result is one REAL score in
   │  [0,1], higher-better; binary checks are the degenerate case {0,1}. No threshold is
   │  ever stored — fraction-vs-percent display is derived at render time.
   ├─ The runner owns grading (metric → [0,1]) AND the test list: result.json is the whole
   │  universe — no skip state, no expected-test list, no test ids. Tests are identified by
   │  name (runner-assigned, unique per cell). Ingest is strict: missing/NaN/out-of-range
   │  scores or duplicate names fail the cell — never clamp.
   ├─ All timing is live-only; only settled facts (tokens, steps, score_sum/total, per-test
   │  scores) are persisted.
   ├─ output/ is a working directory, deleted after tests — never an artifact; per-cell
   │  skill/ copies are purged with it.
   ├─ Skill delivery mirrors production: the prompt embeds the SKILL.md body; supporting
   │  files come from a per-cell ./skill/ copy inside cwd. Control cells get no copy —
   │  isolation is structural, never a launch flag. Cells never read the live skill dir.
   ├─ One framework-agnostic test-result shape, carrying a schemaVersion.
   ├─ No meta.json: skill content lives in the session skill/ snapshot (skill_hash is
   │  rebuildable from it); tester_version is DB-authoritative provenance.
   ├─ Every (model, condition) is measured over N replicates (§2); replicate is the 3rd identity
   │  axis — part of the PK, stored per row. Mean & variance across replicates are QUERY-TIME
   │  roll-ups, never stored — same rule as COST/EFFORT.
   ├─ `model` stores the FULL version string — each model version is its own series.
   └─ The matrix (models × conditions × N replicates) lives in config — never hardcode it in logic.
```

---

## 16. v1 issues fixed by this design

| v1 problem | Fix in v2 |
|------------|-----------|
| `results.json` does live state + durable record + derived cache in one file | split: DB holds settled facts (boundary writes only) vs an ephemeral live channel in server memory (`/api/live`); stream.jsonl stays the metric source |
| Run-id stable across sessions → each run **overwrites** history | immutable timestamped sessions; DB accumulates |
| ~250 lines of defensive schema-guessing in `test-progress.html` | one pinned schema with `schema_version` |
| 6 supervisors lock + rewrite one whole `results.json` per tick | the DB is written only at phase boundaries; live build metrics are served from the server's feed tail, so nothing writes the DB per tick |
| Report reads logs from `runs/<id>/stderr.log` but they live under `_sessions/...` → **Errors tab broken** | one canonical path resolution; report reads the DB / session dir |
| Playwright hardwired across the test layer | the framework-agnostic contract (§8) |
| Matrix + model map hardcoded in 5 files | single `config.json` (§11) |
| Per-run inlined `report.html` snapshots | one web app over `/api/*` (§10) |
| Exact model version never recorded → trends ambiguous after a CLI bump | `model` stores the full version string; each version is its own series |
| `--add-dir` pointed every cell — control included — at the skill dir, which the CLI announces in the agent's context → control condition could leak | only skill cells get a `./skill/` copy inside their cwd; no `--add-dir` at all; control isolation is structural |
| builds read the live skill folder → mid-session edits drift from what `skill_hash` recorded | session prep snapshots the skill once; cells read per-cell copies of that snapshot |
```
