const DATA = JSON.parse(document.getElementById("report-data").textContent);
const { skillName, timestamp, summary, runs, testList, runOrder, meta } = DATA;

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function fmtTok(n) {
  if (!n) return "N/A";
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function tokenMeta(run) {
  const parts = [];
  if (run.totalTokens) parts.push(`total ${fmtTok(run.totalTokens)}`);
  if (run.cacheReadTokens) parts.push(`cache read ${fmtTok(run.cacheReadTokens)}`);
  return `${fmtTok(run.tokens)} active tokens${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function scoreColor(passed, total) {
  if (!total) return "#94a3b8";
  const pct = Math.round((passed / total) * 100);
  return pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
}

function testForRun(run, testId) {
  return (run.tests || []).find(test => test.id === testId);
}

function testLabel(test) {
  const id = Number(test.id);
  return Number.isFinite(id) ? `${id}. ${test.name}` : test.name;
}

function isSkipped(test) {
  return test?.result === null || test?.status === "skipped";
}

function passCount(run) {
  return testList.reduce((sum, test) => sum + (testForRun(run, test.id)?.result === true ? 1 : 0), 0);
}

function skippedCount(run) {
  return testList.reduce((sum, test) => sum + (isSkipped(testForRun(run, test.id)) ? 1 : 0), 0);
}

function scoredTotal(run) {
  // Pass rate is measured against the full expected suite — skipped (and
  // not-yet-run) tests count toward the denominator rather than being excluded.
  return testList.length;
}

function scoreText(run) {
  return `${passCount(run)}/${scoredTotal(run)}`;
}

function testResultCell(test, includeLabel = false) {
  if (isSkipped(test)) {
    return { className: "skip", html: includeLabel ? "0 Skipped" : "0", title: "Skipped" };
  }
  if (test?.result === true) {
    return { className: "pass", html: includeLabel ? "&#10003; Pass" : "&#10003;", title: "Passed" };
  }
  return { className: "fail", html: includeLabel ? "&#10007; Fail" : "&#10007;", title: "Failed" };
}

const models = [...new Set(runOrder.map(id => meta[id].model))];

// ============================================================
// Nav
// ============================================================
document.getElementById("nav-title").textContent = `Skill Test Report: ${skillName}`;
document.title = `Skill Test Report — ${skillName}`;

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => navigate(btn.dataset.page));
});

function navigate(page, runId) {
  document.querySelectorAll(".page").forEach(p => p.style.display = "none");
  document.getElementById(page).style.display = "block";
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  if (page === "instance" && runId) selectInstance(runId);
  window.scrollTo(0, 0);
}

// ============================================================
// Home
// ============================================================
document.getElementById("timestamp").textContent = `Generated ${timestamp}`;

function md(text) {
  const lines = text.split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    const bullet = line.match(/^(\s*)[-*]\s+(.*)/);
    if (heading) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = heading[1].length;
      html += `<h${level + 1}>${inline(heading[2])}</h${level + 1}>`;
    } else if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(bullet[2])}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() === "") { html += "<br>"; }
      else { html += `<p>${inline(line)}</p>`; }
    }
  }
  if (inList) html += "</ul>";
  return html;
}
function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

const analysisEl = document.getElementById("analysis");
if (summary) {
  analysisEl.innerHTML = md(summary);
} else {
  document.getElementById("summary-section").style.display = "none";
}

function buildCards(container, onclick) {
  for (const id of runOrder) {
    const r = runs[id], m = meta[id], p = passCount(r), total = scoredTotal(r), skipped = skippedCount(r);
    const card = document.createElement("div");
    card.className = "card";
    card.onclick = () => onclick(id);
    card.innerHTML = `
      <div class="card-label">${esc(m.label)}</div>
      <div class="card-score" style="color:${scoreColor(p, total)}">${p}/${total}</div>
      <div class="card-meta">${r.steps} tool calls &middot; ${tokenMeta(r)}${skipped ? ` &middot; ${skipped} skipped` : ""}</div>`;
    container.appendChild(card);
  }
}

function buildChart(title, getValue, fmt) {
  fmt = fmt || fmtTok;
  const maxVal = Math.max(1, ...runOrder.map(id => getValue(runs[id])));
  let html = `<div class="chart-box"><div class="chart-title">${esc(title)}</div>
    <div class="chart-legend">
      <span class="legend-dot legend-skill"></span> Skill
      <span class="legend-spacer"></span>
      <span class="legend-dot legend-control"></span> Control
    </div>`;
  for (const model of models) {
    const mLabel = model.charAt(0).toUpperCase() + model.slice(1);
    const skillId = runOrder.find(r => meta[r].model === model && meta[r].condition === "skill");
    const ctrlId = runOrder.find(r => meta[r].model === model && meta[r].condition === "control");
    const sv = skillId ? getValue(runs[skillId]) : 0;
    const cv = ctrlId ? getValue(runs[ctrlId]) : 0;
    html += `<div class="bar-group"><div class="bar-model-label">${mLabel}</div>
      <div class="bar-row"><div class="bar-track"><div class="bar bar-skill" style="width:${Math.max(1, sv / maxVal * 100).toFixed(1)}%"></div></div><span class="bar-val">${fmt(sv, skillId)}</span></div>
      <div class="bar-row"><div class="bar-track"><div class="bar bar-control" style="width:${Math.max(1, cv / maxVal * 100).toFixed(1)}%"></div></div><span class="bar-val">${fmt(cv, ctrlId)}</span></div>
    </div>`;
  }
  html += "</div>";
  return html;
}

const fmtPass = (n, id) => id ? `${n}/${scoredTotal(runs[id])}` : String(n);
document.getElementById("charts").innerHTML =
  buildChart("Tests Passed", r => passCount(r), fmtPass) +
  buildChart("Active Tokens", r => r.tokens) +
  buildChart("Tool Calls", r => r.steps);

// ============================================================
// Comparison
// ============================================================
buildCards(document.getElementById("comparison-cards"), id => { navigate("instance", id); });

const thead = document.getElementById("comparison-head");
let r1 = `<tr><th rowspan="2" class="test-name" style="text-align:left">Test</th>`;
let r2 = "<tr>";
for (const model of models) {
  r1 += `<th colspan="2" class="group">${model.charAt(0).toUpperCase() + model.slice(1)}</th>`;
  r2 += `<th>Skill</th><th>Control</th>`;
}
thead.innerHTML = r1 + "</tr>" + r2 + "</tr>";

const tbody = document.getElementById("comparison-body");
for (const test of testList) {
  let row = `<td class="test-name" title="${esc(testLabel(test))}">${esc(testLabel(test))}</td>`;
  for (const id of runOrder) {
    const result = testResultCell(testForRun(runs[id], test.id));
    row += `<td class="${result.className}" title="${esc(result.title)}">${result.html}</td>`;
  }
  tbody.innerHTML += `<tr>${row}</tr>`;
}

let footer = `<tr class="totals"><td class="test-name"><strong>Total Passed</strong></td>`;
for (const id of runOrder) footer += `<td><strong>${scoreText(runs[id])}</strong></td>`;
if (runOrder.some(id => skippedCount(runs[id]) > 0)) {
  footer += `</tr><tr class="meta-row"><td class="test-name">Skipped</td>`;
  for (const id of runOrder) footer += `<td class="skip">${skippedCount(runs[id])}</td>`;
}
footer += `</tr><tr class="meta-row"><td class="test-name">Tool Calls</td>`;
for (const id of runOrder) footer += `<td>${runs[id].steps}</td>`;
footer += `</tr><tr class="meta-row"><td class="test-name">Active Tokens</td>`;
for (const id of runOrder) footer += `<td>${fmtTok(runs[id].tokens)}</td>`;
footer += `</tr><tr class="meta-row"><td class="test-name">Cache Read Tokens</td>`;
for (const id of runOrder) footer += `<td>${fmtTok(runs[id].cacheReadTokens)}</td>`;
footer += "</tr>";
tbody.innerHTML += footer;

// ============================================================
// Instance
// ============================================================
const selectorEl = document.getElementById("instance-selector");
const contentEl = document.getElementById("instance-content");

for (const id of runOrder) {
  const btn = document.createElement("button");
  btn.className = "instance-btn";
  btn.dataset.run = id;
  btn.textContent = meta[id].label;
  btn.onclick = () => selectInstance(id);
  selectorEl.appendChild(btn);
}

function selectInstance(id) {
  document.querySelectorAll(".instance-btn").forEach(b => b.classList.toggle("active", b.dataset.run === id));

  const r = runs[id], m = meta[id], p = passCount(r), total = scoredTotal(r), skipped = skippedCount(r);
  const pct = total ? Math.round((p / total) * 100) : 0;
  const skippedStat = skipped ? `<div class="stat"><div class="stat-label">Skipped</div><div class="stat-value skip">${skipped}</div></div>` : "";

  let rows = "";
  for (const test of testList) {
    const result = testResultCell(testForRun(r, test.id), true);
    rows += `<tr><td style="text-align:left;color:#cbd5e1;padding-left:0">${esc(testLabel(test))}</td>
      <td class="${result.className}" title="${esc(result.title)}">${result.html}</td></tr>`;
  }

  contentEl.innerHTML = `
    <h2>${esc(m.label)}</h2>
    <div class="detail-stats">
      <div class="stat"><div class="stat-label">Pass Rate</div><div class="stat-value" style="color:${scoreColor(p, total)}">${p}/${total} <span class="stat-pct">(${pct}%)</span></div></div>
      ${skippedStat}
      <div class="stat"><div class="stat-label">Tool Calls</div><div class="stat-value">${r.steps}</div></div>
      <div class="stat"><div class="stat-label">Active Tokens</div><div class="stat-value">${fmtTok(r.tokens)}</div></div>
      <div class="stat"><div class="stat-label">Cache Read</div><div class="stat-value">${fmtTok(r.cacheReadTokens)}</div></div>
    </div>
    <table class="detail-table">
      <thead><tr><th style="text-align:left">Test</th><th style="width:120px">Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
`;
}

selectInstance(runOrder[0]);

// ============================================================
// Errors
// ============================================================
const hasAnyLog = runOrder.some(id => runs[id].log);
document.getElementById("nav-errors").style.display = hasAnyLog ? "" : "none";

if (hasAnyLog) {
  const errSelectorEl = document.getElementById("errors-selector");
  const errContentEl = document.getElementById("errors-content");
  const runsWithLogs = runOrder.filter(id => runs[id].log);

  for (const id of runsWithLogs) {
    const btn = document.createElement("button");
    btn.className = "instance-btn";
    btn.dataset.run = id;
    btn.textContent = meta[id].label;
    btn.onclick = () => selectError(id);
    errSelectorEl.appendChild(btn);
  }

  function selectError(id) {
    errSelectorEl.querySelectorAll(".instance-btn").forEach(b => b.classList.toggle("active", b.dataset.run === id));
    errContentEl.innerHTML = `
      <h2>${esc(meta[id].label)}</h2>
      <pre class="log-block">${esc(runs[id].log)}</pre>`;
  }

  selectError(runsWithLogs[0]);
}
