// Loads the shared policy fixtures written by tests/policy_fixtures.py.
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
export const CASES = JSON.parse(
  readFileSync(new URL("tests/fixtures/policy_cases.json", root)),
);
export const INTELLIGENCE = JSON.parse(
  readFileSync(new URL("outputs/intelligence.json", root)),
).customers;

export const customers = (source) =>
  source === "synthetic" ? CASES.synthetic_customers : INTELLIGENCE;

// Python settings use snake_case; web/policy.js uses camelCase.
const KEYS = {
  budget: "budget",
  max_customers: "maxCustomers",
  retained_value: "retainedValue",
  basic_success: "basicSuccess",
  premium_success: "premiumSuccess",
  prioritize_technical: "prioritizeTechnical",
};
export const jsSettings = (settings) =>
  Object.fromEntries(Object.entries(settings).map(([k, v]) => [KEYS[k], v]));

export const summary = (plan) => ({
  items: plan.items.map((i) => [
    i.customer_id,
    i.action,
    i.cost,
    i.scenario_net_benefit,
  ]),
  total_cost: plan.total_cost,
  remaining_budget: plan.remaining_budget,
  scenario_net_benefit: plan.scenario_net_benefit,
  scenario_prevented_churn: plan.scenario_prevented_churn,
});

export function mutate(plan, mutation) {
  const forged = structuredClone(plan);
  const path = [...mutation.path];
  const last = path.pop();
  const pick = (target, key) =>
    Array.isArray(target) && key < 0 ? target.length + key : key;
  let target = forged;
  for (const key of path) target = target[pick(target, key)];
  const key = pick(target, last);
  if (mutation.op === "delete") delete target[key];
  else if (mutation.op === "nan") target[key] = NaN;
  else if (mutation.op === "add") target[key] += mutation.value;
  else target[key] = mutation.value;
  return forged;
}
