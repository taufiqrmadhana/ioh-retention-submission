import { buildPlan, DEFAULTS, ACTIONS, compareActions } from "./policy.js";
import { modelComparisonChart, calibrationChart, sensitivityChart, decisionChart } from "./charts.js";

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
const SECTIONS = ["overview", "customers", "agent", "evidence"];

let data,
  tab = "overview",
  config = { ...DEFAULTS },
  activePlan = null,
  agentResult = null,
  page = 0,
  search = "",
  filter = "all",
  busy = false;
let prompt =
  "Susun rencana retention sesuai budget dan kapasitas di panel kiri. Prioritaskan pemeriksaan masalah teknis sebelum menawarkan insentif.";

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
  setTimeout(() => $("#toast").classList.remove("show"), 3500);
}

// Building blocks shared by every view.
function pageHead(eyebrow, title, lede, actions = "") {
  return `<section class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>${
    actions ? `<div class="page-actions">${actions}</div>` : ""
  }</section><hr class="rule"><p class="lede">${lede}</p>`;
}
function sectionHead(title, aside = "") {
  return `<div class="section-head"><h2>${title}</h2>${aside ? `<div class="section-aside">${aside}</div>` : ""}</div>`;
}
function kpis(items) {
  return `<div class="kpis">${items
    .map(
      ([value, label, note]) =>
        `<div class="kpi"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div>${
          note ? `<div class="kpi-note">${note}</div>` : ""
        }</div>`,
    )
    .join("")}</div>`;
}
function hbars(rows, max) {
  return `<div class="hbars">${rows
    .map(
      ([label, n]) =>
        `<div class="hbar"><span>${label}</span><span class="hbar-track"><i style="width:${max ? (n / max) * 100 : 0}%"></i></span><strong>${n}</strong></div>`,
    )
    .join("")}</div>`;
}
function status(s) {
  return `<span class="status ${esc(s)}">${esc(s.replaceAll("_", " "))}</span>`;
}
function risk(c) {
  return `<span class="meter"><span class="meter-track"><i style="width:${Math.round(c.risk_score * 100)}%"></i></span>${pct(c.risk_score)}</span>`;
}
function band(c) {
  return `<span class="band ${c.risk_band.toLowerCase()}">${c.risk_band}</span>`;
}
function idLink(id) {
  return `<button class="id-link" data-customer="${esc(id)}">${esc(id)}</button>`;
}
function recommended(c) {
  if (c.features.technical_30d) return "Technical review";
  if (c.features.billing_30d) return "Billing review";
  const best = compareActions(c, config)
    .filter((a) => a.eligible_for_proposal && a.action.endsWith("_offer"))
    .sort((a, b) => b.scenario_net_benefit - a.scenario_net_benefit)[0];
  return best?.scenario_net_benefit > 0 ? "Compare offers" : "No action";
}
function table(customers) {
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Customer</th><th>Region</th><th>Risk estimate</th><th>Band</th><th>Contract</th><th>Review route</th></tr></thead><tbody>${customers
    .map(
      (c) =>
        `<tr><td>${idLink(c.customer_id)}</td><td>${esc(c.region)}</td><td>${risk(c)}</td><td>${band(c)}</td><td>${esc(c.features.contractType)}</td><td>${recommended(c)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function overview() {
  const cs = data.intelligence.customers;
  const plan = buildPlan(cs, config);
  const count = (k) => plan.items.filter((i) => i.action === k).length;
  const reviews = count("technical_review") + count("billing_review");
  const service = cs.filter((c) => c.features.technical_30d > 0 || c.features.billing_30d > 0).length;
  const buckets = [0, 0, 0, 0, 0];
  cs.forEach((c) => buckets[Math.min(4, Math.floor(c.risk_score * 5))]++);
  const actionRows = Object.keys(ACTIONS)
    .filter((k) => k !== "no_action")
    .map((k) => [ACTIONS[k].label, count(k)]);
  return (
    pageHead(
      "OVERVIEW",
      `${short(plan.total_cost)} reaches ${plan.items.length} customers: ${count("premium_offer")} premium, ${count("basic_offer")} basic and ${reviews} service reviews`,
      `${cs.length} customers were active on 1 November 2025. Each carries an out-of-fold churn score; the policy turns that score into the cheapest action worth taking, within the budget and capacity set in the agent workspace.`,
      `<button class="btn secondary" data-tab="evidence">Model evidence</button><button class="btn primary" data-tab="agent">Open agent workspace</button>`,
    ) +
    kpis([
      [cs.length, "customers active on 1 Nov 2025", "October usage, not churned before the snapshot"],
      [cs.filter((c) => c.risk_score >= 0.5).length, "scored 50% or higher", "Exploratory cut, not an eligibility rule"],
      [service, "had a service or billing contact", "Prior 30 days; resolution unverified"],
      [short(plan.scenario_net_benefit), "scenario net benefit of this plan", "Assumed success rates, not measured uplift"],
    ]) +
    `<div class="grid-main">
      <section>${sectionHead("Customer review queue", `<button class="link" data-tab="customers">All ${cs.length} customers →</button>`)}
        ${table([...cs].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10))}
        <p class="note">Top 10 by retrospective out-of-fold score. A high score does not establish why a customer leaves, or that an offer would keep them.</p>
      </section>
      <aside class="stack">
        <section>${sectionHead("Policy allocation", `${plan.items.length} of ${config.maxCustomers} slots`)}
          <div class="figure"><span class="figure-value">${short(plan.total_cost)}</span><span class="figure-label">of the ${short(config.budget)} budget committed</span></div>
          ${hbars(actionRows, config.maxCustomers)}
          <div class="kv"><span>Unallocated budget</span><strong>${short(plan.remaining_budget)}</strong></div>
          <p class="note">Service reviews take up to 30% of capacity first. Offers fill the rest by assumed net benefit per rupiah.</p>
        </section>
        <section>${sectionHead("Score distribution", `${cs.length} customers`)}
          ${hbars(buckets.map((n, i) => [`${i * 20}–${(i + 1) * 20}%`, n]), Math.max(...buckets))}
          <p class="note">Internal validation only; there is no later month to test on.</p>
        </section>
      </aside>
    </div>
    <div class="statement">Risk says who may leave. Economics says whether spending on them is worth it.</div>`
  );
}

function customers() {
  return (
    pageHead(
      "CUSTOMERS",
      "Every score comes with its evidence and the actions it allows",
      "Search by customer ID or region and filter by risk band. Open a customer to see the model contributions and the action comparison under the current assumptions.",
    ) +
    `<div class="toolbar"><input id="customer-search" type="search" placeholder="Search customer ID or region" aria-label="Search customers" value="${esc(search)}"><select id="risk-filter" aria-label="Filter risk band"><option value="all">All risk bands</option><option value="High">High risk</option><option value="Medium">Medium risk</option><option value="Low">Low risk</option></select></div><div id="customer-table"></div>`
  );
}
function updateCustomers() {
  const cs = data.intelligence.customers
    .filter(
      (c) =>
        (filter === "all" || c.risk_band === filter) &&
        `${c.customer_id} ${c.region}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.risk_score - a.risk_score);
  page = Math.min(page, Math.max(0, Math.ceil(cs.length / 12) - 1));
  $("#customer-table").innerHTML = cs.length
    ? table(cs.slice(page * 12, page * 12 + 12)) +
      `<div class="pagination"><span>${page * 12 + 1}–${Math.min(cs.length, page * 12 + 12)} of ${cs.length} customers</span><div><button class="btn secondary small" id="prev-page" aria-label="Previous page" ${page === 0 ? "disabled" : ""}>←</button><button class="btn secondary small" id="next-page" aria-label="Next page" ${(page + 1) * 12 >= cs.length ? "disabled" : ""}>→</button></div></div>`
    : `<div class="empty">No customers match this filter.</div>`;
}

function controls() {
  return `<section class="card controls"><div class="card-head">Campaign settings</div>
    <div class="field"><label for="budget">Campaign budget</label><div class="field-value" id="budget-label">${short(config.budget, 2)}</div><input id="budget" type="range" min="0" max="10000000" step="50000" value="${config.budget}"><div class="range-ends"><span>Rp0</span><span>Rp10M</span></div></div>
    <div class="field"><label for="capacity">Maximum customers</label><div class="field-value" id="capacity-label">${config.maxCustomers} customers</div><input id="capacity" type="range" min="1" max="20" value="${config.maxCustomers}"><div class="range-ends"><span>1</span><span>20</span></div></div>
    <label class="check"><input type="checkbox" id="technical" ${config.prioritizeTechnical ? "checked" : ""}>Technical reviews before billing reviews</label>
    <details class="assumptions"><summary>Economic assumptions</summary>
      <div class="field"><label for="value">Retained customer value (Rp)</label><input class="input" id="value" type="number" min="0" max="12000000" step="100000" value="${config.retainedValue}"></div>
      <div class="field"><label for="basic-success">Basic offer success (%)</label><input class="input" id="basic-success" type="number" min="0" max="100" value="${config.basicSuccess * 100}"></div>
      <div class="field"><label for="premium-success">Premium offer success (%)</label><input class="input" id="premium-success" type="number" min="0" max="100" value="${config.premiumSuccess * 100}"></div>
      <p class="note">Share of would-be churners an offer keeps; an assumption from the brief, not observed uplift. Basic costs Rp150K, premium Rp450K. Review costs are illustrative: technical Rp50K, billing Rp25K.</p>
    </details>
    <button class="btn primary block" id="deterministic">Generate policy plan</button>
  </section>`;
}
function agent() {
  const steps = [
    ["Set constraints", "Budget, capacity and the economic assumptions"],
    ["Draft a plan", "Policy planner on all 208, or the agent on a shortlist"],
    ["Review and approve", "Checklist first; approval records a simulation"],
  ];
  return (
    pageHead(
      "AGENT WORKSPACE",
      "The agent drafts, the code verifies, and a person approves",
      "The policy planner covers all 208 customers; the agent investigates a shortlist of up to 30 with five tools. The same code recomputes every cost and benefit before a plan can be approved.",
    ) +
    `<ol class="process">${steps
      .map(([t, d], i) => `<li><span class="process-no">${i + 1}</span><div><strong>${t}</strong><span>${d}</span></div></li>`)
      .join("")}</ol>
    <div class="grid-planner">${controls()}<div class="stack">
      <section>${sectionHead(
        "Planning request",
        data.agent_available ? "DeepSeek connected · 5 tools · at most 14 calls" : "Live agent not configured · policy planner available",
      )}
        <textarea class="prompt" id="agent-prompt" maxlength="1500" aria-label="Retention objective">${esc(prompt)}</textarea>
        <div class="suggestions"><button class="btn secondary small suggestion" data-prompt="Build a retention plan within the configured budget. Investigate technical contacts first, and explain who should not receive an incentive.">Prioritise service reviews</button><button class="btn secondary small suggestion" data-prompt="Investigate high-risk customers with billing contacts. Compare allowed actions and submit a plan within the configured budget.">Review billing contacts</button></div>
        <div class="request-foot"><p class="note">Budget and capacity come from the settings panel. The output is a proposal; consent is still unverified.</p><button class="btn primary" id="run-agent" ${!data.agent_available || busy ? "disabled" : ""}>Run agent</button></div>
        <div id="agent-progress"></div><div id="agent-error"></div>
      </section>
      <div id="plan-result"></div>
      <section>${sectionHead("Session history", `<button class="link" id="refresh-history">Refresh</button>`)}<div id="history"><div class="empty">Loading history…</div></div></section>
    </div></div>`
  );
}
function planHTML(plan, trace = []) {
  if (!plan)
    return `<section>${sectionHead("Proposal")}<div class="empty">No proposal yet. Generate a policy plan or run the agent.</div></section>`;
  const pending = plan.status === "pending_review";
  return `<section class="plan">${sectionHead(plan.agent_model ? "Agent proposal" : "Policy proposal", status(plan.status))}
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
        : `<div class="empty">No affordable service review or offer with a positive assumed benefit under these settings.</div>`
    }
    <p class="note">${esc(plan.economic_note)} ${esc(plan.methodology)}</p>
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
    <button class="link" id="export-plan">Download proposal JSON</button>
  </section>`;
}

function evidence() {
  const r = data.report,
    m = r.evaluation.logistic_regression,
    a = r.audit,
    opt = r.economics.optimisation,
    tgt = r.targeting;
  const steps = [
    "October usage is treated as available on 1 November. Customers who churned before that date are excluded.",
    "Support contacts are counted strictly before the snapshot. Resolution status has no date, so it is left out.",
    "Churn is any churn date from 1 to 30 November. Registry completeness through 30 November is assumed.",
    "Customers are split 75/25 inside the cohort. Preprocessing is fitted on training rows only; nothing is tuned on the holdout.",
    "Demo scores are five-fold out-of-fold logistic regression. The agent never sees actual churn labels.",
  ];
  return (
    pageHead(
      "EVIDENCE",
      "A simple model ranks churners well, but the evidence base is small",
      "How the cohort was built, how the model was checked, and what this dataset cannot establish. Every benefit figure in the workbench is a scenario on assumed success rates.",
    ) +
    kpis([
      [a.customers, "customers in the source files", `${a.churn_records} with a churn date`],
      [r.cohort.n, "in the 1 Nov decision cohort", `${r.cohort.churn} churned in November`],
      [m.pr_auc.toFixed(2), "holdout PR-AUC", `95% interval ${m.pr_auc_bootstrap_95pct.map((v) => v.toFixed(2)).join(" to ")}`],
      [`${m.lift_at_20pct.toFixed(1)}×`, "lift in the top 20% of scores", `${m.n} holdout customers, ${m.positives} churners`],
    ]) +
    `<div class="grid-2">
      <section>${sectionHead("Point-in-time cohort")}<ol class="steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol></section>
      <section>${sectionHead("Data quality findings")}${[
        ["Customers with one usage row", a.one_usage_row],
        ["Customers with two usage rows", a.two_usage_rows],
        ["Usage rows in the churn month", a.usage_in_churn_month],
        ["Support contacts after churn", a.support_after_churn],
        ["Blank total charges", a.blank_total_charges],
        ["Customers without usage", a.missing_usage],
      ]
        .map(([k, v]) => `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`)
        .join("")}<p class="note">Earlier snapshots are almost all churners, so a chronological split would mix time with how the extract was selected. December has no observed outcome.</p></section>
    </div>
    <div class="grid-2">
      <section>${sectionHead("Holdout model comparison", "PR-AUC")}${modelComparisonChart(r)}<p class="note">Logistic regression was chosen in advance for interpretability; the tree is a fixed comparator. ${r.sensitivity.exact_feature_overlap_test_rows} holdout rows share exact features with training rows; without them PR-AUC is ${r.sensitivity.nonoverlap_holdout.pr_auc.toFixed(3)} on ${r.sensitivity.nonoverlap_holdout.n} customers.</p></section>
      <section>${sectionHead("Calibration", `Brier ${m.brier.toFixed(3)}`)}${calibrationChart(r)}<p class="note">Ranking is strong, probabilities are not calibrated: observed churn sits below the score in the fourth quintile and above it in the fifth.</p></section>
    </div>
    <div class="grid-2">
      <section>${sectionHead("Break-even sensitivity", `at ${r.economics.sensitivity.breakeven_multiplier ?? "n/a"}× the assumed rates`)}${sensitivityChart(r)}<p class="note">The same policy re-planned across success-rate multipliers and retained values. Below the dashed line the recommended spend stops creating value.</p></section>
      <section>${sectionHead("Net benefit versus threshold")}${decisionChart(r)}<p class="note">Acting on the score against treating everyone or no one, at equal cost-to-benefit weighting.</p></section>
    </div>
    <section>${sectionHead("Observation coverage is not uniform")}<div class="table-wrap"><table class="data"><thead><tr><th>Available at</th><th class="num">Active customers</th><th class="num">Next-month churn</th><th class="num">Stayed</th><th>Outcome window</th></tr></thead><tbody>${a.coverage
      .map(
        (c) =>
          `<tr class="${c.snapshot === r.snapshot ? "hl" : ""}"><td>${c.snapshot}${c.snapshot === r.snapshot ? " (used)" : ""}</td><td class="num">${c.customers}</td><td class="num">${c.churn ?? "—"}</td><td class="num">${c.non_churn ?? "—"}</td><td>${c.label_observed ? "Assumed complete" : "Unobserved"}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>
    <div class="grid-2">
      <section>${sectionHead("Economic decision rule")}<p class="formula">Net benefit = risk × success rate × Rp6M − cost</p><p>Success means keeping a customer who would otherwise leave. The 20% and 50% rates come from the brief and do not prove uplift. Up to 30% of capacity goes to service reviews first; their benefit is unmeasured and only their cost counts.</p><p>The offer allocation is greedy and explainable. An exact allocation under the same constraints reaches ${short(opt.exact_net_benefit, 2)} against ${short(opt.greedy_net_benefit, 2)}, a ${opt.gap_pct == null ? "n/a" : opt.gap_pct.toFixed(1) + "%"} gap. Expected cost per prevented churn is ${short(tgt.top_capacity.cost_per_expected_save)} on the shortlist against ${short(tgt.cohort.cost_per_expected_save, 2)} across the cohort.</p></section>
      <section>${sectionHead("What this analysis cannot claim")}<ul class="limits">${r.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>
    </div>
    <div class="grid-2">
      <section>${sectionHead("What the agent can do")}<p>Read a bounded shortlist, inspect evidence, compare allowed actions, calculate a feasible plan and submit it for review. Every tool call is recorded.</p><p>The backend owns the arithmetic, the constraints and the approval states. There is no tool that messages a customer or issues an incentive.</p></section>
      <section>${sectionHead("Pilot and monitoring")}<p><strong>Pilot:</strong> randomise flagged customers into treatment and a no-contact control, stratified by risk, and measure retained margin, complaints and opt-outs over a fixed window.</p><p><strong>Monitor:</strong> coverage and missing data, delayed PR-AUC and calibration, subgroup error rates, budget violations, rejected tool calls and human overrides. Retrain only on observed production outcomes.</p></section>
    </div>
    <section>${sectionHead("Subgroup audit", "descriptive only")}<div class="table-wrap"><table class="data"><thead><tr><th>Dimension</th><th>Group</th><th class="num">Customers</th><th class="num">Churned</th><th class="num">Observed rate</th><th class="num">Mean score</th><th class="num">Recall @20%</th></tr></thead><tbody>${r.subgroups
      .map(
        (g) =>
          `<tr><td>${esc(g.dimension)}</td><td>${esc(g.group)}</td><td class="num">${g.n}</td><td class="num">${g.positive_count}</td><td class="num">${pct(g.observed_rate)}</td><td class="num">${pct(g.mean_score)}</td><td class="num">${g.recall_at_20pct == null ? "n/a" : g.recall_at_20pct.toFixed(2)}</td></tr>`,
      )
      .join("")}</tbody></table></div><p class="note">Gender and age are not model inputs, which does not rule out proxies. Groups are too small for a fairness certification.</p></section>
    <div class="statement">Next step: a randomised pilot to replace the assumed 20% and 50% success rates.</div>`
  );
}

function render() {
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#page-no").textContent = SECTIONS.indexOf(tab) + 1;
  $("#main").innerHTML = { overview, customers, agent, evidence }[tab]();
  if (tab === "customers") {
    $("#risk-filter").value = filter;
    updateCustomers();
  }
  if (tab === "agent") {
    $("#plan-result").innerHTML = planHTML(activePlan, agentResult?.trace ?? activePlan?.agent_trace ?? []);
    history();
  }
}
function navigate(next) {
  if (!SECTIONS.includes(next)) return;
  if (busy) {
    toast("The agent is running. Wait for the current proposal.");
    return;
  }
  tab = next;
  location.hash = next;
  render();
  window.scrollTo({ top: 0 });
}
async function history() {
  try {
    const h = await api("history");
    if (!$("#history")) return;
    $("#history").innerHTML = h.plans.length
      ? h.plans
          .slice(0, 8)
          .map(
            (p) =>
              `<div class="history-row"><div><button class="id-link" data-plan="${p.id}">${p.id.slice(0, 8)}</button><span class="meta">${new Date(p.created_at).toLocaleString()} · ${p.items.length} customers · ${short(p.total_cost, 2)}</span></div>${status(p.status)}</div>`,
          )
          .join("") +
        `<p class="note">${h.events.length} audit ${h.events.length === 1 ? "event" : "events"} recorded, ${h.events.filter((e) => e.kind === "simulated_outcome").length} simulated outcomes.</p>`
      : '<div class="empty">No saved plans in this browser session yet.</div>';
    window.savedPlans = h.plans;
  } catch (e) {
    if ($("#history")) $("#history").textContent = e.message;
  }
}
function readControls() {
  config = {
    budget: Number($("#budget").value),
    maxCustomers: Number($("#capacity").value),
    retainedValue: Number($("#value").value),
    basicSuccess: Number($("#basic-success").value) / 100,
    premiumSuccess: Number($("#premium-success").value) / 100,
    prioritizeTechnical: $("#technical").checked,
  };
}
function setBusy(value) {
  busy = value;
  document
    .querySelectorAll("[data-plan],#approve-plan,#reject-plan,#record-outcome,.suggestion")
    .forEach((el) => (el.disabled = value));
  for (const id of ["run-agent", "deterministic"])
    if ($("#" + id)) $("#" + id).disabled = value || (id === "run-agent" && !data.agent_available);
  $("#agent-prompt").disabled = value;
  document.querySelectorAll(".controls input").forEach((el) => (el.disabled = value));
}
async function createPlan(useAgent) {
  readControls();
  prompt = $("#agent-prompt").value;
  setBusy(true);
  $("#agent-error").innerHTML = "";
  let seconds = 0;
  const progress = () => {
    $("#agent-progress").innerHTML = `<div class="running"><span class="spinner"></span>${
      useAgent ? "Agent is gathering evidence and calling tools" : "Calculating the policy plan"
    } · ${seconds}s</div>`;
  };
  progress();
  const timer = setInterval(() => {
    seconds++;
    progress();
  }, 1000);
  try {
    const result = await api(useAgent ? "agent" : "plan", useAgent ? { prompt, settings: config } : { settings: config });
    if (useAgent) {
      agentResult = result;
      activePlan = result.plan;
      if (!activePlan) $("#agent-error").innerHTML = `<p class="note">${esc(result.answer)}</p>`;
    } else {
      activePlan = result;
      agentResult = null;
    }
    $("#plan-result").innerHTML = planHTML(activePlan, agentResult?.trace ?? []);
    await history();
  } catch (e) {
    $("#agent-error").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    clearInterval(timer);
    $("#agent-progress").innerHTML = "";
    setBusy(false);
  }
}
function showCustomer(id) {
  const c = data.intelligence.customers.find((c) => c.customer_id === id);
  if (!c) return;
  const actions = compareActions(c, config);
  const top = Math.max(...c.model_signals.map((s) => Math.abs(s.contribution_log_odds)), 0.01);
  $("#customer-detail").innerHTML = `<div class="eyebrow">CUSTOMER · 1 NOV 2025</div><h2 id="customer-title">${esc(id)}</h2><hr class="rule">
    <p class="meta">${esc(c.region)} · ${esc(c.features.contractType)} · ${c.history_months_at_snapshot} usage month(s) observed · ${band(c)}</p>
    ${kpis([
      [pct(c.risk_score), "out-of-fold risk estimate", `Fold ${c.fold}`],
      [`${c.features.tenureMonths} mo`, "tenure", ""],
      [short(c.features.monthlyCharges, 0), "monthly charge", ""],
    ])}
    <div class="grid-2">
      <section>${sectionHead("Observed evidence")}<ul class="evidence">${c.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
        <p class="note"><strong>Unknown at decision time:</strong> consent, live account status, contact frequency, offer eligibility and current resolution status.</p></section>
      <section>${sectionHead("Model contributions", "log-odds")}<div class="signals">${c.model_signals
        .map((s) => {
          const w = (Math.abs(s.contribution_log_odds) / top) * 50;
          const up = s.contribution_log_odds > 0;
          return `<div class="signal"><code>${esc(s.feature)}</code><span class="signal-track"><i class="${up ? "up" : "down"}" style="width:${w}%;${up ? "left:50%" : `left:${50 - w}%`}"></i></span><strong>${up ? "+" : "−"}${Math.abs(s.contribution_log_odds).toFixed(2)}</strong></div>`;
        })
        .join("")}</div><p class="note">Maroon pushes risk up, grey pulls it down. These explain the score, not the cause of churn.</p></section>
    </div>
    <section>${sectionHead("Action comparison", "current assumptions")}<div class="table-wrap"><table class="data"><thead><tr><th>Action</th><th class="num">Cost</th><th class="num">Scenario net</th><th>Proposal status</th></tr></thead><tbody>${actions
      .map(
        (a) =>
          `<tr><td>${esc(a.label)}</td><td class="num">${short(a.cost)}</td><td class="num">${a.scenario_net_benefit === null ? "Unmeasured" : short(a.scenario_net_benefit, 2)}</td><td>${a.action === "no_action" ? "No outreach" : a.eligible_for_proposal ? "Review required" : "Not eligible"}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>`;
  $("#customer-dialog").showModal();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button,a");
  if (!b) return;
  if (busy && (b.dataset.plan || b.dataset.prompt || ["approve-plan", "reject-plan", "record-outcome"].includes(b.id))) {
    toast("Wait for the current run to finish before changing the proposal.");
    return;
  }
  if (b.dataset.tab) {
    e.preventDefault();
    navigate(b.dataset.tab);
  }
  if (b.dataset.customer) showCustomer(b.dataset.customer);
  if (b.classList.contains("dialog-close")) $("#customer-dialog").close();
  if (b.dataset.prompt) {
    $("#agent-prompt").value = b.dataset.prompt;
    prompt = b.dataset.prompt;
  }
  if (b.dataset.plan) {
    activePlan = window.savedPlans.find((p) => p.id === b.dataset.plan);
    agentResult = null;
    $("#plan-result").innerHTML = planHTML(activePlan, activePlan.agent_trace ?? []);
  }
  if (b.id === "next-page") {
    page++;
    updateCustomers();
  }
  if (b.id === "prev-page") {
    page--;
    updateCustomers();
  }
  if (b.id === "deterministic") await createPlan(false);
  if (b.id === "run-agent") await createPlan(true);
  if (b.id === "refresh-history") await history();
  if (["approve-plan", "reject-plan"].includes(b.id)) {
    if (!$("#review-ack").checked) {
      toast("Acknowledge the checklist first.");
      return;
    }
    try {
      activePlan = await api("review", {
        id: activePlan.id,
        action: b.id === "approve-plan" ? "approve" : "reject",
        acknowledged: true,
      });
      $("#plan-result").innerHTML = planHTML(activePlan, agentResult?.trace ?? activePlan.agent_trace ?? []);
      await history();
      toast("Review recorded. No external action executed.");
    } catch (err) {
      toast(err.message);
    }
  }
  if (b.id === "record-outcome") {
    try {
      await api("outcome", {
        id: activePlan.id,
        customer_id: $("#outcome-customer").value,
        outcome: $("#outcome-value").value,
      });
      toast("Simulated outcome recorded; excluded from training.");
      await history();
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
  if (e.target.id === "customer-search") {
    search = e.target.value;
    page = 0;
    updateCustomers();
  }
  if (e.target.id === "budget") $("#budget-label").textContent = short(Number(e.target.value), 2);
  if (e.target.id === "capacity") $("#capacity-label").textContent = e.target.value + " customers";
  if (e.target.id === "agent-prompt") prompt = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "risk-filter") {
    filter = e.target.value;
    page = 0;
    updateCustomers();
  }
});
// Close the dialog when the backdrop is clicked.
$("#customer-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (next !== tab) navigate(next);
});
try {
  data = await api("bootstrap");
  tab = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  render();
} catch (e) {
  $("#main").innerHTML = `<div class="error">Unable to load the workbench: ${esc(e.message)}. Please refresh.</div>`;
}
