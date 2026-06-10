// Single-page app: Live (polls /api/live, server memory) + Comparison / Instance /
// History (query the DB via /api/*). No data is hardcoded — models, conditions and
// columns all come from the API payload + config order.

const $ = (sel) => document.querySelector(sel);
const esc = (v) => { const d = document.createElement("div"); d.textContent = v == null ? "" : String(v); return d.innerHTML; };

let CFG = { models: [], conditions: ["skill", "control"], pricing: { weights: {}, inputPerMTok: {} } };
let selectedSessionId = null;
let rollup = null;          // /api/session/:id for the selected session
let liveSnapshot = null;    // /api/live/:id payload for the selected running session
let liveSessionsList = [];  // /api/live → sessions running right now (the run-picker list)
let liveSelectedId = null;  // which running session the Live board is streaming
let activeTab = "live";
let selectedSkill = null;   // nav skill-picker — filters all DB-backed views
let allSkills = [];
let allSessions = [];
let sessDayFilter = ""; // Instance session-picker day filter: "" = all days, else YYYY-MM-DD
let sidebarCollapsed = false; // History chart right sidebar

// ---------- formatting ----------
const fmtTokens = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return "–";
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  return v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v);
};
const fmtUsd = (d) => (d == null ? "–" : d >= 1 ? "$" + d.toFixed(2) : "$" + d.toFixed(4));
const fmtPct = (x) => (x == null ? "–" : (x * 100).toFixed(1) + "%");
const fmtElapsed = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};
const shortModel = (m) => {
  const s = m.toLowerCase();
  if (s.includes("opus")) return "Opus";
  if (s.includes("sonnet")) return "Sonnet";
  if (s.includes("haiku")) return "Haiku";
  return m;
};
const scoreColor = (v) => (v == null ? "var(--dim)" : v >= 0.8 ? "var(--pass)" : v >= 0.5 ? "var(--control)" : "var(--fail)");

function liveCost(tokens, model) {
  if (!tokens) return null;
  const w = CFG.pricing.weights || {};
  const rate = (CFG.pricing.inputPerMTok || {})[model];
  if (rate == null) return null;
  const weighted =
    (tokens.input || 0) * (w.input ?? 1) +
    (tokens.cacheCreation || 0) * (w.cacheCreation ?? 1) +
    (tokens.cacheRead || 0) * (w.cacheRead ?? 1) +
    (tokens.output || 0) * (w.output ?? 1);
  return (weighted * rate) / 1e6;
}

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- tabs ----------
function setTab(tab) {
  activeTab = tab;
  for (const b of document.querySelectorAll(".nav-btn")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".page")) p.classList.toggle("active", p.id === tab);
  if (tab === "instance") renderInstancePage();
  if (tab === "history") renderHistory();
}

// Instance tab: a date-grouped session picker (anchored on the banner), the skill-vs-control
// summary, then the per-test grid — all for one selected session of the current skill.
async function renderInstancePage() {
  let sessions = [];
  try { sessions = await getJson("/api/sessions"); } catch {}
  refreshSkills(sessions);
  const shown = selectedSkill ? sessions.filter((s) => s.skill_name === selectedSkill) : sessions;
  if (!shown.find((s) => s.id === selectedSessionId)) { selectedSessionId = shown[0]?.id || null; rollup = null; }
  await ensureSelected();
  renderBanner(shown);
  await renderComparison();
  await renderInstance();
  renderScatter();
  await renderErrorLogs();
}

function prettyDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${day}, ${y}`;
}

// Session banner: skill / status / hash / date on the left, a date-grouped session-picker
// popup anchored on the right.
function renderBanner(shown) {
  const el = $("#instance-banner");
  if (!el) return;
  if (!rollup) { el.innerHTML = ""; return; }
  const s = rollup.session;
  const reps = Math.max(0, ...rollup.cells.map((c) => c.replicates));
  el.innerHTML =
    `<div class="banner banner-row ${s.status === "failed" ? "failed" : ""}">
       <div class="banner-info">
         <strong>${esc(s.skill_name)}</strong> · ${esc(s.status)} · ${reps} replicate${reps === 1 ? "" : "s"} ·
         skill_hash <code>${esc(s.skill_hash.slice(0, 12))}</code> · ${esc(s.started_at)}
       </div>
       <div class="sess-pick" id="sess-pick">
         <button type="button" class="sess-btn">session <span class="dd-caret">▾</span></button>
         <div class="sess-panel" hidden></div>
       </div>
     </div>`;
  buildSessionPicker(shown || []);
}

// Popup list of this skill's sessions, grouped by day, with a day filter. Scrollable.
function buildSessionPicker(shown) {
  const root = $("#sess-pick");
  if (!root) return;
  const btn = root.querySelector(".sess-btn");
  const panel = root.querySelector(".sess-panel");

  const dates = [];
  for (const s of shown) { const d = s.started_at.slice(0, 10); if (!dates.includes(d)) dates.push(d); } // newest-first
  if (sessDayFilter && !dates.includes(sessDayFilter)) sessDayFilter = "";

  function render() {
    const groups = sessDayFilter ? [sessDayFilter] : dates;
    const list = groups.length
      ? groups.map((d) => {
          const items = shown.filter((s) => s.started_at.slice(0, 10) === d);
          return `<div class="sess-day">${esc(prettyDate(d))}</div>` +
            items.map((s) => `
              <button type="button" class="sess-item ${s.id === selectedSessionId ? "active" : ""}" data-id="${esc(s.id)}">
                <span class="sess-time">${esc(s.started_at.slice(11, 16))}</span>
                <span class="sess-status st-${esc(s.status)}">${esc(s.status)}</span>
                <span class="sess-hash">${esc((s.skill_hash || "").slice(0, 8))}</span>
              </button>`).join("");
        }).join("")
      : `<div class="empty" style="padding:.8rem">no sessions</div>`;
    panel.innerHTML =
      `<div class="sess-filter">
         <span>day</span>
         <select class="sess-day-sel">
           <option value="">all (${shown.length})</option>
           ${dates.map((d) => `<option value="${esc(d)}" ${d === sessDayFilter ? "selected" : ""}>${esc(prettyDate(d))} (${shown.filter((s) => s.started_at.slice(0, 10) === d).length})</option>`).join("")}
         </select>
       </div>
       <div class="sess-list">${list}</div>`;
    panel.querySelector(".sess-day-sel").onchange = (e) => { sessDayFilter = e.target.value; render(); };
    for (const it of panel.querySelectorAll(".sess-item")) {
      it.onclick = () => { panel.hidden = true; root.classList.remove("open"); selectedSessionId = it.dataset.id; rollup = null; renderInstancePage(); };
    }
  }

  panel.onclick = (e) => e.stopPropagation();
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeAllDropdowns();
    if (willOpen) { render(); panel.hidden = false; root.classList.add("open"); }
  };
}

// ---------- skill picker (nav) ----------
// Scopes every DB-backed view (History session list + iteration chart, Instance) to a
// single skill, so unrelated skills are never pooled onto one timeline. The Live tab is
// independent — it always shows whatever run is currently active.
function refreshSkills(sessions) {
  allSessions = sessions || [];
  const skills = [];
  for (const s of allSessions) if (!skills.includes(s.skill_name)) skills.push(s.skill_name); // sessions are newest-first
  allSkills = skills;
  if (!selectedSkill || !skills.includes(selectedSkill)) selectedSkill = skills[0] || null;
  buildSkillPicker();
}

function buildSkillPicker() {
  const host = $("#skill-picker");
  if (!host) return;
  if (!allSkills.length) { host.innerHTML = `<span class="sp-empty">no skills yet</span>`; return; }
  host.innerHTML =
    `<button type="button" class="sp-btn"><span class="dd-sum">${esc(selectedSkill || allSkills[0])}</span><span class="dd-caret">▾</span></button>` +
    `<div class="dd-panel sp-panel" hidden>${allSkills
      .map((s) => `<label class="dd-opt"><input type="radio" name="skillpick" ${s === selectedSkill ? "checked" : ""} data-k="${esc(s)}"><span>${esc(s)}</span></label>`)
      .join("")}</div>`;
  const btn = host.querySelector(".sp-btn");
  const panel = host.querySelector(".sp-panel");
  panel.onclick = (e) => e.stopPropagation();
  btn.onclick = (e) => { e.stopPropagation(); const willOpen = panel.hidden; closeAllDropdowns(); panel.hidden = !willOpen; };
  for (const inp of panel.querySelectorAll("input")) inp.onchange = () => { closeAllDropdowns(); selectSkill(inp.dataset.k); };
}

async function selectSkill(skill) {
  if (!skill) return;
  if (skill !== selectedSkill) {
    selectedSkill = skill;
    const latest = allSessions.find((s) => s.skill_name === skill); // newest session of this skill
    if (latest && latest.id !== selectedSessionId) { selectedSessionId = latest.id; rollup = null; }
  }
  buildSkillPicker();
  if (activeTab === "instance") await renderInstancePage();
  else if (activeTab === "history") await renderHistory();
}

// ---------- live ----------
async function pollLive() {
  let list = [];
  try { const r = await getJson("/api/live"); list = r.sessions || []; } catch { list = []; }
  liveSessionsList = list;
  // surface a brand-new skill (its first-ever run) in the nav picker without a manual refresh
  if (list.some((s) => s.skill && !allSkills.includes(s.skill))) {
    try { refreshSkills(await getJson("/api/sessions")); } catch {}
  }
  // keep the current selection if it's still live, else default to the newest running session
  if (!liveSelectedId || !list.some((s) => s.sessionId === liveSelectedId)) {
    liveSelectedId = list[0]?.sessionId || null;
  }
  if (liveSelectedId) {
    try { liveSnapshot = await getJson(`/api/live/${encodeURIComponent(liveSelectedId)}`); }
    catch { liveSnapshot = null; }
  } else {
    liveSnapshot = null;
  }
  renderLive();
}

// Run-picker: one chip per session running right now. With file-derived live state a single server
// shows every concurrent run, so this just switches which one the board streams (shown only when
// there's more than one to choose between).
function renderLiveRuns() {
  const host = $("#live-runs");
  if (!host) return;
  if (liveSessionsList.length <= 1) { host.innerHTML = ""; return; }
  host.innerHTML = liveSessionsList
    .map((s) => `<button type="button" class="chip ${s.sessionId === liveSelectedId ? "active" : ""}" data-id="${esc(s.sessionId)}">${esc(s.skill)}<span class="sub">${esc((s.startedAt || "").slice(11, 16))}</span></button>`)
    .join("");
  for (const b of host.querySelectorAll(".chip")) b.onclick = () => { liveSelectedId = b.dataset.id; pollLive(); };
}

function renderLive() {
  renderLiveRuns();
  const strip = $("#live-strip");
  const board = $("#live-board");
  if (!liveSnapshot || !liveSnapshot.sessionId) {
    strip.classList.add("idle");
    $("#live-title").textContent = liveSessionsList.length ? "Select a running session" : "No active session";
    $("#live-detail").textContent = liveSessionsList.length
      ? `${liveSessionsList.length} run${liveSessionsList.length === 1 ? "" : "s"} active`
      : "Start a run with: node scripts/run.js --skill-dir <dir>";
    board.innerHTML = "";
    return;
  }
  const cells = liveSnapshot.cells || [];
  const active = cells.filter((c) => c.status === "building" || c.status === "testing").length;
  const done = cells.filter((c) => c.status === "done" || c.status === "failed").length;
  strip.classList.toggle("idle", active === 0);
  $("#live-title").textContent = liveSnapshot.ended ? "Session complete" : `${active} cell${active === 1 ? "" : "s"} active`;
  $("#live-detail").textContent = `${done}/${cells.length} settled · session ${liveSnapshot.sessionId}`;

  const models = CFG.models.length ? CFG.models : [...new Set(cells.map((c) => c.model))];
  // Conditions become the two columns (skill | control); only render columns that actually occur.
  const conditions = (CFG.conditions?.length ? CFG.conditions : ["skill", "control"]).filter((cond) => cells.some((c) => c.condition === cond));
  const cardHtml = (c) => {
    const elapsed = (c.status === "building" || c.status === "testing") && c.startedAt ? fmtElapsed(Date.now() - c.startedAt) : "";
    const out = c.tokens?.output;
    const cost = liveCost(c.tokens, c.model);
    const meta =
      c.status === "pending"
        ? "queued"
        : [elapsed, out != null ? `${fmtTokens(out)} out` : null, c.steps ? `${c.steps} steps` : null, cost != null ? fmtUsd(cost) : null]
            .filter(Boolean)
            .join(" · ");
    return `
      <div class="cell-card ${c.status}">
        <div class="cc-top">
          <span class="cc-name">rep ${c.replicate}</span>
          <span class="cc-badge ${c.status}">${esc(c.status)}</span>
        </div>
        <div class="cc-meta">${esc(meta) || "&nbsp;"}</div>
      </div>`;
  };
  let html = "";
  for (const model of models) {
    const mcells = cells.filter((c) => c.model === model);
    if (!mcells.length) continue;
    html += `<div class="live-model"><div class="lm-title">${esc(shortModel(model))} <span class="cc-meta">${esc(model)}</span></div><div class="cond-cols">`;
    for (const cond of conditions) {
      const ccells = mcells.filter((c) => c.condition === cond).sort((a, b) => a.replicate - b.replicate);
      const cards = ccells.map(cardHtml).join("") || `<div class="cond-empty">—</div>`;
      html += `<div class="cond-col"><div class="cond-col-h ${esc(cond)}">${esc(cond)}</div><div class="cell-grid">${cards}</div></div>`;
    }
    html += `</div></div>`;
  }
  board.innerHTML = html;
}

// ---------- session loading ----------
async function loadSession(id) {
  selectedSessionId = id;
  rollup = await getJson(`/api/session/${encodeURIComponent(id)}`);
}

async function ensureSelected() {
  if (rollup && rollup.session?.id === selectedSessionId) return;
  if (selectedSessionId) await loadSession(selectedSessionId);
}

// ---------- comparison ----------
function cellFor(model, condition) {
  return (rollup?.cells || []).find((c) => c.model === model && c.condition === condition);
}

function scoreLabel(cell) {
  if (!cell || cell.score.mean == null) return cell?.failed ? "failed" : "–";
  if (cell.allInteger && cell.total) {
    const p = cell.passMean;
    return `${Number.isInteger(p) ? p : p.toFixed(1)}/${cell.total}`;
  }
  return fmtPct(cell.score.mean);
}

function barChart(title, legend, scaleMax, accessor, label) {
  const models = rollup.models.filter((m) => rollup.cells.some((c) => c.model === m));
  let rows = "";
  for (const model of models) {
    let group = `<div class="bar-group"><div class="bar-model-label">${esc(shortModel(model))}</div>`;
    for (const cond of rollup.conditions) {
      const cell = cellFor(model, cond);
      const stat = cell ? accessor(cell) : null;
      const mean = stat?.mean ?? 0;
      const w = scaleMax > 0 ? Math.max(2, (mean / scaleMax) * 100) : 0;
      const lo = stat && stat.n > 1 ? (stat.min / scaleMax) * 100 : null;
      const hi = stat && stat.n > 1 ? (stat.max / scaleMax) * 100 : null;
      const whisker = lo != null && hi != null && hi - lo > 0.5
        ? `<div class="bar-whisker" style="left:${lo.toFixed(1)}%;width:${(hi - lo).toFixed(1)}%"></div>` : "";
      const spread = stat && stat.n > 1 && stat.sd > 0 ? ` <span class="spread">±${(metricIsScore(accessor) ? (stat.sd * 100).toFixed(1) + "%" : fmtScalar(stat.sd))}</span>` : "";
      group += `
        <div class="bar-row">
          <span class="bar-cond">${esc(cond)}</span>
          <div class="bar-track">
            <div class="bar bar-${cond === "control" ? "control" : "skill"}" style="width:${w.toFixed(1)}%"></div>
            ${whisker}
          </div>
          <span class="bar-val">${esc(label(cell))}${spread}</span>
        </div>`;
    }
    rows += group + `</div>`;
  }
  return `<div class="chart-box"><div class="chart-title">${esc(title)}</div><div class="chart-legend">${legend}</div>${rows}</div>`;
}

let SCORE_ACCESSOR;
const metricIsScore = (acc) => acc === SCORE_ACCESSOR;
const fmtScalar = (n) => (n >= 1000 ? fmtTokens(n) : n.toFixed(n < 10 ? 1 : 0));

async function renderComparison() {
  await ensureSelected();
  const body = $("#comparison-body");
  if (!rollup) {
    body.innerHTML = `<div class="empty">No session selected.</div>`;
    return;
  }
  const legend = `<span class="legend-dot legend-skill"></span> skill <span class="legend-spacer"></span> <span class="legend-dot legend-control"></span> control`;

  SCORE_ACCESSOR = (c) => c.score;
  const costAcc = (c) => c.cost;
  const stepsAcc = (c) => c.steps;
  const maxCost = Math.max(0, ...rollup.cells.map((c) => c.cost.max ?? 0));
  const maxSteps = Math.max(0, ...rollup.cells.map((c) => c.steps?.max ?? 0));

  body.innerHTML =
    baselineNote() +
    `<div class="charts">
       ${barChart("Custom Eval Score", legend, 1, SCORE_ACCESSOR, scoreLabel)}
       ${barChart("Cost (Weighted Tokens)", legend, maxCost, costAcc, (c) => (c ? fmtUsd(c.cost.mean) : "–"))}
       ${barChart("Steps (Tool Call #)", legend, maxSteps, stepsAcc, (c) => (c ? fmtScalar(c.steps?.mean ?? 0) : "–"))}
     </div>`;
}

// Per-model note when a session's control came from a cached baseline (Issue 3) rather than
// being re-measured this session — flags that the skill-vs-control delta is unpaired.
function baselineNote() {
  const reused = (rollup?.cells || []).filter((c) => c.condition === "control" && c.fromBaseline);
  if (!reused.length) return "";
  const items = reused
    .map((c) => `${shortModel(c.model)} (n=${c.baseline?.n ?? c.replicates}${c.baseline?.epoch ? ", " + esc(c.baseline.epoch.slice(0, 10)) : ""})`)
    .join(", ");
  return `<div class="baseline-note">↺ control reused from a cached baseline for <strong>${items}</strong> — the skill−control delta is <em>unpaired</em> (skill measured this session vs control from an earlier session).</div>`;
}

// ---------- instance (per-test grid) ----------
// a (model,condition) column "failed" if any of its replicate runs failed (rollup.failed > 0)
const colFailed = (cell) => (cell?.failed || 0) > 0;

async function renderInstance() {
  await ensureSelected();
  const body = $("#instance-body");
  if (!rollup) { body.innerHTML = `<div class="empty">No session selected.</div>`; return; }
  const tests = rollup.testResults || [];
  if (!tests.length) { body.innerHTML = `<div class="empty">No test results for this session.</div>`; return; }

  // every (model,condition) column that has a cell, tagged with its run-completion state
  const cols = [];
  for (const m of rollup.models) for (const cond of rollup.conditions) {
    const cell = rollup.cells.find((c) => c.model === m && c.condition === cond);
    if (cell) cols.push({ model: m, condition: cond, cell });
  }

  // test name order: first appearance
  const names = [];
  for (const t of tests) if (!names.includes(t.name)) names.push(t.name);
  // mean score per (col, name)
  const key = (m, c, n) => `${m} ${c} ${n}`;
  const acc = new Map();
  for (const t of tests) {
    const k = key(t.model, t.condition, t.name);
    if (!acc.has(k)) acc.set(k, []);
    acc.get(k).push(t.score);
  }
  const meanOf = (m, c, n) => { const a = acc.get(key(m, c, n)); return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };

  // per-column run badge: ✓ N (all complete) or ⚠ ok/total (some failed)
  const runBadge = (cell) => {
    const total = cell.replicates || 0;
    const ok = total - (cell.failed || 0);
    return colFailed(cell)
      ? `<span class="run-badge fail" title="${cell.failed} of ${total} runs failed">⚠ ${ok}/${total}</span>`
      : `<span class="run-badge ok" title="all ${total} runs completed">✓ ${total}</span>`;
  };

  let head1 = `<tr><th class="rowhead group" rowspan="2">Test</th>`;
  let head2 = `<tr class="condrow">`;
  for (const m of rollup.models) {
    const mCols = cols.filter((c) => c.model === m);
    if (!mCols.length) continue;
    head1 += `<th class="group" colspan="${mCols.length}">${esc(shortModel(m))}</th>`;
    for (const col of mCols) head2 += `<th>${esc(col.condition)} <span class="run-badge-wrap">${runBadge(col.cell)}</span></th>`;
  }
  head1 += `</tr>`; head2 += `</tr>`;

  let rows = "";
  for (const n of names) {
    rows += `<tr><td class="rowhead">${esc(n)}</td>`;
    for (const col of cols) {
      const v = meanOf(col.model, col.condition, n);
      rows += `<td class="score-cell" style="color:${scoreColor(v)}">${v == null ? "–" : Number.isInteger(v) ? v : v.toFixed(3)}</td>`;
    }
    rows += `</tr>`;
  }
  // totals row: cell mean score
  let totals = `<tr class="totals"><td class="rowhead">mean</td>`;
  for (const col of cols) {
    totals += `<td class="score-cell">${col.cell ? fmtPct(col.cell.score.mean) : "–"}</td>`;
  }
  totals += `</tr>`;

  body.innerHTML = `<table>${head1}${head2}${rows}${totals}</table>`;
}

// ---------- error logs (failed runs) ----------
// Reads /api/session/:id/errors — the per-cell log files for runs the DB marks 'failed'.
const ERRLOG_LABELS = { failed: "reason", eval: "eval.log", stderr: "stderr.log", supervisor: "supervisor.log" };

async function renderErrorLogs() {
  const body = $("#errorlog-body");
  if (!body) return;
  if (!selectedSessionId) { body.innerHTML = `<div class="empty">No session selected.</div>`; return; }
  let data;
  try { data = await getJson(`/api/session/${encodeURIComponent(selectedSessionId)}/errors`); }
  catch { body.innerHTML = `<div class="empty">Could not load error logs.</div>`; return; }
  const runs = data?.runs || [];
  if (!runs.length) { body.innerHTML = `<div class="empty">No failed runs in this session.</div>`; return; }

  body.innerHTML = runs.map((r) => {
    const keys = Object.keys(r.logs || {});
    const tabs = keys.map((k, i) => `<button type="button" class="errlog-tab ${i === 0 ? "active" : ""}" data-k="${esc(k)}">${esc(ERRLOG_LABELS[k] || k)}</button>`).join("");
    const panes = keys.length
      ? keys.map((k, i) => `<pre class="errlog-pre ${i === 0 ? "active" : ""}" data-k="${esc(k)}">${esc(r.logs[k])}</pre>`).join("")
      : `<div class="empty" style="padding:.6rem 0">No log files on disk for this run.</div>`;
    return `
      <div class="errlog-card">
        <div class="errlog-head">
          <span class="cond-pill ${esc(r.condition)}">${esc(r.condition)}</span>
          <span class="errlog-model">${esc(shortModel(r.model))}</span>
          <span class="errlog-rep">rep ${esc(r.replicate)}</span>
          ${r.reason ? `<span class="errlog-reason">${esc(r.reason)}</span>` : ""}
        </div>
        ${tabs ? `<div class="errlog-tabs">${tabs}</div>` : ""}
        <div class="errlog-panes">${panes}</div>
      </div>`;
  }).join("");

  for (const tab of body.querySelectorAll(".errlog-tab")) {
    tab.onclick = () => {
      const card = tab.closest(".errlog-card");
      const k = tab.dataset.k;
      for (const t of card.querySelectorAll(".errlog-tab")) t.classList.toggle("active", t === tab);
      for (const p of card.querySelectorAll(".errlog-pre")) p.classList.toggle("active", p.dataset.k === k);
    };
  }
}

// ---------- metric scatter (one point per run, of the selected session) ----------
// Each point is a cell_metrics row (model × condition × replicate). Both axes pick any
// metric (the same METRIC_DEFS as the History chart, evaluated per raw row); a condition
// selector subsets to skill-only / control-only / both. Points are coloured by model.
const scatterState = { x: "cost", y: "score", condition: "both" };
const SCATTER_CONDITIONS = [{ key: "both", label: "both" }, { key: "skill", label: "skill" }, { key: "control", label: "control" }];
const SCATTER_COLORS = ["#3b82f6", "#a855f7", "#14b8a6", "#ec4899", "#eab308", "#f97316"];
const scatterModelColor = (m) => { const i = (rollup?.models || []).indexOf(m); return SCATTER_COLORS[(i < 0 ? 0 : i) % SCATTER_COLORS.length]; };

// metric-aware value formatter (cost → $, score → %, else token/number)
function fmtMetricVal(key, v) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (key === "cost") return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  if (key === "score") return v.toFixed(0) + "%";
  return Math.abs(v) >= 1000 ? fmtTokens(v) : Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function renderScatter() {
  const body = $("#scatter-body");
  if (!body) return;
  if (!rollup) { body.innerHTML = `<div class="empty">No session selected.</div>`; return; }
  body.innerHTML = `
    <div class="charts">
      <div class="chart-box scatter-graph">
        <div class="chart-title" id="scatter-caption">Metric scatter</div>
        <div id="scatter-area"></div>
        <div class="chart-tip" id="scatter-tip" hidden></div>
      </div>
      <div class="chart-box scatter-side">
        <div class="side-card-h">axes</div>
        <div id="scatter-controls"></div>
        <div class="side-card-h" style="margin-top:1.1rem">models</div>
        <div id="scatter-legend" class="leg-list"></div>
      </div>
    </div>`;
  const metricGroups = [...new Set(METRIC_DEFS.map((m) => m.cat))].map((cat) => ({
    cat,
    items: METRIC_DEFS.filter((m) => m.cat === cat).map((m) => ({ key: m.key, label: m.label })),
  }));
  const metricLabel = (k) => METRIC_DEFS.find((d) => d.key === k)?.label ?? k;
  $("#scatter-controls").append(
    dropdown({ label: "x axis", multi: false, groupsDefs: metricGroups, isOn: (k) => scatterState.x === k, pick: (k) => { scatterState.x = k; }, summarize: () => metricLabel(scatterState.x), onChange: drawScatter }),
    dropdown({ label: "y axis", multi: false, groupsDefs: metricGroups, isOn: (k) => scatterState.y === k, pick: (k) => { scatterState.y = k; }, summarize: () => metricLabel(scatterState.y), onChange: drawScatter }),
    dropdown({ label: "condition", multi: false, groupsDefs: [{ items: SCATTER_CONDITIONS }], isOn: (k) => scatterState.condition === k, pick: (k) => { scatterState.condition = k; }, summarize: () => scatterState.condition, onChange: drawScatter })
  );
  drawScatter();
}

function drawScatter() {
  const area = $("#scatter-area"), legendBox = $("#scatter-legend"), caption = $("#scatter-caption");
  if (!area) return;
  const tip = $("#scatter-tip"); if (tip) tip.hidden = true; // drop any stale hover from a prior render
  const setEmpty = (msg) => { area.innerHTML = `<div class="empty">${esc(msg)}</div>`; if (legendBox) legendBox.innerHTML = ""; if (caption) caption.textContent = ""; };
  if (!rollup) return setEmpty("No session selected.");
  const xDef = METRIC_DEFS.find((m) => m.key === scatterState.x);
  const yDef = METRIC_DEFS.find((m) => m.key === scatterState.y);
  // All runs with both metrics finite, across every condition — this set fixes the axis
  // scale so switching the condition only filters which points are drawn, never rescales.
  const allPts = (rollup.cellMetrics || [])
    .map((r) => ({ x: xDef.fn(r), y: yDef.fn(r), model: r.model, condition: r.condition, replicate: r.replicate, row: r }))
    .filter((p) => p.x != null && Number.isFinite(p.x) && p.y != null && Number.isFinite(p.y));
  if (!allPts.length) return setEmpty("No runs have both metrics for this selection.");
  const pts = allPts.filter((p) => scatterState.condition === "both" || p.condition === scatterState.condition);

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of allPts) { xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y); }
  if (xMin === xMax) { xMin -= 1; xMax += 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }

  const W = 540, H = 420, padL = 58, padR = 16, padT = 14, padB = 48;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xticks = niceTicks(xMin, xMax, 5), yticks = niceTicks(yMin, yMax, 5);
  const x0 = xticks[0], x1 = xticks[xticks.length - 1], y0 = yticks[0], y1 = yticks[yticks.length - 1];
  const xOf = (v) => padL + ((v - x0) / (x1 - x0)) * plotW;
  const yOf = (v) => padT + plotH - ((v - y0) / (y1 - y0)) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="iter-chart" preserveAspectRatio="xMidYMid meet">`;
  for (const t of yticks) {
    const y = yOf(t);
    svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    svg += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ytick">${esc(fmtMetricVal(scatterState.y, t))}</text>`;
  }
  for (const t of xticks) {
    const x = xOf(t);
    svg += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" class="grid"/>`;
    svg += `<text x="${x.toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" class="xtick">${esc(fmtMetricVal(scatterState.x, t))}</text>`;
  }
  svg += `<text x="${(padL + plotW / 2).toFixed(0)}" y="${H - 6}" class="axis-title">${esc(xDef.label)}</text>`;
  svg += `<text transform="translate(14 ${(padT + plotH / 2).toFixed(0)}) rotate(-90)" class="axis-title">${esc(yDef.label)}</text>`;
  pts.forEach((p, i) => {
    const c = scatterModelColor(p.model);
    svg += `<circle class="dot" data-idx="${i}" cx="${xOf(p.x).toFixed(1)}" cy="${yOf(p.y).toFixed(1)}" r="5" fill="${c}" fill-opacity="0.72" stroke="${c}" stroke-width="1.5"/>`;
  });
  svg += `</svg>`;
  area.innerHTML = svg;

  // hover a dot → rich tooltip with this run's identity and every metric value
  const svgEl = area.querySelector("svg");
  if (tip && svgEl) {
    const box = area.closest(".scatter-graph");
    const move = (e) => {
      const dot = e.target.classList?.contains("dot") ? e.target : null;
      const p = dot ? pts[+dot.dataset.idx] : null;
      if (!p) { tip.hidden = true; return; }
      tip.innerHTML = scatterTipHtml(p);
      tip.hidden = false;
      const br = box.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = e.clientX - br.left + 14, top = e.clientY - br.top + 14;
      if (left + tw > br.width) left = e.clientX - br.left - tw - 14;
      if (top + th > br.height) top = e.clientY - br.top - th - 14;
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = Math.max(4, top) + "px";
    };
    svgEl.addEventListener("mousemove", move);
    svgEl.addEventListener("mouseleave", () => { tip.hidden = true; });
  }

  caption.textContent = `${yDef.label} vs ${xDef.label} — ${scatterState.condition === "both" ? "skill & control" : scatterState.condition} · ${pts.length} run${pts.length === 1 ? "" : "s"}`;
  const present = [...new Set(pts.map((p) => p.model))];
  legendBox.innerHTML = present.map((m) => `<div class="leg-item"><span class="leg-dot" style="background:${scatterModelColor(m)}"></span><span>${esc(shortModel(m))}</span></div>`).join("");
}

// Hover-card body for one scatter dot: model/condition/rep plus every metric (the two
// plotted axes are flagged x/y and emphasised) evaluated against that run's raw row.
function scatterTipHtml(p) {
  const head =
    `<div class="tip-h"><span class="leg-dot" style="background:${scatterModelColor(p.model)}"></span>${esc(shortModel(p.model))}</div>` +
    `<div class="tip-sub"><span class="cond-pill ${esc(p.condition)}">${esc(p.condition)}</span>rep ${esc(String(p.replicate))}</div>`;
  const rows = METRIC_DEFS.map((d) => {
    const axis = d.key === scatterState.x ? "x" : d.key === scatterState.y ? "y" : "";
    return `<div class="tip-mrow${axis ? " active" : ""}"><span class="tip-mlabel">${esc(d.label)}${axis ? ` <em>${axis}</em>` : ""}</span><span class="tip-mval">${esc(fmtMetricVal(d.key, d.fn(p.row)))}</span></div>`;
  }).join("");
  return head + `<div class="tip-metrics">${rows}</div>`;
}

// ---------- history + iteration chart ----------
// The chart is driven by four modular controls: type · model · stats · metric.
// All aggregation is client-side over raw per-cell rows from /api/cells; the X axis is
// iterations (each completed session, in time order).
let cellsData = null;
const chartState = { type: "skill", mode: "pool", models: new Set(), stats: new Set(["mean"]), metric: "score" };

const TYPE_DEFS = [
  { key: "skill", label: "skill" },
  { key: "control", label: "control" },
  { key: "both", label: "vs" }, // skill vs control (both conditions shown)
  { key: "difference", label: "difference" }, // skill − control (can be ±)
];
const MODE_DEFS = [
  { key: "pool", label: "pool" }, // combine selected models into one series
  { key: "vs", label: "vs" }, // one series per model
];
const STAT_DEFS = [
  { key: "mean", label: "mean", dash: "" },
  { key: "median", label: "median", dash: "5,3" },
  { key: "min", label: "min", dash: "2,3" },
  { key: "max", label: "max", dash: "2,3" },
  { key: "q1", label: "lower quartile", dash: "6,3" },
  { key: "q3", label: "upper quartile", dash: "6,3" },
];
// cat groups the metric chips into labeled categories in the control.
const METRIC_DEFS = [
  { key: "score", cat: "eval score", label: "eval score", fn: (r) => (r.total ? (r.score_sum / r.total) * 100 : null) },
  { key: "input", cat: "tokens", label: "input", fn: (r) => r.input_tokens },
  { key: "cache_creation", cat: "tokens", label: "cache creation", fn: (r) => r.cache_creation_tokens },
  { key: "cache_read", cat: "tokens", label: "cache read", fn: (r) => r.cache_read_tokens },
  { key: "output", cat: "tokens", label: "output", fn: (r) => r.output_tokens },
  { key: "total_tokens", cat: "tokens", label: "total", fn: (r) => (r.input_tokens || 0) + (r.cache_creation_tokens || 0) + (r.cache_read_tokens || 0) + (r.output_tokens || 0) },
  { key: "cost", cat: "other", label: "cost ($)", fn: (r) => rowCost(r) },
  { key: "effort", cat: "other", label: "effort", fn: (r) => (r.output_tokens || 0) + (r.steps || 0) },
  { key: "steps", cat: "other", label: "steps", fn: (r) => r.steps },
];

function rowCost(r) {
  const w = CFG.pricing.weights || {};
  const rate = (CFG.pricing.inputPerMTok || {})[r.model];
  if (rate == null) return null;
  const weighted =
    (r.input_tokens || 0) * (w.input ?? 1) +
    (r.cache_creation_tokens || 0) * (w.cacheCreation ?? 1) +
    (r.cache_read_tokens || 0) * (w.cacheRead ?? 1) +
    (r.output_tokens || 0) * (w.output ?? 1);
  return (weighted * rate) / 1e6;
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function computeStats(vals) {
  const s = vals.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, sd, min: s[0], max: s[n - 1], median: pctile(s, 0.5), q1: pctile(s, 0.25), q3: pctile(s, 0.75), n };
}

const STAT_KEYS = ["mean", "median", "min", "max", "q1", "q3"];
// difference series = skill − control, computed per stat (so e.g. the mean line is the
// skill lift; it can be positive or negative).
function diffStats(a, b) {
  if (!a || !b) return null;
  const o = {};
  for (const k of STAT_KEYS) o[k] = a[k] != null && b[k] != null ? a[k] - b[k] : null;
  return o;
}

async function renderHistory() {
  let sessions = [];
  try { sessions = await getJson("/api/sessions"); } catch {}
  refreshSkills(sessions);

  try { cellsData = await getJson("/api/cells"); } catch { cellsData = []; }
  if (!CFG.models?.length) CFG.models = [...new Set((cellsData || []).map((r) => r.model))];
  if (chartState.models.size === 0) for (const m of CFG.models) chartState.models.add(m);

  $("#history-body").innerHTML = `
    <div class="chart-layout">
      <div class="chart-main">
        <div class="chart-header">
          <div class="chart-caption" id="chart-caption"></div>
          <div class="chart-toolbar" id="chart-toolbar">
            <button type="button" data-z="in" title="zoom in">+</button>
            <button type="button" data-z="out" title="zoom out">−</button>
            <button type="button" data-z="reset" title="fit (zoom out fully)">⤢</button>
          </div>
        </div>
        <div id="chart-area"></div>
        <div class="chart-tip" id="chart-tip" hidden></div>
      </div>
      <div class="chart-side-wrap">
        <button class="side-toggle" id="side-toggle" type="button">▶</button>
        <aside class="chart-side" id="chart-side">
          <div class="side-card"><div class="side-card-h">regime</div><div id="regime-controls"></div></div>
          <div class="side-card"><div class="side-card-h">controls</div><div id="chart-controls"></div></div>
          <div class="side-card"><div class="side-card-h">legend</div><div id="chart-legend"></div></div>
        </aside>
      </div>
    </div>`;
  buildControls();
  drawChart();

  // collapsible sidebar (arrow button centered on the divider)
  const sideEl = $("#chart-side");
  const sideToggle = $("#side-toggle");
  const applyCollapse = () => {
    sideEl.classList.toggle("collapsed", sidebarCollapsed);
    sideToggle.textContent = sidebarCollapsed ? "◀" : "▶";
    sideToggle.title = sidebarCollapsed ? "show panel" : "hide panel";
  };
  sideToggle.onclick = (e) => { e.stopPropagation(); sidebarCollapsed = !sidebarCollapsed; applyCollapse(); };
  applyCollapse();
}

// A dropdown (single- or multi-select). Multi keeps its panel open while you toggle;
// single closes on pick. Categories render as labeled sections inside the panel.
function dropdown({ label, multi, groupsDefs, isOn, pick, summarize, onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "dd";
  wrap.innerHTML = `
    <div class="dd-label">${esc(label)}</div>
    <button type="button" class="dd-btn"><span class="dd-sum"></span><span class="dd-caret">▾</span></button>
    <div class="dd-panel" hidden></div>`;
  const btn = wrap.querySelector(".dd-btn");
  const panel = wrap.querySelector(".dd-panel");
  const sumEl = wrap.querySelector(".dd-sum");
  const refreshSummary = () => { sumEl.textContent = summarize(); };
  function renderOpts() {
    panel.innerHTML = groupsDefs
      .map((g) =>
        (g.cat ? `<div class="dd-cat">${esc(g.cat)}</div>` : "") +
        g.items.map((o) => `<label class="dd-opt"><input type="${multi ? "checkbox" : "radio"}" ${isOn(o.key) ? "checked" : ""} data-k="${esc(o.key)}"><span>${esc(o.label)}</span></label>`).join("")
      )
      .join("");
    for (const inp of panel.querySelectorAll("input")) {
      inp.onchange = () => {
        pick(inp.dataset.k);
        refreshSummary();
        if (multi) renderOpts();
        else closeAllDropdowns();
        (onChange || redraw)();
      };
    }
  }
  panel.onclick = (e) => e.stopPropagation();
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeAllDropdowns();
    if (willOpen) { renderOpts(); panel.hidden = false; wrap.classList.add("open"); }
  };
  refreshSummary();
  return wrap;
}

function closeAllDropdowns() {
  for (const p of document.querySelectorAll(".dd-panel, .sess-panel")) p.hidden = true;
  for (const w of document.querySelectorAll(".dd.open, .sess-pick.open")) w.classList.remove("open");
}

function buildControls() {
  const host = $("#chart-controls");
  host.innerHTML = "";
  const modelDefs = (CFG.models || []).map((m) => ({ key: m, label: shortModel(m) }));
  const metricGroups = [...new Set(METRIC_DEFS.map((m) => m.cat))].map((cat) => ({
    cat,
    items: METRIC_DEFS.filter((m) => m.cat === cat).map((m) => ({ key: m.key, label: m.label })),
  }));
  const allModels = () => chartState.models.size === (CFG.models?.length || 0);

  host.append(
    dropdown({
      label: "type", multi: false, groupsDefs: [{ items: TYPE_DEFS }],
      isOn: (k) => chartState.type === k,
      pick: (k) => { chartState.type = k; },
      summarize: () => TYPE_DEFS.find((d) => d.key === chartState.type).label,
    }),
    dropdown({
      label: "model", multi: true, groupsDefs: [{ items: modelDefs }],
      isOn: (k) => chartState.models.has(k),
      pick: (k) => {
        chartState.models.has(k) ? chartState.models.delete(k) : chartState.models.add(k);
        if (chartState.models.size === 0) for (const m of CFG.models) chartState.models.add(m); // never empty → all
      },
      summarize: () => allModels() ? "all models" : chartState.models.size <= 2 ? [...chartState.models].map(shortModel).join(", ") : `${chartState.models.size} models`,
    }),
    dropdown({
      label: "mode", multi: false, groupsDefs: [{ items: MODE_DEFS }],
      isOn: (k) => chartState.mode === k,
      pick: (k) => { chartState.mode = k; },
      summarize: () => MODE_DEFS.find((d) => d.key === chartState.mode).label,
    }),
    dropdown({
      label: "stats", multi: true, groupsDefs: [{ items: STAT_DEFS }],
      isOn: (k) => chartState.stats.has(k),
      pick: (k) => {
        chartState.stats.has(k) ? chartState.stats.delete(k) : chartState.stats.add(k);
        if (chartState.stats.size === 0) chartState.stats.add("mean");
      },
      summarize: () => chartState.stats.size === STAT_DEFS.length ? "all stats" : chartState.stats.size <= 2 ? [...chartState.stats].map((k) => STAT_DEFS.find((d) => d.key === k).label).join(", ") : `${chartState.stats.size} stats`,
    }),
    dropdown({
      label: "metric", multi: false, groupsDefs: metricGroups,
      isOn: (k) => chartState.metric === k,
      pick: (k) => { chartState.metric = k; },
      summarize: () => METRIC_DEFS.find((d) => d.key === chartState.metric).label,
    })
  );
}
function redraw() { drawChart(); }

function drawChart() {
  const area = $("#chart-area");
  const caption = $("#chart-caption");
  const legendBox = $("#chart-legend");
  const toolbar = $("#chart-toolbar");
  const tipEl = $("#chart-tip"); if (tipEl) tipEl.hidden = true;
  const setEmpty = (msg) => {
    area.classList.remove("faceted");
    area.innerHTML = `<div class="empty">${esc(msg)}</div>`;
    caption.textContent = ""; legendBox.innerHTML = "";
    const rc = $("#regime-controls"); if (rc) rc.innerHTML = "";
  };
  if (!cellsData || !cellsData.length) return setEmpty("No completed sessions yet — run the tester to populate the chart.");

  // Group rows into iterations (sessions) for the selected skill, ordered by time, then split into
  // comparable regimes — one per (eval_hash, control epoch). Incomparable regimes never share an
  // axis; each is its own panel (Issue 2).
  const scoped = selectedSkill ? cellsData.filter((r) => r.skill_name === selectedSkill) : cellsData;
  if (!scoped.length) return setEmpty(`No completed sessions for ${selectedSkill || "this skill"} yet.`);
  const bySession = new Map();
  for (const r of scoped) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, { id: r.session_id, started_at: r.started_at, skill_name: r.skill_name, skill_hash: r.skill_hash, eval_hash: r.eval_hash, rows: [] });
    bySession.get(r.session_id).rows.push(r);
  }
  const iters = [...bySession.values()].sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  const regimes = computeRegimes(iters);
  buildRegimeControl(regimes);
  if (!regimes.length) return setEmpty("No data for this selection.");
  const sel = effectiveRegimeSel(regimes);

  // Shared caption + legend — the per-panel y-axes differ, but the series/metric selection is one.
  const { series, statKeys } = buildSeries();
  const metricDef = METRIC_DEFS.find((m) => m.key === chartState.metric);
  const allModels = chartState.models.size === (CFG.models?.length || 0);
  const typeLabel = { skill: "skill", control: "control", both: "skill vs control", difference: "skill − control" }[chartState.type] || chartState.type;
  const modelsLabel = allModels ? "all models" : [...chartState.models].map(shortModel).join(" + ");
  const pinned = regimes.find((r) => r.key === sel) || regimes[regimes.length - 1];
  const scopeLabel = sel === "all" ? `${regimes.length} regime${regimes.length === 1 ? "" : "s"} (faceted)` : `regime ${pinned.n}`;
  caption.textContent = `${metricDef.label} — ${typeLabel} · ${modelsLabel} · ${chartState.mode === "vs" ? "per model" : "pooled"} · ${scopeLabel}`;
  const legend = [];
  const seen = new Set();
  for (const s of series) for (const sk of statKeys) {
    const def = STAT_DEFS.find((d) => d.key === sk);
    const label = `${s.label ? s.label + " · " : ""}${def.label}`;
    const k = `${s.color}|${def.dash}|${label}`; if (seen.has(k)) continue; seen.add(k);
    legend.push({ color: s.color, dash: def.dash, label });
  }
  legendBox.innerHTML =
    legend.map((l) => `<div class="leg-item"><svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="${l.color}" stroke-width="2.4" stroke-dasharray="${l.dash}"/></svg><span>${esc(l.label)}</span></div>`).join("") +
    `<div class="leg-item leg-note"><svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,3"/></svg><span>control = flat baseline per regime</span></div>`;

  // Faceted overview (one static panel per regime, click to pin) vs a single pinned regime
  // (full-size, interactive zoom/pan + analysis). Panels never share a y-axis.
  if (sel === "all") {
    if (toolbar) toolbar.style.visibility = "hidden";
    area.classList.add("faceted");
    area.innerHTML = "";
    for (const r of regimes) {
      const host = document.createElement("div");
      host.className = "rg-panel";
      host.innerHTML = `<div class="rg-label">${regimeLabelHtml(r)}</div><div class="rg-svg"></div>`;
      host.onclick = () => { chartState.regimeSel = r.key; redraw(); };
      area.appendChild(host);
      renderRegimePanel(host, r, { interactive: false });
    }
  } else {
    if (toolbar) toolbar.style.visibility = "visible";
    area.classList.remove("faceted");
    area.innerHTML = "";
    const host = document.createElement("div");
    host.className = "rg-panel single";
    host.innerHTML = `<div class="rg-label"><button type="button" class="rg-back">‹ all regimes</button> ${regimeLabelHtml(pinned)}</div><div class="rg-svg"></div>`;
    host.querySelector(".rg-back").onclick = (e) => { e.stopPropagation(); chartState.regimeSel = "all"; redraw(); };
    area.appendChild(host);
    renderRegimePanel(host, pinned, { interactive: true });
  }
}

// Split time-ordered iterations into comparable regimes. A regime = one (eval_hash, control
// epoch): within an eval_hash, each session that ran control opens a new epoch and a skill-only
// session attaches to the most recent prior epoch. NULL eval_hash (pre-Issue-1) collapses into one
// "unknown" group. Regimes are returned in first-seen (time) order and numbered accordingly.
function computeRegimes(iters) {
  const regimes = [];
  const openByEval = new Map();
  let unknown = null;
  for (const it of iters) {
    const eh = it.eval_hash;
    const hasControl = it.rows.some((r) => r.condition === "control");
    if (eh == null) {
      if (!unknown) { unknown = { key: "unknown", evalHash: null, iters: [], controlIters: [] }; regimes.push(unknown); }
      unknown.iters.push(it);
      if (hasControl) unknown.controlIters.push(it);
      continue;
    }
    let cur = openByEval.get(eh);
    if (!cur || hasControl) {
      cur = { key: `${eh}#${regimes.length}`, evalHash: eh, iters: [], controlIters: [] };
      regimes.push(cur);
      openByEval.set(eh, cur);
    }
    cur.iters.push(it);
    if (hasControl) cur.controlIters.push(it);
  }
  regimes.forEach((r, i) => { r.n = i + 1; });
  return regimes;
}

// The per-(type/model/mode) series definition shared by the caption/legend and every panel.
function buildSeries() {
  const condGroups =
    chartState.type === "both" ? [{ key: "skill", color: "#22c55e", conds: ["skill"] }, { key: "control", color: "#f59e0b", conds: ["control"] }]
    : chartState.type === "difference" ? [{ key: "difference", color: "#3b82f6", conds: ["skill", "control"], diff: true }]
    : chartState.type === "control" ? [{ key: "control", color: "#f59e0b", conds: ["control"] }]
    : [{ key: "skill", color: "#22c55e", conds: ["skill"] }];
  const statKeys = STAT_DEFS.filter((s) => chartState.stats.has(s.key)).map((s) => s.key);
  const selModels = (CFG.models || []).filter((m) => chartState.models.has(m));
  const PALETTE = ["#22c55e", "#f59e0b", "#3b82f6", "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#ec4899"];
  const series = [];
  if (chartState.mode === "vs") {
    let ci = 0;
    for (const g of condGroups) for (const m of selModels) {
      series.push({ key: `${g.key}::${m}`, label: `${condGroups.length > 1 ? g.key + " · " : ""}${shortModel(m)}`, color: PALETTE[ci++ % PALETTE.length], group: g, models: [m] });
    }
  } else {
    for (const g of condGroups) series.push({ key: g.key, label: condGroups.length > 1 ? g.key : "", color: g.color, group: g, models: selModels });
  }
  return { condGroups, statKeys, selModels, series };
}

// Default regime selection = the latest (newest) regime, pinned full-size. "all" = faceted overview.
function effectiveRegimeSel(regimes) {
  const sel = chartState.regimeSel;
  if (sel === "all") return "all";
  if (sel && regimes.some((r) => r.key === sel)) return sel;
  return regimes.length ? regimes[regimes.length - 1].key : "all";
}

function regimeLabelHtml(r) {
  const tests = r.evalHash ? r.evalHash.slice(0, 8) : "unknown";
  const cdate = r.controlIters[0]?.started_at?.slice(0, 10) || "—";
  const models = [...new Set(r.iters.flatMap((it) => it.rows.map((x) => x.model)))].map(shortModel).join(", ");
  return `<strong>regime ${r.n}</strong> · tests <code>${esc(tests)}</code> · control ${esc(cdate)} · ${esc(models)}`;
}

// The regime selector dropdown (data-dependent → rebuilt each draw into #regime-controls).
function buildRegimeControl(regimes) {
  const host = $("#regime-controls");
  if (!host) return;
  host.innerHTML = "";
  const opts = [{ key: "all", label: "all (faceted)" }, ...regimes.map((r) => ({ key: r.key, label: `regime ${r.n}` }))];
  host.append(dropdown({
    label: "show", multi: false, groupsDefs: [{ items: opts }],
    isOn: (k) => effectiveRegimeSel(regimes) === k,
    pick: (k) => { chartState.regimeSel = k; },
    summarize: () => { const k = effectiveRegimeSel(regimes); return opts.find((o) => o.key === k)?.label ?? "latest"; },
    onChange: redraw,
  }));
}

// Render one regime into `host` (its OWN y-axis). Skill = the moving polyline; control = a flat
// baseline line + ±sd band (pooled over the regime's control cells, with a marker on the sessions
// that actually measured it). Interactive panels get zoom/pan + click-to-analyze; faceted panels
// are static and click to pin.
function renderRegimePanel(host, regime, { interactive }) {
  const area = host.querySelector(".rg-svg");
  const iters = regime.iters;
  const { series, statKeys } = buildSeries();
  const seriesByKey = new Map(series.map((s) => [s.key, s]));
  const metricDef = METRIC_DEFS.find((m) => m.key === chartState.metric);
  const isFlatControl = (s) => !s.group.diff && s.group.conds.includes("control");

  // members = the individual per-cell values behind a point (shown in the tooltip)
  const memberize = (rows, models) =>
    rows.filter((r) => models.includes(r.model)).map((r) => ({ label: `${shortModel(r.model)} · replicate ${r.replicate}`, value: metricDef.fn(r) })).filter((m) => m.value != null && Number.isFinite(m.value));

  // Control is constant within a regime (one epoch) → pool ALL of the regime's control cells into a
  // flat baseline reused at every x. Skill-only iters inherit the line; measured iters get a marker.
  const controlRows = iters.flatMap((it) => it.rows).filter((r) => r.condition === "control");
  const controlBaseline = new Map();
  for (const s of series) {
    if (isFlatControl(s) || s.group.diff) {
      const members = memberize(controlRows, s.models);
      controlBaseline.set(s.key, { stats: computeStats(members.map((m) => m.value)), members });
    }
  }
  const measuredByIter = iters.map((it) => it.rows.some((r) => r.condition === "control"));

  const perIter = iters.map((it, idx) => {
    const out = {};
    for (const sx of series) {
      if (sx.group.diff) {
        const skMembers = memberize(it.rows.filter((r) => r.condition === "skill"), sx.models);
        const skStats = computeStats(skMembers.map((m) => m.value));
        const co = controlBaseline.get(sx.key);
        out[sx.key] = { stats: diffStats(skStats, co?.stats), skStats, coStats: co?.stats, skMembers, coMembers: co?.members || [], diff: true };
      } else if (isFlatControl(sx)) {
        const co = controlBaseline.get(sx.key);
        out[sx.key] = { stats: co?.stats || null, members: co?.members || [], flat: true, measured: measuredByIter[idx] };
      } else {
        const members = memberize(it.rows.filter((r) => sx.group.conds.includes(r.condition)), sx.models);
        out[sx.key] = { stats: computeStats(members.map((m) => m.value)), members };
      }
    }
    return out;
  });

  // ---- data extents → base ("fit") domain ----
  const n = iters.length;
  let yLo = Infinity, yHi = -Infinity;
  for (const st of perIter) for (const s of series) {
    const ss = st[s.key]?.stats; if (!ss) continue;
    for (const k of statKeys) { const v = ss[k]; if (v != null) { yLo = Math.min(yLo, v); yHi = Math.max(yHi, v); } }
  }
  if (!Number.isFinite(yLo)) { area.innerHTML = `<div class="empty" style="padding:1rem">No data for this selection.</div>`; return; }
  if (yLo === yHi) { yLo -= 1; yHi += 1; }
  const yt0 = niceTicks(yLo, yHi, 5);
  const yBase = [yt0[0], yt0[yt0.length - 1]];
  const xBase = n > 1 ? [-0.4, n - 1 + 0.4] : [-0.6, 0.6];

  const arect = area.getBoundingClientRect();
  const W = arect.width > 50 ? Math.round(arect.width) : 1000;
  const H = arect.height > 50 ? Math.round(arect.height) : 480;
  const padL = 60, padR = 18, padT = 14, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // the visible data domain — zoom/pan changes THIS (rescaling the points); the axes
  // stay pinned to the plot borders and their ticks recompute for the visible range.
  const dom = { x0: xBase[0], x1: xBase[1], y0: yBase[0], y1: yBase[1] };
  const sx = (i) => padL + ((i - dom.x0) / (dom.x1 - dom.x0)) * plotW;
  const sy = (v) => padT + plotH - ((v - dom.y0) / (dom.y1 - dom.y0)) * plotH;
  const ix = (px) => dom.x0 + ((px - padL) / plotW) * (dom.x1 - dom.x0);
  const iv = (py) => dom.y0 + ((padT + plotH - py) / plotH) * (dom.y1 - dom.y0);

  // skeleton: axes group (pinned) + clipped plot group (the part that zooms/pans)
  area.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="iter-chart">` +
    `<defs><clipPath id="plotclip"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"></rect></clipPath></defs>` +
    `<g class="axes"></g><g class="plot" clip-path="url(#plotclip)"></g></svg>`;
  const svgEl = area.querySelector("svg");
  const axesG = svgEl.querySelector(".axes");
  const plotG = svgEl.querySelector(".plot");

  const bandPath = (gkey, loK, hiK, color, opacity) => {
    const top = [], bot = [];
    perIter.forEach((st, i) => { const s = st[gkey]?.stats; if (s && s[loK] != null && s[hiK] != null) { top.push([sx(i), sy(s[hiK])]); bot.push([sx(i), sy(s[loK])]); } });
    if (!top.length) return "";
    const pts = top.concat(bot.reverse()).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `<polygon points="${pts}" fill="${color}" opacity="${opacity}" stroke="none"/>`;
  };

  function renderAxes() {
    let a = "";
    for (const t of niceTicks(dom.y0, dom.y1, 5)) {
      if (t < dom.y0 - 1e-9 || t > dom.y1 + 1e-9) continue;
      const y = sy(t);
      a += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
      a += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ytick">${esc(fmtY(t))}</text>`;
    }
    const i0 = Math.max(0, Math.ceil(dom.x0 - 1e-9));
    const i1 = Math.min(n - 1, Math.floor(dom.x1 + 1e-9));
    const step = Math.max(1, Math.ceil((i1 - i0 + 1) / Math.max(1, Math.floor(plotW / 78))));
    for (let i = i0; i <= i1; i += step) {
      const x = sx(i);
      a += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" class="grid gridx"/>`;
      a += `<text x="${x.toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" class="xtick">${esc(iters[i].started_at.slice(5, 16).replace("T", " "))}</text>`;
    }
    a += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${(padT + plotH).toFixed(1)}" class="axisline"/>`;
    a += `<line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${W - padR}" y2="${(padT + plotH).toFixed(1)}" class="axisline"/>`;
    a += `<text x="${(padL + plotW / 2).toFixed(0)}" y="${(H - 4).toFixed(0)}" class="axis-title">iteration (session over time)</text>`;
    if (chartState.type === "difference" && dom.y0 < 0 && dom.y1 > 0) {
      const yz = sy(0);
      a += `<line x1="${padL}" y1="${yz.toFixed(1)}" x2="${W - padR}" y2="${yz.toFixed(1)}" class="zeroline"/>`;
    }
    axesG.innerHTML = a;
  }

  function renderPlot() {
    let p = "", hits = "";
    // shaded spread bands for the moving (non-flat) series
    for (const s of series) {
      if (s.group.diff || isFlatControl(s)) continue;
      if (chartState.stats.has("min") && chartState.stats.has("max")) p += bandPath(s.key, "min", "max", s.color, 0.08);
      if (chartState.stats.has("q1") && chartState.stats.has("q3")) p += bandPath(s.key, "q1", "q3", s.color, 0.16);
    }
    // flat control baseline: a full-width horizontal reference line at the mean + a ±sd band, with a
    // marker only on the sessions that actually measured control (skill-only iters inherit the line).
    for (const s of series) {
      if (!isFlatControl(s)) continue;
      const stt = controlBaseline.get(s.key)?.stats; if (!stt) continue;
      if (stt.sd > 0) {
        const yTop = sy(stt.mean + stt.sd), yBot = sy(stt.mean - stt.sd);
        p += `<rect x="${padL.toFixed(1)}" y="${Math.min(yTop, yBot).toFixed(1)}" width="${plotW.toFixed(1)}" height="${Math.abs(yBot - yTop).toFixed(1)}" fill="${s.color}" opacity="0.1"/>`;
      }
      if (statKeys.includes("mean")) {
        const y = sy(stt.mean);
        p += `<line x1="${padL.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${s.color}" stroke-width="2" stroke-dasharray="4,3" opacity="0.95"/>`;
        perIter.forEach((st, i) => {
          if (!st[s.key]?.measured) return;
          const x = sx(i);
          p += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${s.color}"/>`;
          hits += `<circle class="pt" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="transparent" data-g="${esc(s.key)}" data-i="${i}" data-sk="mean"/>`;
        });
      }
    }
    // moving series (skill, difference): polylines + per-iteration markers
    for (const s of series) {
      if (isFlatControl(s)) continue;
      for (const sk of statKeys) {
        const def = STAT_DEFS.find((d) => d.key === sk);
        const pts = [];
        perIter.forEach((st, i) => { const v = st[s.key]?.stats?.[sk]; if (v != null) pts.push({ x: sx(i), y: sy(v), i }); });
        if (!pts.length) continue;
        const isMean = sk === "mean";
        p += `<polyline points="${pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${isMean ? 2.4 : 1.4}" stroke-dasharray="${def.dash}" opacity="${isMean ? 1 : 0.82}"/>`;
        for (const q of pts) {
          p += `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${isMean ? 3 : 2.2}" fill="${s.color}"/>`;
          hits += `<circle class="pt" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="9" fill="transparent" data-g="${esc(s.key)}" data-i="${q.i}" data-sk="${esc(sk)}"/>`;
        }
      }
    }
    plotG.innerHTML = p + hits;
  }

  const tip = $("#chart-tip");
  const renderView = () => { tip.hidden = true; renderAxes(); renderPlot(); };

  // Interactive (pinned) panels get zoom/pan + click-to-analyze; faceted panels are static.
  if (interactive) {
  // ---- zoom / pan: change the DATA domain (axes stay pinned, ticks recompute) ----
  const minXW = (xBase[1] - xBase[0]) / 50, minYW = (yBase[1] - yBase[0]) / 50;
  const zoomAt = (cx, cy, f) => {
    const xw = clamp((dom.x1 - dom.x0) * f, minXW, xBase[1] - xBase[0]);
    const yw = clamp((dom.y1 - dom.y0) * f, minYW, yBase[1] - yBase[0]);
    const rx = (cx - dom.x0) / (dom.x1 - dom.x0), ry = (cy - dom.y0) / (dom.y1 - dom.y0);
    const x0 = clamp(cx - rx * xw, xBase[0], xBase[1] - xw);
    const y0 = clamp(cy - ry * yw, yBase[0], yBase[1] - yw);
    dom.x0 = x0; dom.x1 = x0 + xw; dom.y0 = y0; dom.y1 = y0 + yw;
    renderView();
  };
  svgEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    const pxX = clamp((e.clientX - r.left) / r.width * W, padL, padL + plotW);
    const pxY = clamp((e.clientY - r.top) / r.height * H, padT, padT + plotH);
    zoomAt(ix(pxX), iv(pxY), e.deltaY < 0 ? 0.85 : 1 / 0.85);
  }, { passive: false });
  svgEl.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return; // middle button = pan
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY, d0 = { ...dom };
    const xw = d0.x1 - d0.x0, yw = d0.y1 - d0.y0;
    svgEl.classList.add("panning");
    const mv = (ev) => {
      const ddx = ((ev.clientX - startX) / r.width * W) / plotW * xw;
      const ddy = ((ev.clientY - startY) / r.height * H) / plotH * yw;
      const x0 = clamp(d0.x0 - ddx, xBase[0], xBase[1] - xw);
      const y0 = clamp(d0.y0 + ddy, yBase[0], yBase[1] - yw);
      dom.x0 = x0; dom.x1 = x0 + xw; dom.y0 = y0; dom.y1 = y0 + yw;
      renderView();
    };
    const up = () => { svgEl.classList.remove("panning"); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
  svgEl.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  const tb = $("#chart-toolbar");
  if (tb) for (const b of tb.querySelectorAll("button")) {
    b.onclick = (e) => {
      e.stopPropagation();
      const cx = (dom.x0 + dom.x1) / 2, cy = (dom.y0 + dom.y1) / 2;
      if (b.dataset.z === "in") zoomAt(cx, cy, 0.8);
      else if (b.dataset.z === "out") zoomAt(cx, cy, 1.25);
      else { dom.x0 = xBase[0]; dom.x1 = xBase[1]; dom.y0 = yBase[0]; dom.y1 = yBase[1]; renderView(); }
    };
  }

  // ---- click-to-analyze: popup anchored next to the clicked point ----
  tip.hidden = true;
  tip.onclick = (e) => e.stopPropagation();
  const memberBlock = (title, members) =>
    members?.length
      ? `<div class="tip-sub">${members.length} ${esc(title)}</div><div class="tip-vals">${members.map((m) => `${esc(m.label)}: ${esc(fmtStat(null, m.value))}`).join("<br>")}</div>`
      : "";
  const tipHtml = (ds) => {
    const i = +ds.i, gk = ds.g, sk = ds.sk;
    const rich = perIter[i]?.[gk]; if (!rich) return "";
    const it = iters[i];
    const when = it.started_at.slice(0, 16).replace("T", " ");
    const statLabel = STAT_DEFS.find((s) => s.key === sk).label;
    const ser = seriesByKey.get(gk);
    const head = `<div class="tip-h">${esc(metricDef.label)}${ser?.label ? " · " + esc(ser.label) : ""}</div><div class="tip-sub">${esc(it.skill_name)} · ${esc((it.skill_hash || "").slice(0, 8))} · ${esc(when)}</div>`;
    const body = rich.diff
      ? `<div class="tip-row"><b>${esc(statLabel)} Δ</b>: ${esc(fmtSigned(sk, rich.stats[sk]))}</div>` +
        `<div class="tip-sub">skill ${esc(fmtStat(sk, rich.skStats?.[sk]))} − control ${esc(fmtStat(sk, rich.coStats?.[sk]))}</div>` +
        memberBlock("skill values", rich.skMembers) + memberBlock("control values", rich.coMembers)
      : `<div class="tip-row"><b>${esc(statLabel)}</b>: ${esc(fmtStat(sk, rich.stats[sk]))}</div>` +
        memberBlock("values used", rich.members);
    return head + body + `<button type="button" class="tip-open" data-id="${esc(it.id)}">open in Instance →</button>`;
  };
  const positionTip = (el) => {
    const cr = el.getBoundingClientRect();
    const mr = $(".chart-main").getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = cr.right - mr.left + 12;
    if (left + tw > mr.width) left = cr.left - mr.left - tw - 12; // flip to the left edge
    let top = clamp(cr.top - mr.top + cr.height / 2 - th / 2, 4, Math.max(4, mr.height - th - 4));
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = top + "px";
  };
  svgEl.addEventListener("click", (e) => {
    const t = e.target;
    if (!t.classList?.contains("pt")) return;
    e.stopPropagation();
    const key = `${t.dataset.g}|${t.dataset.i}|${t.dataset.sk}`;
    plotG.querySelectorAll(".pt.sel").forEach((el) => el.classList.remove("sel"));
    if (!tip.hidden && tip.dataset.pt === key) { tip.hidden = true; return; } // click the same dot → close
    t.classList.add("sel"); // mark the selected point
    tip.dataset.pt = key;
    tip.innerHTML = tipHtml(t.dataset);
    tip.hidden = false;
    positionTip(t);
    const ob = tip.querySelector(".tip-open");
    if (ob) ob.onclick = (ev) => { ev.stopPropagation(); tip.hidden = true; selectedSessionId = ob.dataset.id; rollup = null; setTab("instance"); };
  });
  }

  renderView();
}


// y-axis tick formatter (metric units).
function fmtY(v) {
  const m = chartState.metric;
  if (m === "cost") return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
  if (m === "score") return v.toFixed(0) + "%";
  return Math.abs(v) >= 1000 ? fmtTokens(v) : Number.isInteger(v) ? String(v) : v.toFixed(2);
}
// stat-value formatter (count/cv are unitless; everything else is in metric units).
function fmtStat(sk, v) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (sk === "count") return String(Math.round(v));
  if (sk === "cv") return v.toFixed(3);
  const m = chartState.metric;
  if (m === "cost") return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
  if (m === "score") return v.toFixed(1) + "%";
  return Math.abs(v) >= 1000 ? fmtTokens(v) : Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function fmtSigned(sk, v) {
  return v == null || !Number.isFinite(v) ? "–" : (v >= 0 ? "+" : "") + fmtStat(sk, v);
}
function niceTicks(min, max, count) {
  const range = niceNum(max - min || 1, false);
  const step = niceNum(range / (count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * 10 ** exp;
}

// ---------- init ----------
async function init() {
  for (const b of document.querySelectorAll(".nav-btn")) b.onclick = () => setTab(b.dataset.tab);
  document.addEventListener("click", closeAllDropdowns); // close open dropdowns on outside click
  document.addEventListener("click", () => { // close analysis popup + clear point selection
    const t = $("#chart-tip"); if (t) t.hidden = true;
    document.querySelectorAll(".iter-chart .pt.sel").forEach((el) => el.classList.remove("sel"));
  });
  const setNavH = () => document.documentElement.style.setProperty("--nav-h", (document.querySelector("nav")?.offsetHeight || 56) + "px");
  setNavH();
  try { CFG = await getJson("/api/config"); } catch {}
  try {
    const sessions = await getJson("/api/sessions");
    refreshSkills(sessions);
    if (sessions.length) selectedSessionId = sessions[0].id;
  } catch {}
  setTab("live");
  pollLive();
  setInterval(pollLive, 1500);
  setInterval(() => { if (activeTab === "live") renderLive(); }, 1000); // tick elapsed
  let resizeT;
  window.addEventListener("resize", () => { setNavH(); clearTimeout(resizeT); resizeT = setTimeout(() => { if (activeTab === "history" && cellsData) drawChart(); }, 150); });
  $("#nav-meta").textContent = "";
  setInterval(() => { $("#nav-meta").textContent = new Date().toLocaleTimeString(); }, 1000);
}
init();
