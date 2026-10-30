from copy import deepcopy

import pytest

from retention.policy import (
    DEFAULTS,
    build_plan,
    compare_actions,
    review_floor,
    settings,
    validate_plan,
)


def customer(identifier="A", risk=0.8, technical=0, billing=0, **fields):
    return {
        "customer_id": identifier,
        "risk_score": risk,
        "consent": "unknown",
        "features": {"technical_30d": technical, "billing_30d": billing},
        **fields,
    }


CUSTOMERS = [customer(f"C{i:02}", risk=0.9 - i * 0.02) for i in range(12)] + [
    customer("T1", technical=1),
    customer("T2", technical=1),
    customer("B1", billing=1),
]


def test_reference_economics_and_proposal_only():
    actions = {a["action"]: a for a in compare_actions(customer(risk=0.4))}
    assert actions["basic_offer"]["scenario_net_benefit"] == 330_000
    assert actions["premium_offer"]["scenario_net_benefit"] == 750_000
    assert not any(a["executable"] for a in actions.values())


@pytest.mark.parametrize(
    "budget", [0, 25_000, 50_000, 149_999, 150_000, 300_000, 3_000_000]
)
@pytest.mark.parametrize("capacity", [1, 3, 10, 20])
def test_budget_capacity_and_unique_customers(budget, capacity):
    plan = build_plan(CUSTOMERS, {"budget": budget, "max_customers": capacity})
    assert plan["total_cost"] <= budget
    assert len(plan["items"]) <= capacity
    assert len({i["customer_id"] for i in plan["items"]}) == len(plan["items"])
    assert validate_plan(plan, CUSTOMERS)


def test_service_review_precedes_incentives_and_respects_reserve():
    plan = build_plan(CUSTOMERS)
    reviews = [i for i in plan["items"] if i["action"].endswith("_review")]
    assert len(reviews) == 3
    assert all(
        not a["eligible_for_proposal"]
        for a in compare_actions(customer(technical=1))
        if a["action"].endswith("_offer")
    )


def test_reviews_need_risk_above_the_offer_breakeven():
    """A low-risk contact is observed; its review slot goes to an offer instead."""
    assert review_floor() == pytest.approx(0.125)
    low = customer("LOW", risk=0.05, technical=1)
    review = next(a for a in compare_actions(low) if a["action"] == "technical_review")
    assert not review["eligible_for_proposal"]
    assert "break-even" in review["reason"]
    plan = build_plan(CUSTOMERS[:12] + [low], {"max_customers": 3})
    assert {i["action"] for i in plan["items"]} <= {"basic_offer", "premium_offer"}
    assert len(plan["items"]) == 3
    with pytest.raises(ValueError):
        forged = deepcopy(plan)
        forged["items"][0] = {
            "customer_id": "LOW",
            "risk_score": 0.05,
            **review,
        }
        validate_plan(forged, CUSTOMERS[:12] + [low])


def test_calibrated_risk_prices_and_raw_score_breaks_ties():
    high_raw = customer("A", risk=0.99, calibrated_risk=0.9)
    low_raw = customer("B", risk=0.70, calibrated_risk=0.9)
    actions = {a["action"]: a for a in compare_actions(high_raw)}
    assert actions["premium_offer"]["scenario_net_benefit"] == round(0.9 * 0.5 * 6_000_000 - 450_000)
    assert actions["premium_offer"]["scenario_prevented_churn"] == pytest.approx(0.45)
    plan = build_plan([low_raw, high_raw], {"budget": 450_000, "max_customers": 1})
    assert [i["customer_id"] for i in plan["items"]] == ["A"]
    # A raw score above the floor does not earn a review if calibrated risk is below it.
    contact = customer("C", risk=0.6, calibrated_risk=0.01, technical=1)
    assert build_plan([contact])["items"] == []


def test_no_reviews_when_no_offer_can_break_even():
    assert review_floor({"basic_success": 0, "premium_success": 0}) is None
    plan = build_plan(CUSTOMERS, {"basic_success": 0, "premium_success": 0})
    assert plan["items"] == []


@pytest.mark.parametrize(
    "fields", [{"consent": "denied"}, {"eligibility": "ineligible"}]
)
def test_explicit_ineligibility_blocks_actions(fields):
    assert build_plan([customer(**fields)])["items"] == []


def test_zero_prevention_does_not_allocate_unprofitable_offers():
    plan = build_plan(CUSTOMERS, {"basic_success": 0, "premium_success": 0})
    assert all(not i["action"].endswith("_offer") for i in plan["items"])


@pytest.mark.parametrize(
    "overrides",
    [
        {"budget": -1},
        {"budget": True},
        {"budget": float("inf")},
        {"max_customers": 1.5},
        {"basic_success": 2},
        {"prioritize_technical": "yes"},
        {"review_share": -0.1},
        {"review_share": 0.6},
        {"review_share": "0.3"},
    ],
)
def test_invalid_settings(overrides):
    with pytest.raises(ValueError):
        settings(overrides)


def test_forged_economics_flags_and_duplicates_rejected():
    plan = build_plan(CUSTOMERS)
    for field in (
        "remaining_budget",
        "scenario_net_benefit",
        "scenario_prevented_churn",
    ):
        changed = deepcopy(plan)
        changed[field] += 1
        with pytest.raises(ValueError):
            validate_plan(changed, CUSTOMERS)
    for field, value in (("cost", 0), ("executable", True), ("review_required", False)):
        changed = deepcopy(plan)
        changed["items"][0][field] = value
        with pytest.raises(ValueError):
            validate_plan(changed, CUSTOMERS)
    changed = deepcopy(plan)
    changed["settings"]["max_customers"] = 20
    changed["items"].append(changed["items"][0])
    with pytest.raises(ValueError, match="Duplicate"):
        validate_plan(changed, CUSTOMERS)


@pytest.mark.parametrize("share,expected", [(0, 0), (0.1, 1), (0.3, 3), (0.5, 3)])
def test_review_share_sets_the_reservation(share, expected):
    assert DEFAULTS["review_share"] == 0.3
    plan = build_plan(CUSTOMERS, {"review_share": share})
    reviews = [i for i in plan["items"] if not i["action"].endswith("_offer")]
    assert len(reviews) == expected  # only three customers have a recent contact
    assert "business assumptions" in plan["methodology"]
    assert validate_plan(plan, CUSTOMERS)


def test_one_slot_still_reserves_a_review_unless_share_is_zero():
    one = build_plan(CUSTOMERS, {"max_customers": 1})
    assert one["items"][0]["action"].endswith("_review")
    none = build_plan(CUSTOMERS, {"max_customers": 1, "review_share": 0})
    assert none["items"][0]["action"].endswith("_offer")


def test_plan_with_more_reviews_than_its_reservation_is_rejected():
    wide = build_plan(CUSTOMERS, {"review_share": 0.3})
    forged = {**deepcopy(wide), "settings": settings({"review_share": 0.1})}
    with pytest.raises(ValueError, match="reservation"):
        validate_plan(forged, CUSTOMERS)
