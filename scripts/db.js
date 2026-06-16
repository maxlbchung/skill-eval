// The query store (design §4, §6). Files are ground truth; this DB is a derived,
// rebuildable projection of *settled* facts only. It is written exclusively by the
// orchestrator and only at phase boundaries (session start, build-end, test-end,
// finalize) — never per tick, and never any summed/weighted token number or any
// cross-replicate aggregate (those are query-time derivations in metrics.js).

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  skill_name     TEXT NOT NULL,
  skill_hash     TEXT NOT NULL,
  eval_hash      TEXT,
  prompt_hash    TEXT,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  tester_version TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cell_metrics (
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  model                 TEXT NOT NULL,
  condition             TEXT NOT NULL,
  replicate             INTEGER NOT NULL,
  score_sum             REAL,
  total                 INTEGER,
  input_tokens          INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  output_tokens         INTEGER,
  steps                 INTEGER,
  status                TEXT,
  PRIMARY KEY (session_id, model, condition, replicate)
);

CREATE TABLE IF NOT EXISTS test_results (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  model      TEXT NOT NULL,
  condition  TEXT NOT NULL,
  replicate  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  score      REAL NOT NULL,
  PRIMARY KEY (session_id, model, condition, replicate, name)
);

CREATE INDEX IF NOT EXISTS idx_cell_metrics_session ON cell_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_test_results_session ON test_results(session_id);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(DDL);
  // Migration for DBs created before eval_hash existed: CREATE TABLE IF NOT EXISTS won't add
  // the column, so add it here. Idempotent — the catch swallows "duplicate column" on re-open.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN eval_hash TEXT");
  } catch {
    /* column already exists */
  }
  return new Db(db);
}

class Db {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  // ---- writers (orchestrator only) ----------------------------------------

  insertSession(s) {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, skill_name, skill_hash, eval_hash, prompt_hash, status, started_at, ended_at, tester_version, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id,
        s.skill_name,
        s.skill_hash,
        s.eval_hash ?? null,
        s.prompt_hash ?? null,
        s.status,
        s.started_at,
        s.ended_at ?? null,
        s.tester_version ?? null,
        s.schema_version
      );
  }

  // Backfill/repair eval_hash from a session's eval/ snapshot (reindex, files-are-truth).
  updateSessionEvalHash(id, evalHash) {
    this.db.prepare(`UPDATE sessions SET eval_hash = ? WHERE id = ?`).run(evalHash ?? null, id);
  }

  // Seed one pending row per cell at session start.
  seedCells(sessionId, cellList) {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO cell_metrics (session_id, model, condition, replicate, status)
       VALUES (?, ?, ?, ?, 'pending')`
    );
    this.transaction(() => {
      for (const c of cellList) stmt.run(sessionId, c.model, c.condition, c.replicate);
    });
  }

  // BUILD-END: the four raw token counts + steps, parsed once from stream.jsonl.
  // status is 'failed' for a failed build, otherwise left 'pending' (tests still owed).
  writeBuildMetrics(sessionId, cell, m, status = "pending") {
    this.db
      .prepare(
        `UPDATE cell_metrics
            SET input_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?,
                output_tokens = ?, steps = ?, status = ?
          WHERE session_id = ? AND model = ? AND condition = ? AND replicate = ?`
      )
      .run(
        m.input ?? 0,
        m.cacheCreation ?? 0,
        m.cacheRead ?? 0,
        m.output ?? 0,
        m.steps ?? 0,
        status,
        sessionId,
        cell.model,
        cell.condition,
        cell.replicate
      );
  }

  // TEST-END: insert the per-test scores and settle the cell.
  // `tests` is already strictly validated ([{name, score}], scores in [0,1], unique names).
  ingestTests(sessionId, cell, tests) {
    const insert = this.db.prepare(
      `INSERT INTO test_results (session_id, model, condition, replicate, name, score)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const scoreSum = tests.reduce((a, t) => a + t.score, 0);
    const total = tests.length;
    this.transaction(() => {
      for (const t of tests) {
        insert.run(sessionId, cell.model, cell.condition, cell.replicate, t.name, t.score);
      }
      this.db
        .prepare(
          `UPDATE cell_metrics SET score_sum = ?, total = ?, status = 'complete'
            WHERE session_id = ? AND model = ? AND condition = ? AND replicate = ?`
        )
        .run(scoreSum, total, sessionId, cell.model, cell.condition, cell.replicate);
    });
    return { scoreSum, total };
  }

  setCellStatus(sessionId, cell, status) {
    this.db
      .prepare(
        `UPDATE cell_metrics SET status = ?
          WHERE session_id = ? AND model = ? AND condition = ? AND replicate = ?`
      )
      .run(status, sessionId, cell.model, cell.condition, cell.replicate);
  }

  // Clear per-test rows for a cell (used by reindex before re-ingesting from files).
  clearTestResults(sessionId, cell) {
    this.db
      .prepare(
        `DELETE FROM test_results
          WHERE session_id = ? AND model = ? AND condition = ? AND replicate = ?`
      )
      .run(sessionId, cell.model, cell.condition, cell.replicate);
  }

  finalizeSession(id, status, endedAt) {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(status, endedAt ?? null, id);
  }

  // Any cell left pending/null when the session ends crashed mid-flight → failed.
  reconcileStaleCells(sessionId, status = "failed") {
    return this.db
      .prepare(
        `UPDATE cell_metrics SET status = ?
          WHERE session_id = ? AND (status IS NULL OR status = 'pending')`
      )
      .run(status, sessionId).changes;
  }

  // ---- readers -------------------------------------------------------------

  getSession(id) {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) ?? null;
  }

  listSessions() {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY id DESC`).all();
  }

  // session ids are timestamp-prefixed, so lexical DESC == newest first.
  latestSession() {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT 1`).get() ?? null;
  }

  cellMetrics(sessionId) {
    return this.db
      .prepare(`SELECT * FROM cell_metrics WHERE session_id = ?`)
      .all(sessionId);
  }

  testResults(sessionId) {
    return this.db
      .prepare(`SELECT * FROM test_results WHERE session_id = ?`)
      .all(sessionId);
  }

  // ---- baseline reuse (Issue 3) -------------------------------------------
  // Apparatus = (model, eval_hash). The control depends only on it (never on skill_hash), so a
  // fresh control measurement can be reused across skill variants instead of re-run every session.

  // The baseline = the LAST fresh control run for (eval_hash, model): the control cell_metrics
  // (+ their test_results) of the most recent control-bearing complete session, never a pool over
  // all history. `maxAgeIso` gates freshness (older → not returned); `excludeSessionId` skips the
  // current session. Returns null when there is no usable baseline. (A future tightening could
  // pool multiple control runs that both fall inside the freshness window; the common loop has
  // exactly one control run per regime, so the last run IS the baseline.)
  regimeBaseline(evalHash, model, { maxAgeIso = null, excludeSessionId = null } = {}) {
    if (evalHash == null) return null;
    const params = [evalHash, model];
    let clause = "";
    if (maxAgeIso != null) { clause += " AND s.started_at >= ?"; params.push(maxAgeIso); }
    if (excludeSessionId != null) { clause += " AND s.id <> ?"; params.push(excludeSessionId); }
    const sess = this.db
      .prepare(
        `SELECT s.id, s.started_at
           FROM sessions s
          WHERE s.status = 'complete' AND s.eval_hash = ?
            AND EXISTS (SELECT 1 FROM cell_metrics cm
                         WHERE cm.session_id = s.id AND cm.model = ?
                           AND cm.condition = 'control' AND cm.status = 'complete')
            ${clause}
          ORDER BY s.started_at DESC
          LIMIT 1`
      )
      .get(...params);
    if (!sess) return null;
    const cells = this.db
      .prepare(
        `SELECT * FROM cell_metrics
          WHERE session_id = ? AND model = ? AND condition = 'control' AND status = 'complete'`
      )
      .all(sess.id, model);
    if (!cells.length) return null;
    const tests = this.db
      .prepare(`SELECT * FROM test_results WHERE session_id = ? AND model = ? AND condition = 'control'`)
      .all(sess.id, model);
    return { evalHash, model, sessionId: sess.id, epochStart: sess.started_at, n: cells.length, cells, tests };
  }

  regimeHasBaseline(evalHash, model, opts = {}) {
    return this.regimeBaseline(evalHash, model, opts) != null;
  }

  // The run defaults for a skill, derived from its most recent control-bearing (baseline) session:
  // the models it measured and the replicate count. These ARE the models + replicates chosen when
  // that baseline was initialized, so a later session reuses them automatically (no separate store).
  // A skill-only reuse session has no control cells, so it never becomes "the baseline" here — which
  // is exactly why a quick narrow/quick reuse run can't redefine the standing default. Returns null
  // when the skill has never measured a control baseline (→ fall back to config.json).
  baselineDefaults(skillName) {
    const s = this.db
      .prepare(
        `SELECT s.id, s.started_at
           FROM sessions s
          WHERE s.skill_name = ? AND s.status = 'complete'
            AND EXISTS (SELECT 1 FROM cell_metrics cm
                         WHERE cm.session_id = s.id AND cm.condition = 'control')
          ORDER BY s.started_at DESC
          LIMIT 1`
      )
      .get(skillName);
    if (!s) return null;
    const models = this.db
      .prepare(`SELECT DISTINCT model FROM cell_metrics WHERE session_id = ? AND condition = 'control'`)
      .all(s.id)
      .map((r) => r.model);
    // Replicates were seeded uniformly from matrix.replicates, so the distinct replicate count of
    // the control cells is the chosen N — counted over seeded rows (any status), so a crashed
    // control cell doesn't undercount the intended replicates.
    const { n } = this.db
      .prepare(`SELECT COUNT(DISTINCT replicate) AS n FROM cell_metrics WHERE session_id = ? AND condition = 'control'`)
      .get(s.id);
    if (!models.length || !(n >= 1)) return null;
    return { models, replicates: n, sessionId: s.id, startedAt: s.started_at };
  }

  // The latest complete session's apparatus for a skill (eval_hash + the models it measured) —
  // used to detect a regime change ("tests/model changed") before launching a new session.
  latestRegimeInfo(skillName) {
    const s = this.db
      .prepare(`SELECT * FROM sessions WHERE skill_name = ? AND status = 'complete' ORDER BY started_at DESC LIMIT 1`)
      .get(skillName);
    if (!s) return null;
    const models = this.db
      .prepare(`SELECT DISTINCT model FROM cell_metrics WHERE session_id = ?`)
      .all(s.id)
      .map((r) => r.model);
    return { evalHash: s.eval_hash, models, sessionId: s.id, startedAt: s.started_at };
  }

  // All cell metrics joined to their session (skill_hash, started_at) — the raw
  // material for "metric over time" grouping (done in metrics.js, not SQL).
  cellMetricsWithSession() {
    return this.db
      .prepare(
        `SELECT cm.*, s.skill_name, s.skill_hash, s.eval_hash, s.started_at
           FROM cell_metrics cm
           JOIN sessions s ON s.id = cm.session_id
          WHERE s.status = 'complete'`
      )
      .all();
  }
}

export { Db };
