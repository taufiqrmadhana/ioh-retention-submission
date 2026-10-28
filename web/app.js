import { buildPlan, DEFAULTS, ACTIONS, compareActions } from "./policy.js";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
const compact = (n) =>
  Math.abs(n) >= 1e6 ? `Rp ${(n / 1e6).toFixed(2)}m` : money(n);
const pct = (n) => `${(n * 100).toFixed(1)}%`;
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
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
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
function header(_section, title, subtitle, actions = "") {
  return `<section class="hero"><div><h1>${title}</h1><p>${subtitle}</p></div>${actions ? `<div class="hero-actions">${actions}</div>` : ""}</section>`;
}
function banner() {
  return `<div class="banner"><strong>Retrospective simulation</strong><span>Decision date: 01 Nov 2025. Scores are out-of-fold estimates; action benefits are assumptions. No customer contact or incentive issuance.</span></div>`;
}
function risk(c) {
  return `<span class="risk-meter"><i style="width:${Math.round(c.risk_score * 100)}%"></i></span>${pct(c.risk_score)}`;
}
function badge(c) {
  return `<span class="badge ${c.risk_band.toLowerCase()}">${c.risk_band}</span>`;
}
function recommended(c) {
  const available = compareActions(c, config).filter(
    (a) => a.eligible_for_proposal,
  );
  if (c.features.technical_30d) return "Technical review";
  if (c.features.billing_30d) return "Billing review";
  const best = available
    .filter((a) => a.action.endsWith("_offer"))
    .sort((a, b) => b.scenario_net_benefit - a.scenario_net_benefit)[0];
  return best?.scenario_net_benefit > 0 ? "Compare incentives" : "Observe";
}
function table(customers) {
  return `<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Region</th><th>Risk estimate</th><th>Band</th><th>Contract</th><th>Review route</th><th></th></tr></thead><tbody>${customers.map((c) => `<tr><td><button class="customer-button" data-customer="${esc(c.customer_id)}">${esc(c.customer_id)}</button></td><td>${esc(c.region)}</td><td>${risk(c)}</td><td>${badge(c)}</td><td>${esc(c.features.contractType)}</td><td>${recommended(c)}</td><td><button class="quiet" data-customer="${esc(c.customer_id)}" aria-label="Inspect ${esc(c.customer_id)}">Inspect</button></td></tr>`).join("")}</tbody></table></div>`;
}
function metric(label, value, detail, highlight = false) {
  return `<div class="metric ${highlight ? "highlight" : ""}"><span class="label">${label}</span><div class="value">${value}</div><div class="detail">${detail}</div></div>`;
}
function overview() {
  const cs = data.intelligence.customers;
  const plan = buildPlan(cs, config);
  const counts = [0, 0, 0, 0, 0];
  cs.forEach((c) => counts[Math.min(4, Math.floor(c.risk_score * 5))]++);
  const actionCounts = Object.keys(ACTIONS)
    .filter((k) => k !== "no_action")
    .map((k) => [k, plan.items.filter((i) => i.action === k).length]);
  const serviceContacts = cs.filter(
    (c) => c.features.technical_30d > 0 || c.features.billing_30d > 0,
  ).length;
  return (
    header(
      "",
      "Retention overview",
      "Review the historical cohort, inspect customer evidence, and prepare a budget-constrained proposal.",
      `<button class="secondary" data-tab="evidence">Model evaluation</button><button class="primary" data-tab="agent">Create proposal</button>`,
    ) +
    banner() +
    `<div class="metric-grid">${metric("Customers in cohort", cs.length, "Active at snapshot · October usage")}${metric("Score ≥ 50%", cs.filter((c) => c.risk_score >= 0.5).length, "Exploratory threshold; not eligibility")}${metric("Recent service / billing contacts", serviceContacts, "Prior 30 days · resolution unverified")}${metric("Campaign budget", money(config.budget), `Capacity: ${config.maxCustomers} customers`)}</div>
 <div class="operations-grid">
  <section class="panel queue-panel"><div class="panel-heading"><div><h2>Customer review queue</h2><p>Top 10 by risk estimate. Open a customer to inspect evidence and action eligibility.</p></div><button class="quiet" data-tab="customers">All ${cs.length} customers</button></div>
   ${table([...cs].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10))}
   <div class="table-note">Ranked by retrospective OOF score. A high score does not establish the cause of churn or the benefit of an offer.</div>
  </section>
  <aside class="operations-aside">
   <section class="panel"><div class="panel-heading"><div><h2>Policy allocation preview</h2><p>Current budget and capacity settings</p></div></div>
    <div class="allocation-total"><strong>${money(plan.total_cost)}</strong><span>${plan.items.length} customers selected</span></div>
    ${actionCounts.map(([k, n]) => `<div class="action-row"><span>${ACTIONS[k].label}</span><span class="action-count">${n}</span></div>`).join("")}
    <div class="key-value"><span>Unallocated budget</span><strong>${money(plan.remaining_budget)}</strong></div>
    <div class="callout">Service reviews use up to 30% of capacity (rounded down, minimum one). Remaining slots use budget-feasible offers ranked by marginal assumed benefit per rupiah.</div>
   </section>
   <section class="panel"><div class="panel-heading"><h2>Score distribution</h2><small>${cs.length} customers</small></div>
    <div class="distribution">${counts.map((n, i) => `<div class="distribution-row"><span>${i * 20}–${(i + 1) * 20}%</span><span class="distribution-track"><i style="width:${(n / cs.length) * 100}%"></i></span><strong>${n}</strong></div>`).join("")}</div>
    <p class="table-note">Internal historical validation only. No out-of-time validation is available.</p>
   </section>
  </aside>
 </div>`
  );
}
function customers() {
  return (
    header(
      "CUSTOMER EXPLORER",
      "Customer explorer",
      "Inspect the evidence available at the decision date, model contributions, and actions that need review.",
    ) +
    banner() +
    `<section class="panel"><div class="toolbar"><input id="customer-search" type="search" placeholder="Search customer ID or region…" aria-label="Search customers" value="${esc(search)}"><select id="risk-filter" aria-label="Filter risk band"><option value="all">All risk bands</option><option value="High">High risk</option><option value="Medium">Medium risk</option><option value="Low">Low risk</option></select></div><div id="customer-table"></div></section>`
  );
}
function updateCustomers() {
  const cs = data.intelligence.customers
    .filter(
      (c) =>
        (filter === "all" || c.risk_band === filter) &&
        `${c.customer_id} ${c.region}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.risk_score - a.risk_score);
  page = Math.min(page, Math.max(0, Math.ceil(cs.length / 12) - 1));
  $("#customer-table").innerHTML = cs.length
    ? table(cs.slice(page * 12, page * 12 + 12)) +
      `<div class="pagination"><span>${page * 12 + 1}–${Math.min(cs.length, page * 12 + 12)} of ${cs.length} customers</span><div><button class="secondary" id="prev-page" ${page === 0 ? "disabled" : ""}>←</button> <button class="secondary" id="next-page" ${(page + 1) * 12 >= cs.length ? "disabled" : ""}>→</button></div></div>`
    : `<div class="empty-state">No customers match this filter.</div>`;
}
function controls() {
  return `<section class="panel controls"><h2>Campaign settings</h2><div class="control-block"><label for="budget">Campaign budget</label><div class="control-value" id="budget-label">${money(config.budget)}</div><input id="budget" type="range" min="0" max="10000000" step="50000" value="${config.budget}"><div class="range-ends"><span>Rp 0</span><span>Rp 10m</span></div></div><div class="control-block"><label for="capacity">Maximum customers</label><div class="control-value" id="capacity-label">${config.maxCustomers} customers</div><input id="capacity" type="range" min="1" max="20" value="${config.maxCustomers}"><div class="range-ends"><span>1</span><span>20</span></div></div><div class="control-block"><label class="check-label"><input type="checkbox" id="technical" ${config.prioritizeTechnical ? "checked" : ""}>Prioritize technical reviews over billing reviews</label></div><details><summary>Economic assumptions</summary><div class="control-block"><label for="value">Retained customer value (Rp)</label><input class="input" id="value" type="number" min="0" max="12000000" step="100000" value="${config.retainedValue}"></div><div class="control-block"><label for="basic-success">Basic prevention assumption (%)</label><input class="input" id="basic-success" type="number" min="0" max="100" value="${config.basicSuccess * 100}"></div><div class="control-block"><label for="premium-success">Premium prevention assumption (%)</label><input class="input" id="premium-success" type="number" min="0" max="100" value="${config.premiumSuccess * 100}"></div><p class="muted" style="font-size:10px">Conditional prevention among would-be churners, not observed uplift. Basic costs Rp150k; premium Rp450k. Review costs are illustrative: technical Rp50k, billing Rp25k.</p></details><button class="primary" id="deterministic">Generate policy plan</button><div class="callout">The policy planner considers all 208 customers. The agent investigates a shortlist of up to 30. Both reserve up to 30% of capacity for service reviews (rounded down, minimum one).</div></section>`;
}
function agent() {
  return (
    header(
      "AGENT WORKSPACE",
      "Agent workspace",
      "Set the campaign constraints and request a proposal. Review the tool trace before approving a simulation.",
    ) +
    banner() +
    `<div class="planner-grid">${controls()}<div><section class="panel"><div class="agent-intro"><div><h2>Retention planning request</h2><p>${data.agent_available ? "DeepSeek connected · five bounded tools" : "Live AI unavailable · policy planner ready"} · no external actions</p></div></div><textarea class="prompt-box" id="agent-prompt" maxlength="1500" aria-label="Retention objective">${esc(prompt)}</textarea><div class="suggestions"><button class="suggestion" data-prompt="Build a retention plan within the configured budget. Investigate technical contacts first, and explain who should not receive an incentive.">Prioritize service reviews</button><button class="suggestion" data-prompt="Investigate high-risk customers with billing contacts. Compare allowed actions and submit a plan within the configured budget.">Review billing contacts</button></div><div class="prompt-bottom"><small>Controls on the left set the budget and capacity.<br>Proposal only. Consent remains unverified.</small><button class="primary" id="run-agent" ${!data.agent_available || busy ? "disabled" : ""}>Run agent</button></div><div id="agent-progress"></div><div id="agent-error"></div></section><div id="plan-result" class="plan-space"></div><section class="panel plan-space"><div class="panel-heading"><div><h2>Session history</h2><p>Persisted for this browser session; outcomes are simulated.</p></div><button class="quiet" id="refresh-history">Refresh</button></div><div id="history"><div class="empty-state">Loading history…</div></div></section></div></div>`
  );
}
function planHTML(plan, trace = []) {
  if (!plan)
    return `<section class="panel"><div class="empty-state">No proposal generated.<br>Run the agent or generate a deterministic policy plan.</div></div></section>`;
  const pending = plan.status === "pending_review";
  return `<section class="panel"><div class="panel-heading"><div><h2>${plan.agent_model ? "Agent proposal" : "Policy proposal"}</h2><p>Version ${esc(plan.policy_version)} · ${esc(plan.id?.slice(0, 8) || "preview")}<br>Saved budget: ${money(plan.settings.budget)} · Capacity: ${plan.settings.maxCustomers}</p></div><span class="badge ${pending ? "pending" : ""}">${esc(plan.status.replaceAll("_", " "))}</span></div>${plan.rationale ? `<p class="rationale">${esc(plan.rationale)}</p>` : ""}<div class="plan-summary"><div><small>Proposed spend</small><strong>${compact(plan.total_cost)}</strong></div><div><small>Scenario net benefit</small><strong>${compact(plan.scenario_net_benefit)}</strong></div><div><small>Customers</small><strong>${plan.items.length} / ${plan.settings.maxCustomers}</strong></div></div><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Action</th><th>Cost</th><th>Assumed net benefit</th></tr></thead><tbody>${plan.items.map((i) => `<tr><td><button class="customer-button" data-customer="${esc(i.customer_id)}">${esc(i.customer_id)}</button></td><td>${esc(i.label)}</td><td>${money(i.cost)}</td><td>${i.scenario_net_benefit === null ? "Unmeasured" : money(i.scenario_net_benefit)}</td></tr>`).join("")}</tbody></table></div>${!plan.items.length ? '<p class="empty-state">No feasible positive-benefit offers or affordable service reviews under these constraints.</p>' : ""}<div class="callout">${esc(plan.economic_note)} Remaining budget: ${money(plan.remaining_budget)}.<br>${esc(plan.methodology)}</div><details class="trace"><summary>${plan.skipped.length} candidates not selected</summary><div style="max-height:200px;overflow:auto">${plan.skipped.map((c) => `<div class="signal"><span>${esc(c.customer_id)}</span><span>${esc(c.reason)}</span></div>`).join("")}</div></details>${trace.length ? `<details class="trace" open><summary>Agent tool trace · ${trace.length} calls</summary>${trace.map((t) => `<div class="trace-step"><span class="badge">${t.step.toString().padStart(2, "0")}</span> <code>${esc(t.tool)}</code> <span class="muted">${esc(t.status)}</span><details><summary>Inspect inputs and result</summary><pre>${esc(JSON.stringify({ input: t.input, result: t.result }, null, 2))}</pre></details></div>`).join("")}</details>` : ""}${pending ? `<div class="review-box"><strong>Review before simulated execution</strong><p>Verify active status, consent, contact limits, issue resolution and offer eligibility in a real workflow. These fields are unknown in the supplied data.</p><label class="check-label"><input type="checkbox" id="review-ack">I understand these checks remain unverified. Approval records a simulation only.</label><div class="review-buttons"><button class="primary" id="approve-plan">Approve simulation</button><button class="secondary" id="reject-plan">Reject proposal</button></div></div>` : `<div class="callout">${plan.status === "simulated_approved" ? "Approved in the sandbox. No customers were contacted and no incentives were issued." : "Proposal rejected. No actions were executed."}</div>`}${plan.status === "simulated_approved" && plan.items.length ? `<div class="review-box"><strong>Record a simulated outcome</strong><p>Demonstrates the feedback contract. These records are marked synthetic and excluded from model training.</p><div class="toolbar"><select id="outcome-customer" aria-label="Outcome customer">${plan.items.map((i) => `<option>${esc(i.customer_id)}</option>`).join("")}</select><select id="outcome-value" aria-label="Simulated outcome"><option value="retained">Retained</option><option value="churned">Churned</option><option value="no_response">No response</option></select><button class="secondary" id="record-outcome">Record</button></div></div>` : ""}<div style="margin-top:18px"><button class="quiet" id="export-plan">Download proposal JSON</button></div></section>`;
}
function evidence() {
  const r = data.report,
    m = r.evaluation.logistic_regression,
    a = r.audit;
  return (
    header(
      "EVIDENCE & MODEL",
      "Evidence and model evaluation",
      "The analytical choices behind the workbench, including what this dataset cannot establish.",
      "",
    ) +
    `<div class="metric-grid">${metric("Source customers", a.customers, "145 recorded churn events across the extract")}${metric("Decision cohort", r.cohort.n, `${r.cohort.churn} churn events during November`)}${metric("Holdout average precision", m.pr_auc.toFixed(3), `Bootstrap 95%: ${m.pr_auc_bootstrap_95pct.map((v) => v.toFixed(3)).join("–")}`)}${metric("Holdout lift · top 20%", m.lift_at_20pct.toFixed(2) + "×", "52 test customers · 10 positive labels", true)}</div><div class="evidence-grid"><section class="panel"><h2>Point-in-time cohort definition</h2><ol class="number-list"><li><span>October usage is assumed available on 1 November. Exclude customers who already churned before the decision date.</span></li><li><span>Count support contacts strictly before the snapshot. Resolution status has no historical timestamp, so it is excluded.</span></li><li><span>Label churn during [1 November, 1 December). Registry completeness through 30 November is an explicit assumption.</span></li><li><span>Split customers 75/25 within the same cohort. Fit preprocessing only on training rows. No tuning on the holdout.</span></li><li><span>Generate demo scores using five-fold out-of-fold logistic regression. Never expose actual churn labels to the agent.</span></li></ol></section><section class="panel"><h2>Data quality findings</h2>${[
      ["One usage row only", a.one_usage_row],
      ["Two usage rows", a.two_usage_rows],
      ["Usage in the churn month", a.usage_in_churn_month],
      ["Support after churn", a.support_after_churn],
      ["Blank total charges", a.blank_total_charges],
      ["Customers without usage", a.missing_usage],
    ]
      .map(
        ([k, v]) =>
          `<div class="key-value"><span>${k}</span><strong>${v}</strong></div>`,
      )
      .join(
        "",
      )}<div class="callout">Early snapshots are almost all positive. A standard chronological split would confound time with extract selection. December snapshots have no observed future labels.</div></section><section class="panel"><h2>Holdout model comparison</h2><img src="/assets/model_comparison.png" alt="Holdout average precision comparison for logistic regression, shallow tree, business rule and prevalence"><p>Logistic regression was pre-selected for interpretability. The tree is a fixed comparator. Ties in top-k metrics use expected random selection within the tied group.</p><div class="callout">${r.sensitivity.exact_feature_overlap_test_rows} holdout rows share exact feature values with training rows. Excluding these leaves ${r.sensitivity.nonoverlap_holdout.n} test customers and ${r.sensitivity.nonoverlap_holdout.positives} events; average precision ${r.sensitivity.nonoverlap_holdout.pr_auc.toFixed(3)}. This is a post-evaluation diagnostic.</div></section><section class="panel"><h2>Calibration and probability error</h2><img src="/assets/calibration.png" alt="Out-of-fold score calibration across five equal-sized groups"><p>Holdout Brier score: ${m.brier.toFixed(3)}. Calibration is descriptive on a small selected cohort. A probability estimate is not a treatment-effect estimate.</p></section></div><section class="panel"><h2>Observation coverage is not uniform</h2><div class="table-wrap"><table><thead><tr><th>Available at</th><th>Active customers</th><th>Next-month churn</th><th>Non-churn</th><th>Outcome window</th></tr></thead><tbody>${a.coverage.map((c) => `<tr><td>${c.snapshot}</td><td>${c.customers}</td><td>${c.churn ?? "—"}</td><td>${c.non_churn ?? "—"}</td><td>${c.label_observed ? "Assumed complete" : "Unobserved / censored"}</td></tr>`).join("")}</tbody></table></div></section><div class="evidence-grid plan-space"><section class="panel"><h2>Economic decision contract</h2><p><strong>Net benefit = risk × assumed prevention × retained value − cost.</strong></p><p>“Success” is interpreted as preventing churn among customers who would otherwise churn. The supplied 20% and 50% rates do not prove incremental uplift. Retained value is assumed to be contribution-equivalent; if it is revenue, replace it with margin-adjusted value.</p><p>Up to 30% of customer capacity is reserved for service reviews (rounded down, minimum one). Their benefits are unmeasured, and their assumed costs are subtracted from the plan’s scenario net total. The offer allocation is greedy and budget-feasible, not guaranteed globally optimal.</p></section><section class="panel"><h2>Limitations</h2><ul>${r.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section><section class="panel"><h2>What the agent can do</h2><p>Read a bounded shortlist, inspect evidence, compare allowed actions, calculate a feasible plan and submit it for review. Tool calls and decisions are recorded.</p><p>The backend owns arithmetic, constraints and approval transitions. Unknown consent blocks real execution. The demo has no messaging or incentive-issuance tool.</p></section><section class="panel"><h2>Experiment and monitoring plan</h2><p><strong>Experiment:</strong> randomized no-contact control versus eligible actions, stratified by risk. Measure incremental retained margin, complaints and opt-outs with a predeclared outcome window.</p><p><strong>Monitor:</strong> coverage and missingness; delayed PR-AUC and calibration; subgroup treatment/error rates; budget violations, rejected tool calls, API errors, latency, and human overrides.</p><p>Retrain only with observed, mature production outcomes. Sandbox feedback is explicitly excluded.</p></section></div><section class="panel"><h2>Subgroup audit · exploratory</h2><p class="muted">Gender and age do not enter the model. Removing them does not eliminate proxy discrimination. Small groups do not support fairness certification.</p><div class="table-wrap"><table><thead><tr><th>Dimension</th><th>Group</th><th>Customers</th><th>Churn events</th><th>Observed rate</th><th>Mean OOF score</th></tr></thead><tbody>${r.subgroups.map((g) => `<tr><td>${esc(g.dimension)}</td><td>${esc(g.group)}</td><td>${g.n}</td><td>${g.positive_count}</td><td>${pct(g.observed_rate)}</td><td>${pct(g.mean_score)}</td></tr>`).join("")}</tbody></table></div></section>`
  );
}

function render() {
  const titles = {
    overview: "Overview",
    customers: "Customer explorer",
    agent: "Agent workspace",
    evidence: "Evidence & model",
  };
  $("#breadcrumb").textContent = titles[tab];
  document.querySelectorAll(".nav-button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#main").innerHTML = { overview, customers, agent, evidence }[tab]();
  if (tab === "customers") {
    $("#risk-filter").value = filter;
    updateCustomers();
  }
  if (tab === "agent") {
    $("#plan-result").innerHTML = planHTML(
      activePlan,
      agentResult?.trace ?? activePlan?.agent_trace ?? [],
    );
    history();
  }
}
function navigate(next) {
  if (!["overview", "customers", "agent", "evidence"].includes(next)) return;
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
              `<div class="history-row"><div><button class="customer-button" data-plan="${p.id}">${p.id.slice(0, 8)}</button><br><small>${new Date(p.created_at).toLocaleString()} · ${p.items.length} customers · ${money(p.total_cost)}</small></div><span class="badge">${esc(p.status.replaceAll("_", " "))}</span></div>`,
          )
          .join("") +
        `<div class="table-note">${h.events.length} audit events recorded. ${h.events.filter((e) => e.kind === "simulated_outcome").length} simulated outcomes.</div>`
      : '<div class="empty-state">No reviewed or saved plans yet.</div>';
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
    .querySelectorAll(
      "[data-plan],#approve-plan,#reject-plan,#record-outcome,.suggestion",
    )
    .forEach((el) => (el.disabled = value));
  for (const id of ["run-agent", "deterministic"])
    if ($("#" + id))
      $("#" + id).disabled =
        value || (id === "run-agent" && !data.agent_available);
  $("#agent-prompt").disabled = value;
  document
    .querySelectorAll(".controls input")
    .forEach((el) => (el.disabled = value));
}
async function createPlan(useAgent) {
  readControls();
  prompt = $("#agent-prompt").value;
  setBusy(true);
  $("#agent-error").innerHTML = "";
  let seconds = 0;
  const progress = () => {
    $("#agent-progress").innerHTML =
      `<div class="running"><span class="spinner"></span>${useAgent ? "Agent is gathering evidence and calling tools" : "Calculating policy plan"}… ${seconds}s</div>`;
  };
  progress();
  const timer = setInterval(() => {
    seconds++;
    progress();
  }, 1000);
  try {
    const result = await api(
      useAgent ? "agent" : "plan",
      useAgent ? { prompt, settings: config } : { settings: config },
    );
    if (useAgent) {
      agentResult = result;
      activePlan = result.plan;
      if (!activePlan)
        $("#agent-error").innerHTML =
          `<div class="callout">${esc(result.answer)}</div>`;
    } else {
      activePlan = result;
      agentResult = null;
    }
    $("#plan-result").innerHTML = planHTML(
      activePlan,
      agentResult?.trace ?? [],
    );
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
  $("#customer-detail").innerHTML =
    `<span class="eyebrow">CUSTOMER INTELLIGENCE / 01 NOV 2025</span><h2>${esc(id)}</h2><p class="muted">${esc(c.region)} · ${esc(c.features.contractType)} · ${c.history_months_at_snapshot} observed usage month(s)</p><div class="plan-summary"><div><small>OOF risk estimate</small><strong>${pct(c.risk_score)}</strong></div><div><small>Tenure</small><strong>${c.features.tenureMonths} mo.</strong></div><div><small>Monthly charge</small><strong>${compact(c.features.monthlyCharges)}</strong></div></div><div class="detail-grid"><div><div class="mini-title">Observed evidence</div>${c.evidence.map((e) => `<p>${esc(e)}</p>`).join("")}<div class="mini-title">Unknown at decision time</div><p>Consent, live account status, contact frequency, offer eligibility, and current resolution status.</p><div class="callout">Partial history. Model v1 · OOF fold ${c.fold}. No actual outcome is available to the agent.</div></div><div><div class="mini-title">Model contributions</div>${c.model_signals.map((s) => `<div class="signal"><code>${esc(s.feature)}</code><span>${s.contribution_log_odds > 0 ? "+" : ""}${s.contribution_log_odds.toFixed(2)}</span></div>`).join("")}<p class="muted" style="font-size:10px;margin-top:12px">Signed contributions to model log-odds. These explain the prediction, not the cause of churn. Numeric features are standardized; contributions are relative to the model intercept.</p></div></div><div class="mini-title">Action comparison · current assumptions</div><div class="table-wrap"><table><thead><tr><th>Action</th><th>Cost</th><th>Scenario net</th><th>Proposal status</th></tr></thead><tbody>${actions.map((a) => `<tr><td>${esc(a.label)}</td><td>${money(a.cost)}</td><td>${a.scenario_net_benefit === null ? "Unmeasured" : money(a.scenario_net_benefit)}</td><td>${a.action === "no_action" ? "No outreach" : a.eligible_for_proposal ? "Review required" : "Not eligible"}</td></tr>`).join("")}</tbody></table></div>`;
  $("#customer-dialog").showModal();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button,a");
  if (!b) return;
  if (
    busy &&
    (b.dataset.plan ||
      b.dataset.prompt ||
      ["approve-plan", "reject-plan", "record-outcome"].includes(b.id))
  ) {
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
    $("#plan-result").innerHTML = planHTML(
      activePlan,
      activePlan.agent_trace ?? [],
    );
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
      toast("Acknowledge the simulation checklist first.");
      return;
    }
    try {
      activePlan = await api("review", {
        id: activePlan.id,
        action: b.id === "approve-plan" ? "approve" : "reject",
        acknowledged: true,
      });
      $("#plan-result").innerHTML = planHTML(
        activePlan,
        agentResult?.trace ?? activePlan.agent_trace ?? [],
      );
      await history();
      toast("Review recorded. No external actions executed.");
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
    const blob = new Blob([JSON.stringify(activePlan, null, 2)], {
        type: "application/json",
      }),
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
  if (e.target.id === "budget")
    $("#budget-label").textContent = money(Number(e.target.value));
  if (e.target.id === "capacity")
    $("#capacity-label").textContent = e.target.value + " customers";
  if (e.target.id === "agent-prompt") prompt = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "risk-filter") {
    filter = e.target.value;
    page = 0;
    updateCustomers();
  }
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (next !== tab) navigate(next);
});
try {
  data = await api("bootstrap");
  tab = ["overview", "customers", "agent", "evidence"].includes(
    location.hash.slice(1),
  )
    ? location.hash.slice(1)
    : "overview";
  render();
} catch (e) {
  $("#main").innerHTML =
    `<div class="error">Unable to load the workbench: ${esc(e.message)}. Please refresh.</div>`;
}
