"""Python side of the shared policy contract; tests/js/policy.test.js is the JS side."""

import json

import pytest

from retention.policy import build_plan, compare_actions, validate_plan
from tests.policy_fixtures import FIXTURE, intelligence, mutate, summary

CASES = json.loads(FIXTURE.read_text())


def customers(source):
    return CASES["synthetic_customers"] if source == "synthetic" else intelligence()


@pytest.mark.parametrize("case", CASES["plans"], ids=lambda c: c["name"])
def test_plan_matches_shared_fixture(case):
    plan = build_plan(customers(case["customers"]), case["settings"])
    actual = summary(plan)
    expected = case["expected"]
    assert actual["items"] == expected["items"]
    for key in ("total_cost", "remaining_budget", "scenario_net_benefit"):
        assert actual[key] == expected[key]
    assert actual["scenario_prevented_churn"] == pytest.approx(
        expected["scenario_prevented_churn"], abs=1e-9
    )


@pytest.mark.parametrize("case", CASES["compare"], ids=lambda c: c["name"])
def test_action_comparison_matches_shared_fixture(case):
    actions = compare_actions(case["customer"], case["settings"])
    assert [
        [a["action"], a["eligible_for_proposal"], a["scenario_net_benefit"]] for a in actions
    ] == case["expected"]


@pytest.mark.parametrize("mutation", CASES["mutations"]["cases"], ids=lambda m: m["name"])
def test_forged_plans_are_rejected(mutation):
    source = next(p for p in CASES["plans"] if p["name"] == CASES["mutations"]["plan"])
    population = customers(source["customers"])
    plan = build_plan(population, source["settings"])
    assert validate_plan(plan, population)
    with pytest.raises(ValueError):
        validate_plan(mutate(plan, mutation), population)
