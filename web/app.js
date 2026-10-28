import { buildPlan, DEFAULTS, ACTIONS, compareActions, settings } from "./policy.js";
import { sensitivityChart, decisionChart } from "./charts.js";
import { icon, badgeIcon } from "./icons.js";

const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
// Deck-style rupiah: Rp450K, Rp2.52M. Negative values keep a true minus sign.
const short = (n, digits = 1) => {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}Rp${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${sign}Rp${Math.round(a / 1e3)}K`;
  return `${sign}Rp${Math.round(a)}`;
};
const pct = (n, digits = 1) => `${(n * 100).toFixed(digits)}%`;

const MAIN = ["background", "analysis", "solution", "implementation"];
const LABEL = { background: "Background", analysis: "Analysis", solution: "Solution", implementation: "Implementation", appendix: "Appendix" };
const FIRST = { background: "s2", analysis: "s4", solution: "s6", implementation: "s9", appendix: "a1" };
const LEGACY = { overview: "s1", customers: "s11", agent: "s10", evidence: "s5" };

let data,
  config = { ...DEFAULTS },
  probe = 0.15,
  activePlan = null,
  agentResult = null,
  page = 0,
  search = "",
  filter = "all",
  busy = false;
let prompt =
  "Susun rencana retention sesuai budget dan kapasitas di plan builder. Prioritaskan pemeriksaan masalah teknis sebelum menawarkan insentif.";

async function api(path, body) {
  const res = await fetch(
    `/api/${path}`,
    body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3500);
}

/* ---------- Slide chrome and shared pieces ---------- */

function slide({ id, section, page, title, body, source = "", tall = false }) {
  const tracker = MAIN.includes(section)
    ? `<div class="tracker">${MAIN.map(
        (s) => `<button class="tab ${s === section ? "active" : ""}" data-goto="${FIRST[s]}">${LABEL[s]}</button>`,
      ).join("")}</div>`
    : "";
  return `<section class="slide ${tall ? "tall" : ""}" id="${id}" data-section="${section}" aria-labelledby="${id}-title">
    <div class="eyebrow">${LABEL[section].toUpperCase()}</div>
    <h2 class="slide-title" id="${id}-title">${title}</h2>
    <hr class="slide-rule">
    <div class="slide-body">${body}</div>
    ${source ? `<p class="source">${source}</p>` : ""}
    <div class="slide-foot">${tracker}<span class="page-box">${page}</span></div>
  </section>`;
}
const colHead = (title, aside = "") =>
  `<div class="col-head"><span>${title}</span>${aside ? `<span class="col-aside">${aside}</span>` : ""}</div>`;
const stat = (value, label, id = "") =>
  `<div class="stat"${id ? ` id="${id}"` : ""}><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
const iconRow = (name, text, tone = "") => `<div class="icon-row">${badgeIcon(name, tone)}<p>${text}</p></div>`;
function kpis(items) {
  return `<div class="kpis">${items
    .map(
      ([value, label, note]) =>
        `<div class="kpi"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div>${note ? `<div class="kpi-note">${note}</div>` : ""}</div>`,
    )
    .join("")}</div>`;
}
const status = (s) => `<span class="status ${esc(s)}">${esc(s.replaceAll("_", " "))}</span>`;
const band = (c) => `<span class="band ${c.risk_band.toLowerCase()}">${c.risk_band}</span>`;
const idLink = (id) => `<button class="id-link" data-customer="${esc(id)}">${esc(id)}</button>`;
const meter = (c) =>
  `<span class="meter"><span class="meter-track"><i style="width:${Math.round(c.risk_score * 100)}%"></i></span>${pct(c.risk_score)}</span>`;

/* ---------- Cover and closing ---------- */

function cover() {
  const r = data.report;
  return `<section class="slide cover" id="s1" data-section="cover" aria-labelledby="s1-title">
    <div class="cover-grid">
      <div class="cover-text">
        <h1 id="s1-title">Customer Retention</h1>
        <p class="cover-sub">From churn prediction to <strong>the right action, at the right cost.</strong></p>
        <div class="cover-cta"><button class="btn light" data-goto="s2">Start the deck ${icon("arrow_forward")}</button><button class="btn outline-light" data-goto="s9">Open the plan builder</button></div>
      </div>
      <div class="cover-stats">
        ${stat(r.cohort.n, "customers active on 1 Nov 2025")}
        ${stat(r.cohort.churn, "of them left in November")}
        ${stat(short(r.cohort.churn * DEFAULTS.retainedValue, 0), "of retained value at stake, at Rp6M each")}
      </div>
    </div>
    <div class="cover-foot"><span>Data Scientist<br>Take-Home Assignment</span><span class="cover-hint">Use ← → to move between slides</span><span class="cover-name">Taufiq R Ahmad</span></div>
  </section>`;
}
function closing() {
  return `<section class="slide cover closing" id="s14" data-section="cover" aria-labelledby="s14-title">
    <div class="cover-grid">
      <div class="cover-text">
        <h2 class="cover-title" id="s14-title">Thank you</h2>
        <p class="cover-sub">Happy to walk through <strong>any part of this analysis, from data to decision.</strong></p>
        <div class="cover-cta"><button class="btn light" data-goto="s1">Back to the start</button><button class="btn outline-light" data-goto="a1">Appendix</button></div>
      </div>
    </div>
    <div class="cover-foot"><span>Data Scientist<br>Take-Home Assignment</span><span></span><span class="cover-name">Taufiq R Ahmad</span></div>
  </section>`;
}

/* ---------- Background ---------- */

function s2() {
  const r = data.report;
  const V = DEFAULTS.retainedValue;
  const costs = [
    [short(V, 0), "value of one retained customer"],
    [short(ACTIONS.basic_offer.cost), `basic offer, ${pct(DEFAULTS.basicSuccess, 0)} success`],
    [short(ACTIONS.premium_offer.cost), `premium offer, ${pct(DEFAULTS.premiumSuccess, 0)} success`],
  ];
  return slide({
    id: "s2",
    section: "background",
    page: 1,
    title: "A churn score does not say who to call, what to offer or when to wait",
    body: `<div class="cols-3">
      <div>${colHead("Four decisions to make")}<ol class="numbered big">${[
        "Who is likely to leave?",
        "What action fits each customer?",
        "When is doing nothing better?",
        "What can run without a person?",
      ]
        .map((q) => `<li>${q}</li>`)
        .join("")}</ol></div>
      <div>${colHead("What an offer costs")}<div class="cost-cards">${costs
        .map(([v, l]) => `<div class="cost-card"><strong>${v}</strong><span>${l}</span></div>`)
        .join("")}</div></div>
      <div>${colHead("What is at stake")}${stat(pct(r.cohort.prevalence), `of active customers churned in November 2025 (${r.cohort.churn} of ${r.cohort.n})`)}<hr class="thin">${stat(
        short(r.cohort.churn * V, 0),
        `of retained value in those ${r.cohort.churn} customers, at ${short(V, 0)} each`,
      )}</div>
    </div>`,
    source: `Source: supplied datasets (${r.cohort.n} customers active on 1 Nov 2025); Rp6M and offer rates from the brief.`,
  });
}
function s3() {
  const r = data.report,
    a = r.audit,
    t = a.support_topics;
  const file = (ic, name, text) =>
    `<div class="file-card">${badgeIcon(ic)}<div><strong>${name}</strong><span>${text}</span></div></div>`;
  const issues = [
    ["Two date formats", "Both formats parsed"],
    ["Region typos: jkt, sby, bdg", "Mapped to city names"],
    [`${a.blank_total_charges} blank totalCharges`, "Left missing; not a model input"],
    [`${a.support_after_churn} contacts after churn`, "Ignored as invalid"],
    ["Resolution status has no date", "Excluded to avoid future information"],
  ];
  return slide({
    id: "s3",
    section: "background",
    page: 2,
    title: `${a.customers} customers in the files; ${r.cohort.n} form a clean 1 November snapshot`,
    body: `<div class="cols-2">
      <div>${colHead("What the files hold")}
        ${file("people", "customer_base", `${a.customers} customers, ${a.churn_records} with a churn date`)}
        ${file("data_usage", "service_usage", `${a.usage_rows} monthly rows; ${a.one_usage_row} customers have only one month`)}
        ${file("headset_mic", "support_interactions", `${a.support_rows} contacts: ${t.technical_issue} technical, ${t.billing_inquiry} billing, ${t.contract_question} contract`)}
        <div class="funnel"><div><strong>${a.customers}</strong><span>customers</span></div>${icon("arrow_forward", "funnel-arrow")}<div><strong>${r.cohort.n}</strong><span>active 1 Nov</span></div>${icon("arrow_forward", "funnel-arrow")}<div class="dark"><strong>${r.cohort.churn}</strong><span>left in Nov</span></div></div>
      </div>
      <div>${colHead("Data issues and fixes")}<table class="data pairs"><tbody>${issues
        .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
        .join("")}</tbody></table></div>
    </div>`,
    source: "Snapshot 1 Nov 2025; churn = churn date in 1 to 30 Nov 2025. Source: supplied datasets.",
  });
}

/* ---------- Analysis ---------- */

function s4() {
  const r = data.report,
    seg = r.segments,
    o = seg.overlap;
  const max = Math.max(...seg.rows.flatMap((s) => [s.rate_in, s.rate_out]));
  const support = seg.rows.find((s) => s.segment === "Support contact");
  const bar = (v, cls) =>
    `<div class="seg-bar ${cls}"><i style="width:${(v / max) * 82}%"></i><b>${pct(v, 0)}</b></div>`;
  return slide({
    id: "s4",
    section: "analysis",
    page: 3,
    title: `All ${o.all_churned} churners were month-to-month and in their first six months`,
    body: `<div class="cols-split">
      <div>${colHead("Churn rate by segment, November 2025")}
        <div class="seg-chart"><div class="seg-row seg-head"><span></span><span class="in">In segment</span><span class="out">Everyone else</span></div>${seg.rows
          .map(
            (s) =>
              `<div class="seg-row"><div class="seg-label"><strong>${s.segment}</strong><span>n = ${s.n_in} vs ${s.n_out}</span></div>${bar(s.rate_in, "in")}${bar(s.rate_out, "out")}</div>`,
          )
          .join("")}</div>
      </div>
      <div class="callouts">
        ${stat(pct(o.churned / o.n, 0), `churn in one segment: month-to-month, new, fiber and e-check (${o.churned} of ${o.n})`)}
        ${stat(`${pct(support.rate_in, 0)} vs ${pct(support.rate_out, 0)}`, "churn with vs without a support contact: contact is not a warning sign")}
        ${stat(r.cohort.n, "customers from one cohort; confirm the pattern on a later month")}
      </div>
    </div>`,
    source: `Support contact = any contact in the 30 days before 1 Nov. Source: supplied datasets, ${r.cohort.n} customers.`,
  });
}
function s5() {
  const r = data.report,
    e = r.evaluation,
    m = e.logistic_regression;
  const rows = [
    ["Logistic regression", m.pr_auc, true],
    ["Shallow decision tree", e.shallow_tree.pr_auc],
    ["Business rule", e.business_rule.pr_auc],
    ["Random guess", e.constant_prevalence.pr_auc],
  ];
  const [lo, hi] = m.pr_auc_bootstrap_95pct;
  return slide({
    id: "s5",
    section: "analysis",
    page: 4,
    title: "A simple model ranks churners well, but the evidence base is small",
    body: `<div class="cols-split">
      <div>${colHead(`PR-AUC on a ${m.n}-customer holdout`)}
        <div class="model-bars">${rows
          .map(
            ([l, v, lead]) =>
              `<div class="model-bar ${lead ? "lead" : ""}"><span>${l}</span><div><i style="width:${v * 90}%"></i><b>${v.toFixed(2)}</b></div></div>`,
          )
          .join("")}</div>
        <div class="hero-stat"><span class="hero-value">${pct(r.oof.recall_at_20pct, 0)}</span><span>of churners sit in the top 20% of risk scores (out-of-fold, ${r.oof.n} customers)</span></div>
      </div>
      <div>${colHead("How it works")}
        ${iconRow("done", "Logistic regression on 9 inputs known before 1 Nov")}
        ${iconRow("done", "Out-of-fold scores, so no customer is scored by a model that saw them")}
        ${iconRow("done", "Age and gender are left out")}
        ${colHead("What limits it")}
        ${iconRow("priority_high", `Holdout has ${m.positives} churners (PR-AUC interval ${lo.toFixed(2)} to ${hi.toFixed(2)})`, "grey")}
        ${iconRow("priority_high", "No later labelled month, so no out-of-time test", "grey")}
      </div>
    </div>`,
    source: `PR-AUC = average precision; random guess = ${pct(r.cohort.prevalence)} churn rate. Rule: month-to-month, tenure &lt; 6 months, technical contact.`,
  });
}

/* ---------- Solution ---------- */

function s6() {
  const steps = [
    ["1. Score risk", "Model", "Customer, usage and support history", "Risk %, main drivers, data flags"],
    ["2. Choose action", "Rules", "Risk, offer costs and success rates, budget", "Best action with cost and net benefit, or no action"],
    ["3. Draft the plan", "LLM agent", "Ranked list and the policy tools", "Plan within budget, with a rationale"],
    ["4. Approve", "Human", "Proposed plan and checklist", "Approved actions and recorded outcomes"],
  ];
  return slide({
    id: "s6",
    section: "solution",
    page: 5,
    title: "Four steps turn a risk score into a decision a person can approve",
    body: `<div class="flow">${steps
      .map(
        ([h, chip, i, o], k) =>
          `${k ? icon("arrow_forward", "flow-arrow") : ""}<div class="flow-card"><div class="flow-head">${h}</div><div class="flow-chip">${chip}</div><dl><dt>Input</dt><dd>${i}</dd><dt>Output</dt><dd>${o}</dd></dl></div>`,
      )
      .join("")}</div>
      <div class="statement">Risk says who may leave. Economics says whether spending on them is worth it.</div>`,
  });
}
function thresholds() {
  const V = config.retainedValue,
    sb = config.basicSuccess,
    sp = config.premiumSuccess,
    cb = ACTIONS.basic_offer.cost,
    cp = ACTIONS.premium_offer.cost;
  const basicFrom = sb * V > 0 ? cb / (sb * V) : Infinity;
  const premiumFrom = sp > sb && V > 0 ? Math.max(basicFrom, (cp - cb) / ((sp - sb) * V)) : Infinity;
  const best = (r) => {
    const options = [
      ["No action", 0],
      ["Basic offer", r * sb * V - cb],
      ["Premium offer", r * sp * V - cp],
    ];
    return options.reduce((a, b) => (b[1] > a[1] ? b : a));
  };
  return { V, sb, sp, cb, cp, basicFrom, premiumFrom, best };
}
function s7() {
  return slide({
    id: "s7",
    section: "solution",
    page: 6,
    title: `<span id="s7-dynamic"></span>`,
    body: `<div class="cols-split">
      <div>${colHead("Best action by churn risk", "drag to try a customer")}
        <div class="bands"><div class="band-block none">No action</div><div class="band-block basic">Basic offer</div><div class="band-block premium">Premium offer</div><span class="probe-mark" id="probe-mark"></span></div>
        <div class="band-axis"><span>0%</span><span id="th-basic"></span><span id="th-premium"></span><span>100%</span></div>
        <div class="probe"><label for="probe">Churn risk</label><input type="range" id="probe" min="0" max="100" step="0.5" value="${probe * 100}"><output id="probe-value"></output></div>
        <p class="formula" id="formula"></p>
        <div id="threshold-table"></div>
      </div>
      <div>${colHead("Checks before any offer")}<ol class="numbered">
        <li>Open service or billing issue? Review it first, no offer yet.</li>
        <li>Consent denied or customer ineligible? No outreach.</li>
        <li>Offers fill the budget and customer cap by net benefit per rupiah.</li>
      </ol></div>
    </div>`,
    source: "Blocks not to scale. Success rates and the Rp6M value come from the brief; change them in the plan builder and this slide follows.",
  });
}
function updateThreshold() {
  const t = thresholds();
  const fin = (x) => Number.isFinite(x) && x <= 1;
  $("#s7-dynamic").textContent = fin(t.basicFrom)
    ? `Offer only above ${pct(t.basicFrom)} risk; below that, doing nothing is better`
    : "With these assumptions no offer pays for itself, so doing nothing is better";
  $("#th-basic").textContent = fin(t.basicFrom) ? pct(t.basicFrom) : "—";
  $("#th-premium").textContent = fin(t.premiumFrom) ? pct(t.premiumFrom) : "—";
  // Position the probe on the not-to-scale bands: each band keeps its own scale.
  const b = fin(t.basicFrom) ? t.basicFrom : 1,
    p = fin(t.premiumFrom) ? t.premiumFrom : 1;
  const seg = (x, lo, hi, a, w) => a + (hi > lo ? ((Math.min(Math.max(x, lo), hi) - lo) / (hi - lo)) * w : 0);
  const pos = probe < b ? seg(probe, 0, b, 0, 32) : probe < p ? seg(probe, b, p, 32, 30) : seg(probe, p, 1, 62, 38);
  $("#probe-mark").style.left = `${pos}%`;
  $("#probe-value").textContent = pct(probe);
  $("#formula").textContent = `Net benefit = risk × success rate × ${short(t.V, 0)} − cost`;
  const rows = [0.1, 0.15, 0.5].filter((r) => Math.abs(r - probe) > 0.0005).map((r) => [r, false]);
  rows.push([probe, true]);
  rows.sort((x, y) => x[0] - y[0]);
  $("#threshold-table").innerHTML = `<table class="data"><thead><tr><th>Churn risk</th><th class="num">Basic</th><th class="num">Premium</th><th>Best action</th></tr></thead><tbody>${rows
    .map(([r, mine]) => {
      const nb = r * t.sb * t.V - t.cb,
        np = r * t.sp * t.V - t.cp;
      const sign = (v) => (v > 0 ? "+" : "") + short(v, 2);
      return `<tr class="${mine ? "hl" : ""}"><td>${pct(r)}${mine ? " <span class='you'>your value</span>" : ""}</td><td class="num">${sign(nb)}</td><td class="num">${sign(np)}</td><td>${t.best(r)[0]}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}
function s8() {
  const r = data.report,
    st = r.strategies;
  const [, pa, tr] = st.rows;
  const cell = (k, f) => st.rows.map((row, i) => `<td class="num ${i === 2 ? "hl-col" : ""}">${f(row[k])}</td>`).join("");
  return slide({
    id: "s8",
    section: "solution",
    page: 7,
    title: `Targeting ${tr.contacted} customers saves as many as all ${r.cohort.n}, at ${pct(tr.cost / pa.cost, 0)} of the cost`,
    body: `<div class="cols-split">
      <div>${colHead("Outcome by strategy, November 2025")}<table class="data strategy"><thead><tr><th></th>${st.rows
        .map((row, i) => `<th class="num ${i === 2 ? "hl-col" : ""}">${row.strategy}</th>`)
        .join("")}</tr></thead><tbody>
        <tr><td>Customers contacted</td>${cell("contacted", (v) => v)}</tr>
        <tr><td>Cost</td>${cell("cost", (v) => short(v))}</tr>
        <tr><td>Expected saved</td>${cell("expected_saved", (v) => v.toFixed(1))}</tr>
        <tr><td>Net benefit</td>${cell("net_benefit", (v) => short(v))}</tr>
      </tbody></table></div>
      <div class="callouts">
        ${stat(`${(tr.net_benefit / pa.net_benefit).toFixed(1)}×`, "net benefit of the targeted rule vs premium to all")}
        ${stat(`${st.unflagged.churned} of ${st.unflagged.n}`, `unflagged customers churned in November; ${pct(st.unflagged.n / r.cohort.n, 0)} of the cohort gets no contact`)}
      </div>
    </div>`,
    source: `Targeted rule on out-of-fold scores: no action below ${pct(st.basic_from)}, basic offer to ${pct(st.premium_from)}, premium above. Expected saved = success rate × customers who actually churned among those contacted; rates are from the brief, not measured.`,
  });
}

/* ---------- Implementation: plan builder ---------- */

function controls() {
  return `<div class="card controls"><div class="card-head">Campaign settings</div>
    <div class="field"><label for="budget">Campaign budget</label><output class="field-value" id="budget-label">${short(config.budget, 2)}</output><input id="budget" type="range" min="0" max="10000000" step="50000" value="${config.budget}"><div class="range-ends"><span>Rp0</span><span>Rp10M</span></div></div>
    <div class="field"><label for="capacity">Maximum customers</label><output class="field-value" id="capacity-label">${config.maxCustomers} customers</output><input id="capacity" type="range" min="1" max="20" value="${config.maxCustomers}"><div class="range-ends"><span>1</span><span>20</span></div></div>
    <label class="check"><input type="checkbox" id="technical" ${config.prioritizeTechnical ? "checked" : ""}>Technical reviews before billing reviews</label>
    <details class="assumptions"><summary>Economic assumptions</summary>
      <div class="field"><label for="value">Retained customer value (Rp)</label><input class="input" id="value" type="number" min="0" max="12000000" step="100000" value="${config.retainedValue}"></div>
      <div class="field"><label for="basic-success">Basic offer success (%)</label><input class="input" id="basic-success" type="number" min="0" max="100" value="${config.basicSuccess * 100}"></div>
      <div class="field"><label for="premium-success">Premium offer success (%)</label><input class="input" id="premium-success" type="number" min="0" max="100" value="${config.premiumSuccess * 100}"></div>
      <p class="note">Share of would-be churners an offer keeps: an assumption from the brief, not observed uplift. Review costs are illustrative: technical Rp50K, billing Rp25K.</p>
    </details>
  </div>`;
}
function s9() {
  return slide({
    id: "s9",
    section: "implementation",
    page: 8,
    tall: true,
    title: `<span id="s9-dynamic"></span>`,
    body: `<div class="planner">${controls()}<div class="planner-main">
      <div id="planner-kpis"></div>
      <div id="planner-table"></div>
      <div class="planner-actions"><p class="note" id="planner-note"></p><button class="btn primary" id="save-plan">Save plan for review ${icon("arrow_forward")}</button></div>
    </div></div>`,
    source: "Policy retention-v1: service reviews take up to 30% of capacity first, then offers by assumed net benefit per rupiah. The server recomputes every plan before saving it.",
  });
}
function readControls() {
  const next = {
    budget: Number($("#budget").value),
    maxCustomers: Number($("#capacity").value),
    retainedValue: Number($("#value").value),
    basicSuccess: Number($("#basic-success").value) / 100,
    premiumSuccess: Number($("#premium-success").value) / 100,
    prioritizeTechnical: $("#technical").checked,
  };
  config = settings(next);
}
function updatePlanner() {
  const customers = data.intelligence.customers;
  try {
    readControls();
  } catch (e) {
    $("#planner-note").innerHTML = `<span class="error-text">${esc(e.message)}. Check the assumptions.</span>`;
    return;
  }
  const plan = buildPlan(customers, config);
  const count = (k) => plan.items.filter((i) => i.action === k).length;
  const reviews = count("technical_review") + count("billing_review");
  $("#s9-dynamic").textContent = `${short(plan.total_cost)} reaches ${plan.items.length} customers: ${count("premium_offer")} premium, ${count("basic_offer")} basic and ${reviews} service ${reviews === 1 ? "review" : "reviews"}`;
  $("#budget-label").textContent = short(config.budget, 2);
  $("#capacity-label").textContent = `${config.maxCustomers} customers`;
  $("#planner-kpis").innerHTML = kpis([
    [short(plan.total_cost, 2), "proposed spend", `${short(plan.remaining_budget, 2)} left unallocated`],
    [short(plan.scenario_net_benefit, 2), "scenario net benefit", "Assumed success rates"],
    [`${plan.items.length}/${config.maxCustomers}`, "customers in the plan", `${plan.skipped.length} not selected`],
  ]);
  $("#planner-table").innerHTML = plan.items.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th>Action</th><th class="num">Risk</th><th class="num">Cost</th><th class="num">Assumed net benefit</th></tr></thead><tbody>${plan.items
        .map(
          (i) =>
            `<tr><td>${idLink(i.customer_id)}</td><td>${esc(i.label)}</td><td class="num">${pct(i.risk_score)}</td><td class="num">${short(i.cost)}</td><td class="num">${i.scenario_net_benefit === null ? "Unmeasured" : short(i.scenario_net_benefit, 2)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<div class="empty">No affordable service review or offer with a positive assumed benefit under these settings.</div>`;
  $("#planner-note").textContent =
    "Live preview, computed in your browser. Saving sends the settings to the server, which rebuilds and validates the plan before it enters review.";
  updateThreshold();
}

/* ---------- Implementation: agent and review ---------- */

function s10() {
  const roles = [
    ["description", "LLM agent drafts", ["Reads the ranked list and one customer's context", "Compares actions and simulates a plan", "Uses 5 tools, at most 14 calls"]],
    ["verified_user", "Code verifies", ["Recomputes every cost and net benefit", "Rejects unknown customers and over-budget plans", "Offers no tool that contacts a customer"]],
    ["assignment_turned_in", "People approve", ["Approve or reject each plan", "Check consent, contact limits and eligibility", "Execution stays outside this prototype"]],
  ];
  return slide({
    id: "s10",
    section: "implementation",
    page: 9,
    tall: true,
    title: "The agent drafts, the code verifies, and a person approves",
    body: `<div class="roles">${roles
      .map(
        ([ic, h, items], k) =>
          `${k ? `<span class="role-arrow">${icon("arrow_forward")}</span>` : ""}<div class="role"><div class="role-head">${icon(ic)}${h}</div><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></div>`,
      )
      .join("")}</div>
      <div class="ask">
        ${colHead("Ask the agent", data.agent_available ? "DeepSeek connected" : "Live agent not configured here; the policy planner works")}
        <textarea class="prompt" id="agent-prompt" maxlength="1500" aria-label="Retention objective">${esc(prompt)}</textarea>
        <div class="ask-foot"><div class="suggestions"><button class="btn secondary small suggestion" data-prompt="Build a retention plan within the configured budget. Investigate technical contacts first, and explain who should not receive an incentive.">Prioritise service reviews</button><button class="btn secondary small suggestion" data-prompt="Investigate high-risk customers with billing contacts. Compare allowed actions and submit a plan within the configured budget.">Review billing contacts</button></div><button class="btn primary" id="run-agent" ${!data.agent_available ? "disabled" : ""}>Run agent ${icon("play_arrow")}</button></div>
        <div id="agent-progress"></div><div id="agent-error"></div>
      </div>
      <div id="plan-result"></div>
      <div class="history-block">${colHead("Session history", `<button class="link" id="refresh-history">Refresh</button>`)}<div id="history"><div class="empty">Loading history…</div></div></div>`,
    source: "Rules decide costs, eligibility and budget so they stay exact and auditable; the LLM drafts and explains. Budget and capacity come from the plan builder.",
  });
}
function planHTML(plan, trace = []) {
  if (!plan)
    return `<div class="review-block">${colHead("Proposal under review")}<div class="empty">Nothing to review yet. Save a plan in the plan builder or run the agent.</div></div>`;
  const pending = plan.status === "pending_review";
  return `<div class="review-block">${colHead(`${plan.agent_model ? "Agent proposal" : "Policy proposal"} under review`, status(plan.status))}
    <p class="meta">Plan ${esc(plan.id?.slice(0, 8) || "preview")} · ${esc(plan.policy_version)} · budget ${short(plan.settings.budget, 2)} · capacity ${plan.settings.maxCustomers}</p>
    ${plan.rationale ? `<blockquote class="rationale">${esc(plan.rationale)}</blockquote>` : ""}
    ${kpis([
      [short(plan.total_cost, 2), "proposed spend", `${short(plan.remaining_budget, 2)} left unallocated`],
      [short(plan.scenario_net_benefit, 2), "scenario net benefit", "Assumed success rates"],
      [`${plan.items.length}/${plan.settings.maxCustomers}`, "customers in the plan", `${plan.skipped.length} not selected`],
    ])}
    ${
      plan.items.length
        ? `<div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th>Action</th><th class="num">Risk</th><th class="num">Cost</th><th class="num">Assumed net benefit</th></tr></thead><tbody>${plan.items
            .map(
              (i) =>
                `<tr><td>${idLink(i.customer_id)}</td><td>${esc(i.label)}</td><td class="num">${pct(i.risk_score)}</td><td class="num">${short(i.cost)}</td><td class="num">${i.scenario_net_benefit === null ? "Unmeasured" : short(i.scenario_net_benefit, 2)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty">No affordable action with a positive assumed benefit under these settings.</div>`
    }
    <details class="disclosure"><summary>${plan.skipped.length} customers not selected</summary><div class="scroll">${plan.skipped
      .map((c) => `<div class="kv"><span>${esc(c.customer_id)}</span><span>${esc(c.reason)}</span></div>`)
      .join("")}</div></details>
    ${
      trace.length
        ? `<details class="disclosure" open><summary>Agent tool trace · ${trace.length} calls</summary>${trace
            .map(
              (t) =>
                `<div class="trace-step"><span class="trace-no">${String(t.step).padStart(2, "0")}</span><code>${esc(t.tool)}</code><span class="trace-status ${t.status === "rejected" ? "rejected" : ""}">${esc(t.status)}</span><details><summary>Inputs and result</summary><pre>${esc(JSON.stringify({ input: t.input, result: t.result }, null, 2))}</pre></details></div>`,
            )
            .join("")}</details>`
        : ""
    }
    ${
      pending
        ? `<div class="card review"><div class="card-head">Review before simulated execution</div><p>Check active status, consent, contact limits, issue resolution and offer eligibility. None of these are in the supplied data.</p><label class="check"><input type="checkbox" id="review-ack">I understand these checks remain unverified. Approval records a simulation only.</label><div class="button-row"><button class="btn primary" id="approve-plan">Approve simulation</button><button class="btn secondary" id="reject-plan">Reject proposal</button></div></div>`
        : `<div class="statement small">${
            plan.status === "simulated_approved"
              ? "Approved in the sandbox. No customer was contacted and no incentive was issued."
              : "Proposal rejected. No action was executed."
          }</div>`
    }
    ${
      plan.status === "simulated_approved" && plan.items.length
        ? `<div class="card review"><div class="card-head">Record a simulated outcome</div><p>Shows the feedback contract. Records are marked synthetic and never used for training.</p><div class="toolbar"><select id="outcome-customer" aria-label="Outcome customer">${plan.items
            .map((i) => `<option>${esc(i.customer_id)}</option>`)
            .join("")}</select><select id="outcome-value" aria-label="Simulated outcome"><option value="retained">Retained</option><option value="churned">Churned</option><option value="no_response">No response</option></select><button class="btn secondary" id="record-outcome">Record</button></div></div>`
        : ""
    }
    <button class="link" id="export-plan">${icon("file_download")} Download proposal JSON</button>
  </div>`;
}
function renderReview() {
  $("#plan-result").innerHTML = planHTML(activePlan, agentResult?.trace ?? activePlan?.agent_trace ?? []);
}
async function loadHistory() {
  try {
    const h = await api("history");
    $("#history").innerHTML = h.plans.length
      ? h.plans
          .slice(0, 8)
          .map(
            (p) =>
              `<div class="history-row"><div><button class="id-link" data-plan="${p.id}">${p.id.slice(0, 8)}</button><span class="meta">${new Date(p.created_at).toLocaleString()} · ${p.items.length} customers · ${short(p.total_cost, 2)}</span></div>${status(p.status)}</div>`,
          )
          .join("") +
        `<p class="note">${h.events.length} audit ${h.events.length === 1 ? "event" : "events"} recorded, ${((n) => `${n} simulated ${n === 1 ? "outcome" : "outcomes"}`)(h.events.filter((e) => e.kind === "simulated_outcome").length)}.</p>`
      : '<div class="empty">No saved plans in this browser session yet.</div>';
    window.savedPlans = h.plans;
  } catch (e) {
    $("#history").textContent = e.message;
  }
}
function setBusy(value) {
  busy = value;
  document
    .querySelectorAll("[data-plan],#approve-plan,#reject-plan,#record-outcome,.suggestion,#save-plan")
    .forEach((el) => (el.disabled = value));
  $("#run-agent").disabled = value || !data.agent_available;
  $("#agent-prompt").disabled = value;
  document.querySelectorAll(".controls input").forEach((el) => (el.disabled = value));
}
async function savePlan() {
  try {
    readControls();
  } catch (e) {
    toast(e.message);
    return;
  }
  setBusy(true);
  try {
    activePlan = await api("plan", { settings: config });
    agentResult = null;
    renderReview();
    await loadHistory();
    toast("Plan saved. Review it below the agent.");
    $("#plan-result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}
async function runAgent() {
  try {
    readControls();
  } catch (e) {
    toast(e.message);
    return;
  }
  prompt = $("#agent-prompt").value;
  setBusy(true);
  $("#agent-error").innerHTML = "";
  let seconds = 0;
  const progress = () =>
    ($("#agent-progress").innerHTML = `<div class="running"><span class="spinner"></span>Agent is gathering evidence and calling tools · ${seconds}s</div>`);
  progress();
  const timer = setInterval(() => {
    seconds++;
    progress();
  }, 1000);
  try {
    agentResult = await api("agent", { prompt, settings: config });
    activePlan = agentResult.plan;
    if (!activePlan) $("#agent-error").innerHTML = `<p class="note">${esc(agentResult.answer)}</p>`;
    renderReview();
    await loadHistory();
  } catch (e) {
    $("#agent-error").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    clearInterval(timer);
    $("#agent-progress").innerHTML = "";
    setBusy(false);
  }
}

/* ---------- Implementation: explorer, monitoring, limits ---------- */

function s11() {
  return slide({
    id: "s11",
    section: "implementation",
    page: 10,
    tall: true,
    title: "Every customer's score comes with its evidence and the actions it allows",
    body: `<div class="toolbar"><label class="search">${icon("search")}<input id="customer-search" type="search" placeholder="Search customer ID or region" aria-label="Search customers" value="${esc(search)}"></label><select id="risk-filter" aria-label="Filter risk band"><option value="all">All risk bands</option><option value="High">High risk</option><option value="Medium">Medium risk</option><option value="Low">Low risk</option></select></div><div id="customer-table"></div>`,
    source: "Scores are out-of-fold estimates for 1 Nov 2025. They rank customers; they do not prove why anyone leaves. Open a customer for model contributions and the action comparison.",
  });
}
function recommended(c) {
  if (c.features.technical_30d) return "Technical review";
  if (c.features.billing_30d) return "Billing review";
  const bestOffer = compareActions(c, config)
    .filter((a) => a.eligible_for_proposal && a.action.endsWith("_offer"))
    .sort((a, b) => b.scenario_net_benefit - a.scenario_net_benefit)[0];
  return bestOffer?.scenario_net_benefit > 0 ? bestOffer.label : "No action";
}
function updateCustomers() {
  const cs = data.intelligence.customers
    .filter(
      (c) =>
        (filter === "all" || c.risk_band === filter) &&
        `${c.customer_id} ${c.region}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.risk_score - a.risk_score);
  page = Math.min(page, Math.max(0, Math.ceil(cs.length / 10) - 1));
  $("#customer-table").innerHTML = cs.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th>Region</th><th>Risk estimate</th><th>Band</th><th>Contract</th><th>Best route now</th></tr></thead><tbody>${cs
        .slice(page * 10, page * 10 + 10)
        .map(
          (c) =>
            `<tr><td>${idLink(c.customer_id)}</td><td>${esc(c.region)}</td><td>${meter(c)}</td><td>${band(c)}</td><td>${esc(c.features.contractType)}</td><td>${recommended(c)}</td></tr>`,
        )
        .join("")}</tbody></table></div><div class="pagination"><span>${page * 10 + 1}–${Math.min(cs.length, page * 10 + 10)} of ${cs.length} customers</span><div><button class="btn secondary small" id="prev-page" aria-label="Previous page" ${page === 0 ? "disabled" : ""}>${icon("arrow_back")}</button><button class="btn secondary small" id="next-page" aria-label="Next page" ${(page + 1) * 10 >= cs.length ? "disabled" : ""}>${icon("arrow_forward")}</button></div></div>`
    : `<div class="empty">No customers match this filter.</div>`;
}
function s12() {
  const box = (n, h, t) => `<div class="cycle-box"><strong>${n}. ${h}</strong><span>${t}</span></div>`;
  const tile = (ic, t) => `<div class="tile">${badgeIcon(ic)}<span>${t}</span></div>`;
  return slide({
    id: "s12",
    section: "implementation",
    page: 11,
    title: "Every decision is logged, and a small holdout shows if offers work",
    body: `<div class="cols-split even">
      <div><div class="cycle">${box(1, "Score", "risk for each customer")}${icon("arrow_forward", "cyc right")}${box(2, "Decide", "action, cost, net benefit")}${icon("arrow_forward", "cyc up")}<span></span>${icon("arrow_forward", "cyc down")}${box(4, "Record", "retained or churned")}${icon("arrow_forward", "cyc left")}${box(3, "Act", "after human approval")}</div>
        <p class="holdout"><strong>Holdout:</strong> a random share of flagged customers, for example 10%, gets no offer, so uplift can be measured.</p></div>
      <div>${colHead("Model health")}<div class="tiles">${tile("show_chart", "Monthly PR-AUC and calibration")}${tile("compare_arrows", "Drift in inputs and in the score")}${tile("place", "Recall gaps across regions")}${tile("autorenew", "Retrain when metrics drop")}</div>
        ${colHead("Workflow health")}<div class="tiles">${tile("assignment_turned_in", "Approval, edit and rejection rates")}${tile("attach_money", "Cost per saved customer vs Rp6M")}${tile("security", "Proposals blocked by guardrails")}${tile("error_outline", "Agent errors and tool-call limits")}</div></div>
    </div>`,
  });
}
function s13() {
  const cannot = [
    ["Sample", "208 customers and 41 churners, all from one cohort"],
    ["Offer effect", "Success rates (20%, 50%) come from the brief, not from tests"],
    ["Consent", "Contact limits and eligibility are not in the data"],
    ["Validation", "No later labelled month, so no out-of-time test"],
    ["Fairness", "Age and gender excluded; other fields may act as proxies"],
  ];
  const notDone = [
    ["Boosted trees or deep models.", "41 churners is too few; they would fit noise."],
    ["Uplift model.", "Needs a randomised offer test first."],
    ["LLM chooses the action.", "Costs and eligibility must stay exact and auditable."],
    ["Auto-sent offers.", "Consent is unknown, so a person approves."],
  ];
  return slide({
    id: "s13",
    section: "implementation",
    page: 12,
    title: "Evidence is thin, so every benefit figure is a scenario, not a result",
    body: `<div class="cols-2">
      <div>${colHead("What this analysis cannot claim")}<table class="data pairs keyed"><tbody>${cannot
        .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
        .join("")}</tbody></table></div>
      <div>${colHead("What I chose not to do, and why")}${notDone
        .map(([k, v]) => iconRow("block", `<strong>${k}</strong> ${v}`))
        .join("")}</div>
    </div>
    <div class="statement">Next step: a randomised pilot to replace the assumed 20% and 50% success rates.</div>`,
  });
}

/* ---------- Appendix ---------- */

function a1() {
  const r = data.report,
    e = r.evaluation;
  const rows = [
    ["Logistic regression", e.logistic_regression, true],
    ["Shallow decision tree", e.shallow_tree],
    ["Business rule", e.business_rule],
    ["Prevalence only", e.constant_prevalence],
    ["Logistic, out-of-fold", r.oof],
  ];
  const f = (v) => (v == null ? "n/a" : v.toFixed(3));
  return slide({
    id: "a1",
    section: "appendix",
    page: "A1",
    title: "Logistic regression leads on every metric, on a small holdout",
    body: `${colHead(`Holdout (n = ${e.logistic_regression.n}) and out-of-fold (n = ${r.oof.n})`)}<div class="table-wrap"><table class="data"><thead><tr><th>Model</th><th class="num">PR-AUC</th><th class="num">ROC-AUC</th><th class="num">Brier</th><th class="num">Prec. @20%</th><th class="num">Recall @20%</th><th class="num">Lift @20%</th></tr></thead><tbody>${rows
      .map(
        ([n, m, hl]) =>
          `<tr class="${hl ? "hl" : ""}"><td>${n}</td><td class="num">${f(m.pr_auc)}</td><td class="num">${f(m.roc_auc)}</td><td class="num">${f(m.brier)}</td><td class="num">${f(m.precision_at_20pct)}</td><td class="num">${f(m.recall_at_20pct)}</td><td class="num">${m.lift_at_20pct.toFixed(1)}×</td></tr>`,
      )
      .join("")}</tbody></table></div>
      <div class="cols-2 tight"><div>${colHead("Sensitivity check")}<p>${r.sensitivity.exact_feature_overlap_test_rows} of ${e.logistic_regression.n} holdout customers share exact feature values with training customers. Without them (n = ${r.sensitivity.nonoverlap_holdout.n}): PR-AUC ${f(r.sensitivity.nonoverlap_holdout.pr_auc)}, ROC-AUC ${f(r.sensitivity.nonoverlap_holdout.roc_auc)}.</p></div>
      <div>${colHead("Setup")}<p>75/25 stratified split, seed ${r.seed}. Logistic C = 0.3; tree depth 3; five-fold out-of-fold scores for the demo.</p></div></div>`,
  });
}
function a2() {
  const r = data.report;
  const regions = r.subgroups.filter((g) => g.dimension === "region").sort((a, b) => b.n - a.n);
  const gender = r.subgroups.filter((g) => g.dimension === "gender" && g.group !== "Unknown");
  const qn = ["1 (lowest)", "2", "3", "4", "5 (highest)"];
  return slide({
    id: "a2",
    section: "appendix",
    page: "A2",
    title: "Churn clusters in Bandung, where recall is half that of other regions",
    body: `<div class="cols-2">
      <div>${colHead("Calibration, out-of-fold quintiles")}<table class="data"><thead><tr><th>Quintile</th><th class="num">n</th><th class="num">Mean score</th><th class="num">Observed churn</th></tr></thead><tbody>${r.calibration
        .map((c, i) => `<tr><td>${qn[i]}</td><td class="num">${c.n}</td><td class="num">${pct(c.mean_score)}</td><td class="num">${pct(c.observed_rate)}</td></tr>`)
        .join("")}</tbody></table><p class="note">Observed churn sits below the score in quintile 4 and above it in quintile 5: ranking is strong, probabilities are not calibrated.</p></div>
      <div>${colHead("By region, descriptive")}<table class="data"><thead><tr><th>Region</th><th class="num">n</th><th class="num">Churned</th><th class="num">Rate</th><th class="num">Recall @20%</th></tr></thead><tbody>${regions
        .map(
          (g) =>
            `<tr class="${g.group === "Bandung" ? "hl" : ""}"><td>${esc(g.group)}</td><td class="num">${g.n}</td><td class="num">${g.positive_count}</td><td class="num">${pct(g.observed_rate)}</td><td class="num">${g.recall_at_20pct == null ? "n/a" : g.recall_at_20pct.toFixed(2)}</td></tr>`,
        )
        .join("")}</tbody></table><p class="note">Gender is not a model input. Churn is ${gender.map((g) => `${pct(g.observed_rate)} for ${g.group.toLowerCase() === "female" ? "women" : "men"}`).join(" and ")}, recall ${gender.map((g) => g.recall_at_20pct.toFixed(2)).join(" and ")}. Groups are small; checks are descriptive only.</p></div>
    </div>`,
  });
}
function a3() {
  const r = data.report,
    be = r.economics.sensitivity.breakeven_multiplier,
    opt = r.economics.optimisation;
  return slide({
    id: "a3",
    section: "appendix",
    page: "A3",
    title: be ? `The plan stays positive down to ${be.toFixed(2)}× the assumed success rates` : "The plan never breaks even under the tested assumptions",
    body: `<div class="cols-2">
      <div>${colHead("Break-even sensitivity", "net benefit, Rp M")}${sensitivityChart(r)}<p class="note">The same policy re-planned across success-rate multipliers and retained values (Rp3M to Rp12M).</p></div>
      <div>${colHead("Net benefit versus threshold")}${decisionChart(r)}<p class="note">Acting on the score against treating everyone or no one. An exact allocation under the same budget reaches ${short(opt.exact_net_benefit, 2)} against ${short(opt.greedy_net_benefit, 2)} for the greedy plan.</p></div>
    </div>`,
  });
}
function a4() {
  const r = data.report;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = (s) => `${months[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
  const early = r.audit.coverage.filter((c) => c.snapshot < "2025-09-01" && c.label_observed);
  const rows = [
    early.length && {
      snapshot: `${label(early[0].snapshot).split(" ")[0]} to ${label(early.at(-1).snapshot)}`,
      customers: early.reduce((n, c) => n + c.customers, 0),
      churn: early.reduce((n, c) => n + c.churn, 0),
      non_churn: early.reduce((n, c) => n + c.non_churn, 0),
    },
    ...r.audit.coverage.filter((c) => !(c.snapshot < "2025-09-01" && c.label_observed)).map((c) => ({ ...c, snapshot: label(c.snapshot) + (c.snapshot === r.snapshot ? " (used)" : "") })),
  ].filter(Boolean);
  const allowed = {
    basic_offer: "No service contact in 30 days",
    premium_offer: "No service contact in 30 days",
    technical_review: "Technical contact in 30 days",
    billing_review: "Billing contact, no technical",
    no_action: "Always",
  };
  const demo = buildPlan(data.intelligence.customers, DEFAULTS);
  const n = (k) => demo.items.filter((i) => i.action === k).length;
  return slide({
    id: "a4",
    section: "appendix",
    page: "A4",
    title: "Earlier snapshots are nearly all churners, so only November is usable",
    body: `<div class="cols-2">
      <div>${colHead("Snapshots with known outcomes")}<table class="data"><thead><tr><th>Snapshot</th><th class="num">Customers</th><th class="num">Churned</th><th class="num">Stayed</th></tr></thead><tbody>${rows
        .map(
          (c) =>
            `<tr class="${String(c.snapshot).includes("used") ? "hl" : ""}"><td>${c.snapshot}</td><td class="num">${c.customers}</td><td class="num">${c.churn ?? "unknown"}</td><td class="num">${c.non_churn ?? "unknown"}</td></tr>`,
        )
        .join("")}</tbody></table></div>
      <div>${colHead("Action catalogue (retention-v1)")}<table class="data"><thead><tr><th>Action</th><th class="num">Cost</th><th>Allowed when</th></tr></thead><tbody>${Object.entries(ACTIONS)
        .map(([k, a]) => `<tr><td>${a.label}</td><td class="num">${short(a.cost)}</td><td>${allowed[k]}</td></tr>`)
        .join("")}</tbody></table></div>
    </div>
    <div class="statement">Demo plan, ${short(DEFAULTS.budget, 0)} and ${DEFAULTS.maxCustomers} customers: ${n("premium_offer")} premium, ${n("basic_offer")} basic, ${n("technical_review") + n("billing_review")} reviews; scenario net benefit ${short(demo.scenario_net_benefit)}.</div>`,
    source: "Offer costs from the brief; review costs are illustrative.",
  });
}

/* ---------- Customer detail ---------- */

function showCustomer(id) {
  const c = data.intelligence.customers.find((c) => c.customer_id === id);
  if (!c) return;
  const actions = compareActions(c, config);
  const top = Math.max(...c.model_signals.map((s) => Math.abs(s.contribution_log_odds)), 0.01);
  $("#customer-detail").innerHTML = `<div class="eyebrow">CUSTOMER · 1 NOV 2025</div><h2 class="slide-title" id="customer-title">${esc(id)}</h2><hr class="slide-rule">
    <p class="meta">${esc(c.region)} · ${esc(c.features.contractType)} · ${c.history_months_at_snapshot} usage month(s) observed · ${band(c)}</p>
    ${kpis([
      [pct(c.risk_score), "out-of-fold risk estimate", `Fold ${c.fold}`],
      [`${c.features.tenureMonths} mo`, "tenure", ""],
      [short(c.features.monthlyCharges, 0), "monthly charge", ""],
    ])}
    <div class="cols-2 tight">
      <div>${colHead("Observed evidence")}${c.evidence.map((e) => iconRow("done", esc(e))).join("")}
        <p class="note"><strong>Unknown at decision time:</strong> consent, live account status, contact frequency, offer eligibility and current resolution status.</p></div>
      <div>${colHead("Model contributions", "log-odds")}<div class="signals">${c.model_signals
        .map((s) => {
          const w = (Math.abs(s.contribution_log_odds) / top) * 50;
          const up = s.contribution_log_odds > 0;
          return `<div class="signal"><code>${esc(s.feature)}</code><span class="signal-track"><i class="${up ? "up" : "down"}" style="width:${w}%;left:${up ? 50 : 50 - w}%"></i></span><strong>${up ? "+" : "−"}${Math.abs(s.contribution_log_odds).toFixed(2)}</strong></div>`;
        })
        .join("")}</div><p class="note">Maroon pushes risk up, grey pulls it down. These explain the score, not the cause of churn.</p></div>
    </div>
    ${colHead("Action comparison", "current assumptions")}<div class="table-wrap"><table class="data"><thead><tr><th>Action</th><th class="num">Cost</th><th class="num">Scenario net</th><th>Proposal status</th></tr></thead><tbody>${actions
      .map(
        (a) =>
          `<tr><td>${esc(a.label)}</td><td class="num">${short(a.cost)}</td><td class="num">${a.scenario_net_benefit === null ? "Unmeasured" : short(a.scenario_net_benefit, 2)}</td><td>${a.action === "no_action" ? "No outreach" : a.eligible_for_proposal ? "Review required" : "Not eligible"}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  $("#customer-dialog").showModal();
}

/* ---------- Navigation ---------- */

let slides = [];
function goTo(id, smooth = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  window.history.replaceState(null, "", `#${id}`);
}
function currentIndex() {
  const line = window.innerHeight * 0.35;
  let index = 0;
  slides.forEach((s, i) => {
    if (s.getBoundingClientRect().top <= line) index = i;
  });
  return index;
}
function syncPager() {
  const i = currentIndex();
  $("#slide-count").textContent = `${i + 1} / ${slides.length}`;
  const section = slides[i]?.dataset.section;
  document.querySelectorAll(".bar-sections button").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
}
function step(delta) {
  const i = Math.min(slides.length - 1, Math.max(0, currentIndex() + delta));
  goTo(slides[i].id);
}

function render() {
  $("#deck").innerHTML = [cover(), s2(), s3(), s4(), s5(), s6(), s7(), s8(), s9(), s10(), s11(), s12(), s13(), closing(), a1(), a2(), a3(), a4()].join("");
  slides = [...document.querySelectorAll(".slide")];
  $("#risk-filter").value = filter;
  updatePlanner();
  updateCustomers();
  renderReview();
  loadHistory();
  syncPager();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button,a");
  if (!b) return;
  if (busy && (b.dataset.plan || b.dataset.prompt || ["approve-plan", "reject-plan", "record-outcome", "save-plan"].includes(b.id))) {
    toast("Wait for the current run to finish.");
    return;
  }
  if (b.dataset.goto) {
    e.preventDefault();
    goTo(b.dataset.goto);
  }
  if (b.id === "prev-slide") step(-1);
  if (b.id === "next-slide") step(1);
  if (b.dataset.customer) showCustomer(b.dataset.customer);
  if (b.classList.contains("dialog-close")) $("#customer-dialog").close();
  if (b.dataset.prompt) {
    $("#agent-prompt").value = b.dataset.prompt;
    prompt = b.dataset.prompt;
  }
  if (b.dataset.plan) {
    activePlan = window.savedPlans.find((p) => p.id === b.dataset.plan);
    agentResult = null;
    renderReview();
  }
  if (b.id === "next-page") {
    page++;
    updateCustomers();
  }
  if (b.id === "prev-page") {
    page--;
    updateCustomers();
  }
  if (b.id === "save-plan") await savePlan();
  if (b.id === "run-agent") await runAgent();
  if (b.id === "refresh-history") await loadHistory();
  if (["approve-plan", "reject-plan"].includes(b.id)) {
    if (!$("#review-ack").checked) {
      toast("Acknowledge the checklist first.");
      return;
    }
    try {
      activePlan = await api("review", { id: activePlan.id, action: b.id === "approve-plan" ? "approve" : "reject", acknowledged: true });
      renderReview();
      await loadHistory();
      toast("Review recorded. No external action executed.");
    } catch (err) {
      toast(err.message);
    }
  }
  if (b.id === "record-outcome") {
    try {
      await api("outcome", { id: activePlan.id, customer_id: $("#outcome-customer").value, outcome: $("#outcome-value").value });
      toast("Simulated outcome recorded; excluded from training.");
      await loadHistory();
    } catch (err) {
      toast(err.message);
    }
  }
  if (b.id === "export-plan") {
    const blob = new Blob([JSON.stringify(activePlan, null, 2)], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `retention-plan-${activePlan.id.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "customer-search") {
    search = e.target.value;
    page = 0;
    updateCustomers();
  }
  if (["budget", "capacity", "value", "basic-success", "premium-success", "technical"].includes(id)) {
    updatePlanner();
    if (!busy) updateCustomers();
  }
  if (id === "probe") {
    probe = Number(e.target.value) / 100;
    updateThreshold();
  }
  if (id === "agent-prompt") prompt = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "risk-filter") {
    filter = e.target.value;
    page = 0;
    updateCustomers();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,textarea,select,[contenteditable]") || $("#customer-dialog").open) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") {
    e.preventDefault();
    step(1);
  }
  if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    step(-1);
  }
});
$("#customer-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
window.addEventListener("hashchange", () => {
  const hash = location.hash.slice(1);
  const target = LEGACY[hash] ?? hash;
  if (document.getElementById(target)) goTo(target, false);
});
let ticking = false;
window.addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    syncPager();
    ticking = false;
  });
});

try {
  data = await api("bootstrap");
  render();
  const hash = location.hash.slice(1);
  const target = LEGACY[hash] ?? hash;
  // Wait for the web fonts so slide heights are final before jumping.
  if (target && document.getElementById(target)) document.fonts.ready.then(() => goTo(target, false));
} catch (e) {
  $("#deck").innerHTML = `<div class="error">Unable to load the deck: ${esc(e.message)}. Please refresh.</div>`;
}
