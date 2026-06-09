// Query-time derivations (design §6, §10). NOTHING here is stored — COST, EFFORT, and
// the per-(model,condition) mean/spread roll-ups are computed from the raw counts on
// every read, so history re-ranks correctly after any pricing change.

// COST: price-weighted token sum × per-model base rate → dollars. Skill carry INCLUDED.
// Weights track per-token compute; a flat 1/1/1/1 sum is banned (it optimizes length).
export function cellCost(row, cfg) {
  const w = cfg.pricing.weights;
  const rate = cfg.pricing.inputPerMTok[row.model];
  if (rate == null) return null;
  const weighted =
    (row.input_tokens || 0) * w.input +
    (row.cache_creation_tokens || 0) * w.cacheCreation +
    (row.cache_read_tokens || 0) * w.cacheRead +
    (row.output_tokens || 0) * w.output;
  return (weighted * rate) / 1e6;
}

// EFFORT: output + steps, unweighted — the behavior axis, insensitive to prompt size.
export function cellEffort(row) {
  return (row.output_tokens || 0) + (row.steps || 0);
}

export function cellMeanScore(row) {
  return row.total > 0 ? row.score_sum / row.total : null;
}

function stats(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { mean: null, sd: 0, min: null, max: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd, min: Math.min(...v), max: Math.max(...v), n: v.length };
}

// Roll up one session into per-(model,condition) cells with mean/spread of score, cost,
// effort across replicates. `allInteger` drives fraction-vs-percent labels at render time.
export function sessionRollup(db, cfg, sessionId) {
  const session = db.getSession(sessionId);
  if (!session) return null;
  const rows = db.cellMetrics(sessionId);
  const tests = db.testResults(sessionId);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model} ${r.condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const cells = [];
  for (const [key, rs] of groups) {
    const [model, condition] = key.split(" ");
    const cellTests = tests.filter((t) => t.model === model && t.condition === condition);
    const allInteger = cellTests.length > 0 && cellTests.every((t) => Number.isInteger(t.score));
    cells.push({
      model,
      condition,
      replicates: rs.length,
      failed: rs.filter((r) => r.status === "failed").length,
      score: stats(rs.map(cellMeanScore)),
      passMean: stats(rs.map((r) => (r.total > 0 ? r.score_sum : null))).mean, // avg # passed (for fraction label)
      total: Math.max(0, ...rs.map((r) => r.total || 0)),
      cost: stats(rs.map((r) => cellCost(r, cfg))),
      effort: stats(rs.map(cellEffort)),
      steps: stats(rs.map((r) => r.steps)),
      allInteger,
    });
  }

  return {
    session,
    models: cfg.matrix.models,
    conditions: cfg.matrix.conditions,
    cells,
    cellMetrics: rows,
    testResults: tests,
  };
}

// "Metric over time": one point per skill version (skill_hash), grouped by
// (model, condition), pooled over replicates across all complete sessions of that
// version. name ∈ {score, cost, effort}. Points are ordered by first-seen.
export function overTime(db, cfg, name = "score") {
  const valueOf =
    name === "cost" ? (r) => cellCost(r, cfg) : name === "effort" ? cellEffort : cellMeanScore;
  const rows = db.cellMetricsWithSession();

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model} ${r.condition} ${r.skill_hash}`;
    if (!groups.has(key)) {
      groups.set(key, { model: r.model, condition: r.condition, skill_hash: r.skill_hash, skill_name: r.skill_name, firstSeen: r.started_at, values: [] });
    }
    const g = groups.get(key);
    if (r.started_at < g.firstSeen) g.firstSeen = r.started_at;
    const v = valueOf(r);
    if (v != null && Number.isFinite(v)) g.values.push(v);
  }

  const seriesMap = new Map();
  for (const g of groups.values()) {
    const sk = `${g.model} ${g.condition}`;
    if (!seriesMap.has(sk)) seriesMap.set(sk, []);
    const s = stats(g.values);
    seriesMap.get(sk).push({
      skillHash: g.skill_hash,
      skillName: g.skill_name,
      firstSeen: g.firstSeen,
      value: s.mean,
      sd: s.sd,
      n: s.n,
    });
  }

  const series = [];
  for (const [sk, points] of seriesMap) {
    const [model, condition] = sk.split(" ");
    points.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0));
    series.push({ model, condition, points });
  }
  return { name, models: cfg.matrix.models, conditions: cfg.matrix.conditions, series };
}
