import { ACTIONS, DEFAULTS, buildPlan, compareActions, settings } from "../web/policy.js";
import { PAGES, SITE_GUIDE } from "./guide.js";

// A small question-answering assistant for the workbench. It reads the same
// report and customer intelligence as the UI, runs what-if plans through the
// policy, and can never save, approve or execute anything.

const MAX_ROUNDS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_HISTORY = 10;
const MAX_MESSAGE = 2000;

const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;
const rp = (n) => `Rp${Math.round(n).toLocaleString("en-US")}`;

const tool = (name, description, properties, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});
export const TOOLS = [
  tool(
    "find_customers",
    "List customers by out-of-fold risk, highest first, optionally filtered by risk band, region or recent support contact.",
    {
      band: { type: "string", enum: ["any", "High", "Medium", "Low"] },
      region: { type: "string", description: "City name such as Bandung, or 'any'" },
      contact: { type: "string", enum: ["any", "technical", "billing", "none"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
  ),
  tool(
    "get_customer",
    "Read one customer's features, evidence, top model contributions and the action comparison under the default assumptions.",
    { customer_id: { type: "string", description: "For example IOH-430" } },
    ["customer_id"],
  ),
  tool(
    "simulate_plan",
    "Run the retention-v1 policy on all 208 customers with the given budget and assumptions. Returns spend, scenario net benefit and the selected actions. Nothing is saved or executed.",
    {
      budget: { type: "integer", minimum: 0, maximum: 10000000, description: "Campaign budget in rupiah" },
      max_customers: { type: "integer", minimum: 1, maximum: 20 },
      retained_value: { type: "integer", minimum: 0, maximum: 12000000, description: "Value of one retained customer in rupiah" },
      basic_success: { type: "number", minimum: 0, maximum: 1, description: "Share of would-be churners a basic offer keeps" },
      premium_success: { type: "number", minimum: 0, maximum: 1 },
      prioritize_technical: { type: "boolean" },
    },
  ),
];
const SCHEMAS = Object.fromEntries(TOOLS.map((t) => [t.function.name, t.function.parameters]));

function checkArguments(name, args) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error("Unknown tool");
  if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("Tool arguments must be an object");
  for (const key of Object.keys(args))
    if (!schema.properties[key]) throw new Error(`Unexpected argument ${key}`);
  for (const key of schema.required)
    if (!(key in args)) throw new Error(`Missing argument ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key];
    const ok =
      spec.type === "string"
        ? typeof value === "string" && value.length <= 60 && (!spec.enum || spec.enum.includes(value))
        : spec.type === "integer"
          ? Number.isInteger(value) && value >= spec.minimum && value <= spec.maximum
          : spec.type === "number"
            ? typeof value === "number" && Number.isFinite(value) && value >= spec.minimum && value <= spec.maximum
            : typeof value === "boolean";
    if (!ok) throw new Error(`Invalid ${key}`);
  }
}

export function projectBrief(report) {
  const m = report.evaluation.logistic_regression,
    tree = report.evaluation.shallow_tree,
    rule = report.evaluation.business_rule,
    a = report.audit,
    oof = report.oof,
    eco = report.economics;
  const regions = report.subgroups
    .filter((g) => g.dimension === "region")
    .map((g) => `${g.group} ${g.n} customers, ${g.positive_count} churned (${pct(g.observed_rate)}), recall@20% ${g.recall_at_20pct == null ? "n/a" : g.recall_at_20pct.toFixed(2)}`)
    .join("; ");
  const calibration = report.calibration
    .map((c, i) => `Q${i + 1} ${pct(c.mean_score)}→${pct(c.observed_rate)}`)
    .join(", ");
  const costs = Object.values(ACTIONS)
    .map((x) => `${x.label} ${rp(x.cost)}`)
    .join(", ");
  return [
    `Decision date ${report.snapshot}; churn label = churn date from 1 to 30 Nov 2025.`,
    `Source files: ${a.customers} customers (${a.churn_records} with a churn date), ${a.usage_rows} monthly usage rows (${a.one_usage_row} customers have one row), ${a.support_rows} support contacts. Data issues: two date formats parsed, region typos mapped, ${a.blank_total_charges} blank totalCharges left missing, ${a.support_after_churn} contacts after churn ignored, resolution status excluded (no date).`,
    `Decision cohort: ${report.cohort.n} customers active on 1 Nov 2025 with October usage; ${report.cohort.churn} churned in November (${pct(report.cohort.prevalence)}). Train/holdout split ${report.cohort.train}/${report.cohort.test}, seed ${report.seed}.`,
    "Model: logistic regression (C=0.3) on 9 inputs known before the snapshot: tenureMonths, monthlyCharges, dataUsageGB, support/technical/billing contacts in the prior 30 days, contractType, paymentMethod, hasInternetService. Gender, age, partner and dependents are excluded. Demo scores are five-fold out-of-fold.",
    `Holdout (n=${m.n}, ${m.positives} churners): PR-AUC ${m.pr_auc.toFixed(3)} (bootstrap 95% ${m.pr_auc_bootstrap_95pct.map((v) => v.toFixed(2)).join("–")}), ROC-AUC ${m.roc_auc.toFixed(3)}, Brier ${m.brier.toFixed(3)}, precision@20% ${m.precision_at_20pct.toFixed(3)}, recall@20% ${m.recall_at_20pct.toFixed(3)}, lift@20% ${m.lift_at_20pct.toFixed(2)}x. Comparators: shallow tree PR-AUC ${tree.pr_auc.toFixed(3)}, business rule (month-to-month, tenure<6, technical contact) ${rule.pr_auc.toFixed(3)}, prevalence ${report.evaluation.constant_prevalence.pr_auc.toFixed(3)}.`,
    `Out-of-fold on all ${oof.n}: PR-AUC ${oof.pr_auc.toFixed(3)}, recall in the top 20% of scores ${pct(oof.recall_at_20pct, 0)}. ${report.sensitivity.exact_feature_overlap_test_rows} holdout rows share exact features with training rows; without them PR-AUC ${report.sensitivity.nonoverlap_holdout.pr_auc.toFixed(3)}.`,
    `Calibration by out-of-fold quintile (mean score→observed churn): ${calibration}. Ranking is strong; probabilities are not calibrated.`,
    `Regions: ${regions}.`,
    `Policy retention-v1: costs ${costs}. Offers only for customers without a recent service or billing contact; technical review if a technical contact; billing review if billing without technical. Up to 30% of capacity (rounded down, minimum one) goes to service reviews first, then offers by greedy marginal net benefit per rupiah within budget. Net benefit = risk × success rate × retained value − cost. Defaults: budget ${rp(DEFAULTS.budget)}, ${DEFAULTS.maxCustomers} customers, retained value ${rp(DEFAULTS.retainedValue)}, basic success ${pct(DEFAULTS.basicSuccess, 0)}, premium success ${pct(DEFAULTS.premiumSuccess, 0)}. Success rates come from the brief, not from tests.`,
    `Economics: break-even at ${eco.sensitivity.breakeven_multiplier ?? "n/a"}x the assumed success rates; an exact allocation reaches ${rp(eco.optimisation.exact_net_benefit)} against ${rp(eco.optimisation.greedy_net_benefit)} for the greedy plan (${eco.optimisation.gap_pct}% gap).`,
    "Workflow: the LLM agent drafts a plan with five bounded tools; code recomputes costs and eligibility; a person approves; approval records a simulation only. Consent, contact limits and eligibility are unknown in the data.",
    `Limitations: ${report.limitations.join(" ")}`,
  ].join("\n");
}

function systemPrompt(report, page) {
  return `You are the Retention assistant inside a retrospective telco churn workbench (IOH data scientist take-home). You are also its guide: you explain what each page shows, how to read its numbers and charts, and how to complete tasks in it.
Answer only questions about this workbench: how to use and read it, its data, cohort, churn model and evaluation, the retention policy and economics, the agent workflow, individual customers, and budget simulations. For anything else, say in one sentence that you only cover this workbench.
Use the guide, the facts and the tools below. Never invent numbers, customers, pages, buttons or results. For any what-if about budget, capacity, retained value or success rates, call simulate_plan and quote its numbers. To discuss a customer, call get_customer. Simulations are scenario economics on assumed success rates, not measured uplift; nothing is saved or executed and no customer is contacted. Scores are retrospective out-of-fold estimates, not causes of churn.
For "how do I" questions give short numbered steps that name the exact buttons. To explain a chart, say what the axes are, what a good result looks like, and what this chart shows here.
Link a page as [Agent workspace](#agent) and a panel as [Campaign settings](#agent/Campaign settings), using only the page ids overview, customers, agent, evidence and the exact quoted panel titles in the guide. Links take the user there and highlight the panel; add one or two where they help.
Reply in the user's language (Indonesian or English). Keep it short: at most about 120 words, or about 180 for a page tour or step-by-step guide, unless asked for detail. Use plain sentences, "- " bullets or "1. " steps, **bold** for key numbers. Write rupiah like Rp3.000.000 or Rp3M and customer IDs exactly, for example IOH-430.
${page ? `The user is currently on the ${PAGES[page]} page; "this page" means it.` : ""}

Workbench guide:
${SITE_GUIDE}

Project facts:
${projectBrief(report)}`;
}

function summarisePlan(plan) {
  const count = (k) => plan.items.filter((i) => i.action === k).length;
  return {
    settings: plan.settings,
    customers: plan.items.length,
    actions: Object.fromEntries(Object.keys(ACTIONS).filter((k) => k !== "no_action").map((k) => [k, count(k)])),
    total_cost: plan.total_cost,
    remaining_budget: plan.remaining_budget,
    scenario_net_benefit: plan.scenario_net_benefit,
    scenario_prevented_churn: Math.round(plan.scenario_prevented_churn * 100) / 100,
    items: plan.items.slice(0, 12).map((i) => ({
      customer_id: i.customer_id,
      action: i.action,
      risk_score: Math.round(i.risk_score * 1000) / 1000,
      cost: i.cost,
      scenario_net_benefit: i.scenario_net_benefit,
    })),
  };
}

export function runTool(name, args, customers) {
  checkArguments(name, args);
  if (name === "find_customers") {
    const region = (args.region ?? "any").trim().toLowerCase();
    const contact = args.contact ?? "any";
    return customers
      .filter((c) => (args.band ?? "any") === "any" || c.risk_band === args.band)
      .filter((c) => region === "any" || c.region.toLowerCase() === region)
      .filter((c) => {
        const t = c.features.technical_30d > 0,
          b = c.features.billing_30d > 0;
        return contact === "any" || (contact === "technical" ? t : contact === "billing" ? b : !t && !b);
      })
      .sort((a, b) => b.risk_score - a.risk_score || a.customer_id.localeCompare(b.customer_id))
      .slice(0, args.limit ?? 10)
      .map((c) => ({
        customer_id: c.customer_id,
        region: c.region,
        risk_score: Math.round(c.risk_score * 1000) / 1000,
        risk_band: c.risk_band,
        contract: c.features.contractType,
        tenure_months: c.features.tenureMonths,
        technical_30d: c.features.technical_30d,
        billing_30d: c.features.billing_30d,
      }));
  }
  if (name === "get_customer") {
    const id = args.customer_id.trim().toUpperCase();
    const c = customers.find((x) => x.customer_id === id);
    if (!c) throw new Error(`No customer ${id} in the 1 Nov cohort`);
    return {
      customer_id: c.customer_id,
      region: c.region,
      risk_score: c.risk_score,
      risk_band: c.risk_band,
      features: c.features,
      evidence: c.evidence,
      model_signals: c.model_signals,
      history_months_at_snapshot: c.history_months_at_snapshot,
      consent: c.consent,
      actions: compareActions(c).map((x) => ({
        action: x.action,
        cost: x.cost,
        scenario_net_benefit: x.scenario_net_benefit,
        eligible_for_proposal: x.eligible_for_proposal,
      })),
    };
  }
  const config = settings({
    ...DEFAULTS,
    ...(args.budget !== undefined && { budget: args.budget }),
    ...(args.max_customers !== undefined && { maxCustomers: args.max_customers }),
    ...(args.retained_value !== undefined && { retainedValue: args.retained_value }),
    ...(args.basic_success !== undefined && { basicSuccess: args.basic_success }),
    ...(args.premium_success !== undefined && { premiumSuccess: args.premium_success }),
    ...(args.prioritize_technical !== undefined && { prioritizeTechnical: args.prioritize_technical }),
  });
  return summarisePlan(buildPlan(customers, config));
}

export function cleanHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("Send at least one message");
  const recent = messages.slice(-MAX_HISTORY);
  for (const m of recent) {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string")
      throw new Error("Messages need a user or assistant role and text");
    if (!m.content.trim() || m.content.length > MAX_MESSAGE)
      throw new Error(`Keep each message between 1 and ${MAX_MESSAGE} characters`);
  }
  if (recent.at(-1).role !== "user") throw new Error("The last message must come from the user");
  return recent.map((m) => ({ role: m.role, content: m.content }));
}

export async function runAssistant({
  messages,
  page = null,
  customers,
  report,
  apiKey,
  model = "deepseek-flash",
  baseUrl = "https://api.deepseek.com",
  fetcher = fetch,
}) {
  const history = cleanHistory(messages);
  const convo = [{ role: "system", content: systemPrompt(report, Object.hasOwn(PAGES, page) ? page : null) }, ...history];
  const trace = [],
    simulations = [];
  let calls = 0,
    tokenUsage = 0,
    last = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetcher(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: convo,
        tools: TOOLS,
        // The last round must answer in text rather than ask for more tools.
        ...(round === MAX_ROUNDS - 1 && { tool_choice: "none" }),
        temperature: 0.2,
        max_tokens: 900,
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Assistant provider request failed (${res.status})`);
    const data = await res.json();
    const usage = data.usage?.total_tokens;
    if (Number.isInteger(usage) && usage >= 0) tokenUsage += usage;
    const msg = data.choices?.[0]?.message;
    if (!msg || typeof msg !== "object") throw new Error("Assistant provider returned no message");
    last = typeof msg.content === "string" ? msg.content : last;
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length || round === MAX_ROUNDS - 1)
      return { answer: last.trim() || "I could not produce an answer. Try rephrasing the question.", simulations, trace, token_usage: tokenUsage, model };
    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call?.function?.name;
      let result;
      if (++calls > MAX_TOOL_CALLS) result = { error: "Tool-call limit reached; answer with what you have." };
      else
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          result = runTool(name, args, customers);
          if (name === "simulate_plan") simulations.push(result);
        } catch (e) {
          result = { error: e.message };
        }
      trace.push({ tool: String(name), status: result?.error ? "rejected" : "completed" });
      convo.push({ role: "tool", tool_call_id: String(call?.id ?? ""), content: JSON.stringify(result) });
    }
  }
  return { answer: last.trim() || "I could not finish within the tool limit.", simulations, trace, token_usage: tokenUsage, model };
}
