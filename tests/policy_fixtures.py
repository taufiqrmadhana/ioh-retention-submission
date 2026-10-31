"""Shared policy fixtures for the Python and JavaScript test suites.

`tests/fixtures/policy_cases.json` is the contract between retention/policy.py
and web/policy.js: both suites load it and must reproduce every expectation.
Regenerate it only when the policy changes on purpose:

    uv run python -m tests.policy_fixtures
"""

import json
from copy import deepcopy
from pathlib import Path

from retention.policy import build_plan, compare_actions

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "policy_cases.json"


def customer(identifier, risk, technical=0, billing=0, **fields):
    return {
        "customer_id": identifier,
        "risk_score": risk,
        "consent": "unknown",
        "eligibility": "review_required",
        "features": {"technical_30d": technical, "billing_30d": billing},
        **fields,
    }


SYNTHETIC = [customer(f"C{i:02}", round(0.9 - i * 0.03, 4)) for i in range(14)] + [
    customer("TIE-A", 0.5),
    customer("TIE-B", 0.5),
    customer("T1", 0.95, technical=1),
    customer("T2", 0.3, technical=2, billing=1),
    customer("B1", 0.85, billing=1),
    customer("B2", 0.6, billing=3),
    customer("DENIED", 0.99, consent="denied"),
    customer("INELIGIBLE", 0.98, eligibility="ineligible"),
    customer("LOW", 0.01),
    customer("TLOW", 0.05, technical=1),
    customer("BLOW", 0.12, billing=2),
    # Calibrated risks: one isotonic block (ties) ordered by the raw score.
    customer("CAL-A", 0.97, calibrated_risk=0.95),
    customer("CAL-B", 0.93, calibrated_risk=0.95),
    customer("CAL-C", 0.96, calibrated_risk=0.95),
    customer("CAL-LOW", 0.6, calibrated_risk=0.01, billing=1),
]

PLANS = [
    ("defaults", "synthetic", {}),
    ("reserved_reviews", "synthetic", {"review_share": 0.3}),
    ("exact_reallocation", "intelligence", {"budget": 600_000, "max_customers": 3, "review_share": 0.3}),
    ("tight_budget", "synthetic", {"budget": 149_999, "max_customers": 5}),
    ("one_slot", "synthetic", {"budget": 3_000_000, "max_customers": 1}),
    ("calibrated_ties", "synthetic", {"budget": 1_350_000, "max_customers": 3}),
    ("billing_first", "synthetic", {"prioritize_technical": False, "max_customers": 20}),
    ("generous", "synthetic", {"budget": 10_000_000, "max_customers": 20}),
    ("no_prevention", "synthetic", {"basic_success": 0, "premium_success": 0}),
    ("low_value", "synthetic", {"retained_value": 500_000, "budget": 5_000_000}),
    ("app_defaults", "intelligence", {}),
    ("app_big", "intelligence", {"budget": 10_000_000, "max_customers": 20}),
    ("app_breakeven", "intelligence", {"basic_success": 0.029, "premium_success": 0.0726}),
    ("app_billing_first", "intelligence", {"prioritize_technical": False, "budget": 1_500_000}),
    ("app_offers_only", "intelligence", {"review_share": 0}),
    ("app_wide_reservation", "intelligence", {"review_share": 0.5, "max_customers": 12}),
    ("one_slot_offers_only", "synthetic", {"budget": 3_000_000, "max_customers": 1, "review_share": 0}),
]

# Rounding half toward +infinity: gross 1.5 - cost 150000 = -149998.5 -> -149998.
COMPARE = [
    ("half_tie", customer("HALF", 0.5), {"retained_value": 3, "basic_success": 1, "premium_success": 1}),
    ("reference", customer("REF", 0.4), {}),
    ("technical", customer("TECH", 0.7, technical=1), {}),
    ("billing_and_technical", customer("BOTH", 0.7, technical=1, billing=1), {}),
    ("denied", customer("NO", 0.7, consent="denied"), {}),
    ("review_below_floor", customer("TL", 0.05, technical=1), {}),
    ("review_at_floor", customer("BF", 0.125, billing=1), {}),
    ("no_offer_can_pay", customer("NP", 0.9, technical=1), {"basic_success": 0, "premium_success": 0}),
    ("calibrated_prices", customer("CP", 0.99, calibrated_risk=0.4), {}),
    ("calibrated_below_floor", customer("CF", 0.5, calibrated_risk=0.1, technical=1), {}),
]

# Forged plans that both validators must reject.
MUTATIONS = [
    {"name": "prevented_missing", "path": ["scenario_prevented_churn"], "op": "delete"},
    {"name": "prevented_nan", "path": ["scenario_prevented_churn"], "op": "nan"},
    {"name": "prevented_shifted", "path": ["scenario_prevented_churn"], "op": "add", "value": 0.01},
    {"name": "net_benefit_shifted", "path": ["scenario_net_benefit"], "op": "add", "value": 1},
    {"name": "net_benefit_missing", "path": ["scenario_net_benefit"], "op": "delete"},
    {"name": "total_cost_missing", "path": ["total_cost"], "op": "delete"},
    {"name": "remaining_budget_shifted", "path": ["remaining_budget"], "op": "add", "value": 1},
    {"name": "settings_missing", "path": ["settings"], "op": "delete"},
    {"name": "item_cost_zero", "path": ["items", 0, "cost"], "op": "set", "value": 0},
    {"name": "item_executable", "path": ["items", 0, "executable"], "op": "set", "value": True},
    {"name": "item_review_flag", "path": ["items", 0, "review_required"], "op": "set", "value": False},
    {"name": "item_unknown_customer", "path": ["items", 0, "customer_id"], "op": "set", "value": "GHOST"},
    # In the reserved plan items[0] is a service review and items[-1] an offer.
    {"name": "review_prevented_missing", "path": ["items", 0, "scenario_prevented_churn"], "op": "delete"},
    {"name": "review_net_missing", "path": ["items", 0, "scenario_net_benefit"], "op": "delete"},
    {"name": "offer_prevented_nan", "path": ["items", -1, "scenario_prevented_churn"], "op": "nan"},
    {"name": "offer_net_shifted", "path": ["items", -1, "scenario_net_benefit"], "op": "add", "value": 1},
    {"name": "item_no_action", "path": ["items", 0, "action"], "op": "set", "value": "no_action"},
]


def intelligence():
    return json.loads((ROOT / "outputs" / "intelligence.json").read_text())["customers"]


def population(name):
    return SYNTHETIC if name == "synthetic" else intelligence()


def summary(plan):
    return {
        "items": [
            [i["customer_id"], i["action"], i["cost"], i["scenario_net_benefit"]]
            for i in plan["items"]
        ],
        "total_cost": plan["total_cost"],
        "remaining_budget": plan["remaining_budget"],
        "scenario_net_benefit": plan["scenario_net_benefit"],
        "scenario_prevented_churn": plan["scenario_prevented_churn"],
    }


def mutate(plan, mutation):
    """Apply one fixture mutation to a deep copy of a plan."""
    forged = deepcopy(plan)
    *parents, last = mutation["path"]
    target = forged
    for key in parents:
        target = target[key]
    if mutation["op"] == "delete":
        del target[last]
    elif mutation["op"] == "nan":
        target[last] = float("nan")
    elif mutation["op"] == "add":
        target[last] += mutation["value"]
    else:
        target[last] = mutation["value"]
    return forged


def generate():
    return {
        "note": "Generated by tests/policy_fixtures.py; both test suites must reproduce it.",
        "synthetic_customers": SYNTHETIC,
        "plans": [
            {
                "name": name,
                "customers": source,
                "settings": settings,
                "expected": summary(build_plan(population(source), settings)),
            }
            for name, source, settings in PLANS
        ],
        "compare": [
            {
                "name": name,
                "customer": c,
                "settings": settings,
                "expected": [
                    [a["action"], a["eligible_for_proposal"], a["scenario_net_benefit"]]
                    for a in compare_actions(c, settings)
                ],
            }
            for name, c, settings in COMPARE
        ],
        "mutations": {"plan": "reserved_reviews", "cases": MUTATIONS},
    }


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(generate(), indent=1) + "\n")
    print(f"Wrote {FIXTURE.relative_to(ROOT)}")
