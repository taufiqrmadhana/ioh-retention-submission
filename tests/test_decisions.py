import pytest

from retention import decisions


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


def test_exact_allocation_is_never_worse_than_greedy():
    gap = decisions.optimisation_gap(COHORT, BASE)
    assert gap["exact_net_benefit"] >= gap["greedy_net_benefit"]
    assert gap["gap_pct"] >= 0
    assert gap["exact_customers"] <= BASE["max_customers"]


def test_targeting_diagnostic_segments_the_highest_risk():
    diagnostic = decisions.targeting_diagnostic(COHORT, BASE)
    assert diagnostic["top_capacity"]["n"] == BASE["max_customers"]
    assert diagnostic["top_capacity"]["mean_risk"] >= diagnostic["cohort"]["mean_risk"]
    assert 0 <= diagnostic["cohort"]["share_with_open_service_issue"] <= 1


def test_strategy_comparison_matches_hand_calculation():
    scores = [0.05, 0.14, 0.9, 0.9]
    labels = [0, 0, 1, 1]
    result = decisions.strategy_comparison(scores, labels, BASE)
    assert result["basic_from"] == pytest.approx(0.125)
    assert result["premium_from"] == pytest.approx(1 / 6, abs=1e-4)
    rows = {r["strategy"]: r for r in result["rows"]}
    assert rows["Basic to all"]["cost"] == 600_000
    assert rows["Premium to all"]["expected_saved"] == pytest.approx(1.0)
    targeted = rows["Targeted rule"]
    assert targeted["contacted"] == 3
    assert targeted["cost"] == 150_000 + 2 * 450_000
    assert targeted["net_benefit"] == pytest.approx(1.0 * 6_000_000 - 1_050_000)
    assert result["unflagged"] == {"n": 1, "churned": 0}
