import pytest

from retention import decisions, policy


def customer(identifier="A", risk=0.8, technical=0, billing=0):
    return {
        "customer_id": identifier,
        "risk_score": risk,
        "consent": "unknown",
        "features": {"technical_30d": technical, "billing_30d": billing},
    }


COHORT = [customer(f"C{i:02}", risk=0.99 - i * 0.02) for i in range(12)] + [
    customer("T1", technical=1),
    customer("B1", billing=1),
]
BASE = {"budget": 3_000_000, "max_customers": 10}


def test_decision_curve_matches_hand_calculation():
    rows = decisions.decision_curve([1, 0], [0.9, 0.1], thresholds=[0.5])
    assert rows[0]["model"] == pytest.approx(0.5)
    assert rows[0]["treat_all"] == pytest.approx(0.0)
    assert rows[0]["treated"] == 1


def test_treat_all_declines_as_threshold_rises():
    rows = decisions.decision_curve([1, 0, 1, 0], [0.7, 0.6, 0.4, 0.3])
    treat_all = [r["treat_all"] for r in rows]
    assert treat_all == sorted(treat_all, reverse=True)
    assert all(r["treat_none"] == 0 for r in rows)


def test_sensitivity_is_monotone_in_assumed_success():
    curve = decisions.sensitivity_curve(COHORT, BASE)
    for retained in curve["retained_values"]:
        series = sorted(
            (r for r in curve["rows"] if r["retained_value"] == retained),
            key=lambda r: r["success_multiplier"],
        )
        benefits = [r["net_benefit"] for r in series]
        assert benefits == sorted(benefits)
    assert curve["baseline"]["success_multiplier"] == 1.0


def test_sensitivity_reports_a_breakeven_below_baseline():
    curve = decisions.sensitivity_curve(COHORT, BASE)
    breakeven = curve["breakeven_multiplier"]
    assert breakeven is not None
    assert 0 < breakeven < 1


def net_at(multiplier):
    config = policy.settings(BASE)
    return decisions._replan(COHORT, config, multiplier, config["retained_value"])[
        "scenario_net_benefit"
    ]


def test_breakeven_is_where_the_replanned_plan_actually_turns_positive():
    """Interpolating between grid points misplaces it when the plan's mix changes."""
    breakeven = decisions.sensitivity_curve(COHORT, BASE)["breakeven_multiplier"]
    assert net_at(breakeven) > 0
    assert net_at(breakeven - 0.001) <= 0


def test_algorithm_gap_holds_the_policy_reviews_fixed():
    gap = decisions.optimisation_gap(COHORT, BASE)
    assert gap["reviews_in_plan"] == 2
    assert gap["exact_same_reviews_net_benefit"] >= gap["greedy_net_benefit"]
    assert gap["algorithm_gap_pct"] >= 0
    # Dropping the reviews frees budget and slots, so offers-only is never worse.
    assert gap["exact_offers_only_net_benefit"] >= gap["exact_same_reviews_net_benefit"]
    assert gap["review_reservation_cost"] == pytest.approx(
        gap["exact_offers_only_net_benefit"] - gap["exact_same_reviews_net_benefit"]
    )
    assert gap["exact_offers_only_customers"] <= BASE["max_customers"]
    # The reviews must retain enough extra customers to repay the value they displace.
    hurdle = gap["review_hurdle"]
    assert hurdle["extra_retained_customers"] * 6_000_000 == pytest.approx(gap["review_reservation_cost"], abs=1)
    assert hurdle["per_review_retention_points"] == pytest.approx(
        hurdle["extra_retained_customers"] / gap["reviews_in_plan"] * 100, abs=0.01
    )


def test_strategies_share_budget_capacity_and_eligibility():
    labels = {c["customer_id"]: 1 for c in COHORT}
    result = decisions.strategy_comparison(COHORT, BASE, labels)
    for row in result["rows"]:
        assert row["cost"] <= BASE["budget"]
        assert row["customers"] <= BASE["max_customers"]
        assert row["blocked_by_policy"] == 0
    unchecked = result["uncapped_threshold_rule"]["without_policy_checks"]
    checked = result["uncapped_threshold_rule"]["with_policy_checks"]
    assert unchecked["blocked_by_policy"] == 2  # T1 and B1 have recent contacts
    assert unchecked["customers"] - checked["customers"] == 2


def test_plan_impact_without_calibration_changes_nothing():
    impact = decisions.plan_impact(COHORT, BASE)
    assert impact["raw"] == impact["calibrated"]
    assert impact["same_customer_actions"] == impact["raw"]["customers"]


def test_plan_impact_prices_with_calibrated_risk():
    calibrated = [{**c, "calibrated_risk": 0.05} for c in COHORT]
    impact = decisions.plan_impact(calibrated, BASE)
    assert impact["above_breakeven_calibrated"] == 0
    assert impact["calibrated"]["customers"] == 0  # nobody is worth an offer or a review


def test_plan_impact_reprices_with_cross_fitted_risks():
    held = {c["customer_id"]: 0.05 for c in COHORT}
    impact = decisions.plan_impact(COHORT, BASE, cross_fitted=held)
    nested = impact["cross_fitted"]
    assert nested["customers"] == 0  # nobody clears the break-even under the held-out risks
    assert nested["same_customers_as_calibrated"] == 0
    assert nested["gate_flips"] == len(COHORT)
    same = decisions.plan_impact(COHORT, BASE, cross_fitted={c["customer_id"]: c["risk_score"] for c in COHORT})
    assert same["cross_fitted"]["same_customer_actions_as_calibrated"] == same["calibrated"]["customers"]
    assert same["cross_fitted"]["gate_flips"] == 0


def test_premium_stress_crossings_are_real():
    stress = decisions.premium_stress(COHORT, BASE)
    cut = stress["policy_beats_basic_above"]
    assert cut is not None and 0 < cut < 0.5
    config = policy.settings(BASE)

    def gap(premium):
        c = {**config, "premium_success": premium}
        plan = policy.build_plan(COHORT, c)["scenario_net_benefit"]
        basic = sum(a["scenario_net_benefit"] for a in decisions._offer_by_risk(COHORT, c, "basic_offer"))
        return plan - basic

    assert gap(cut) > 0 and gap(cut - 0.002) <= 0
    assert [r["premium_success"] for r in stress["rows"]] == sorted(r["premium_success"] for r in stress["rows"])


def test_pilot_sample_size_matches_the_textbook_formula():
    # 50% vs 40%, alpha 0.05 two-sided, 80% power: 388 per arm.
    assert decisions.pilot_sample_size(0.5, 0.4) == {"control": 388, "treatment": 388, "total": 776}
    unequal = decisions.pilot_sample_size(0.5, 0.4, control_share=0.1)
    assert unequal["total"] > 776 and unequal["control"] < unequal["treatment"]
    with pytest.raises(ValueError):
        decisions.pilot_sample_size(0.5, 0.5)


def test_pilot_effect_is_the_premium_breakeven():
    labels = {c["customer_id"]: 0 for c in COHORT}
    design = decisions.pilot_design(COHORT, labels, BASE)
    assert design["premium_breakeven_absolute_reduction"] == pytest.approx(450_000 / 6_000_000)
    assert design["population_in_cohort"] == 12  # T1 and B1 are not offer-eligible


def test_targeting_diagnostic_segments_the_highest_risk():
    diagnostic = decisions.targeting_diagnostic(COHORT, BASE)
    assert diagnostic["top_capacity"]["n"] == BASE["max_customers"]
    assert diagnostic["top_capacity"]["mean_risk"] >= diagnostic["cohort"]["mean_risk"]
    assert 0 <= diagnostic["cohort"]["share_with_recent_service_contact"] <= 1


def test_offers_only_row_prices_the_review_reservation():
    labels = {c["customer_id"]: 1 for c in COHORT}
    rows = {r["strategy"]: r for r in decisions.strategy_comparison(COHORT, BASE, labels)["rows"]}
    offers_only, shipped = rows["offers_only"], rows["policy_plan"]
    assert set(offers_only["actions"]) <= {"basic_offer", "premium_offer"}
    assert {"technical_review", "billing_review"} & set(shipped["actions"])
    gap = decisions.optimisation_gap(COHORT, BASE)
    assert offers_only["scenario_net_benefit"] == pytest.approx(gap["exact_offers_only_net_benefit"])
    # The gap to the shipped plan splits into the reservation's price and the greedy shortfall.
    assert offers_only["scenario_net_benefit"] - shipped["scenario_net_benefit"] == pytest.approx(
        gap["review_reservation_cost"] + gap["algorithm_gap_absolute"]
    )


def test_pilot_sizes_each_offer_and_bridges_the_horizon():
    labels = {c["customer_id"]: 1 for c in COHORT}
    design = decisions.pilot_design(COHORT, labels, BASE)
    arms = design["offer_arms"]
    assert arms["basic_offer"]["breakeven_absolute_reduction"] == pytest.approx(0.025)
    assert arms["premium_offer"]["breakeven_absolute_reduction"] == pytest.approx(0.075)
    assert arms["basic_offer"]["per_arm"] > arms["premium_offer"]["per_arm"]
    two_arm = next(r for r in design["rows"] if r["baseline_90d_churn"] == 0.5 and r["effect"] == "premium_breakeven")
    assert arms["premium_offer"]["per_arm"] > two_arm["split_50_50"]["control"]  # stricter alpha
    assert "30-day" in design["horizon_bridge"] and "control arm" in design["horizon_bridge"]


def test_pilot_separates_detection_from_profitability():
    # 50% vs 42.5% at about 700 per arm: positive, but the interval reaches below 7.5 points.
    low, high = decisions.difference_interval(0.5, 0.425, 700)
    assert low == pytest.approx(0.023, abs=0.001) and high == pytest.approx(0.127, abs=0.001)
    # Clearing the 7.5-point margin with 80% power needs a true effect well above it.
    assert decisions.pilot_margin_sample_size(0.5, 0.35, 0.075) == 667
    with pytest.raises(ValueError):
        decisions.pilot_margin_sample_size(0.5, 0.425, 0.075)
    labels = {c["customer_id"]: 1 for c in COHORT}
    design = decisions.pilot_design(COHORT, labels, BASE)
    low, high = design["interval_at_breakeven_effect"]["interval_95pct"]
    assert 0 < low < design["premium_breakeven_absolute_reduction"] < high
    mix = design["plan_offer_mix"]
    assert mix["breakeven_absolute_reduction"] <= design["premium_breakeven_absolute_reduction"]
    assert mix["average_offer_cost"] == pytest.approx(mix["breakeven_absolute_reduction"] * 6_000_000, abs=300)
    assert design["name"] == "offer-policy pilot"
