// JS side of the shared policy contract; tests/test_policy_fixtures.py is the Python side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan, compareActions, validatePlan } from "../../web/policy.js";
import { CASES, customers, jsSettings, mutate, summary } from "./fixtures.js";

for (const c of CASES.plans) {
  test(`plan matches shared fixture: ${c.name}`, () => {
    const actual = summary(buildPlan(customers(c.customers), jsSettings(c.settings)));
    const { scenario_prevented_churn: prevented, ...rest } = c.expected;
    const { scenario_prevented_churn: actualPrevented, ...actualRest } = actual;
    assert.deepEqual(actualRest, rest);
    assert.ok(Math.abs(actualPrevented - prevented) < 1e-9);
  });
}

for (const c of CASES.compare) {
  test(`action comparison matches shared fixture: ${c.name}`, () => {
    const actions = compareActions(c.customer, jsSettings(c.settings));
    assert.deepEqual(
      actions.map((a) => [a.action, a.eligible_for_proposal, a.scenario_net_benefit]),
      c.expected,
    );
  });
}

const source = CASES.plans.find((p) => p.name === CASES.mutations.plan);
const population = customers(source.customers);
const valid = buildPlan(population, jsSettings(source.settings));

test("the unmodified plan validates", () => {
  assert.equal(validatePlan(valid, population), true);
});

for (const m of CASES.mutations.cases) {
  test(`forged plan is rejected: ${m.name}`, () => {
    assert.throws(() => validatePlan(mutate(valid, m), population));
  });
}
