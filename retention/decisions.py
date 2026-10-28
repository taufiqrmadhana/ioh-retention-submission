"""Diagnostics for the decision layer: sensitivity, exact-allocation gap, targeting.

These are reported next to the shipped policy, never used to change it silently.
"""

from __future__ import annotations

import numpy as np
import scipy.sparse as sparse
from scipy.optimize import Bounds, LinearConstraint, milp

from retention import policy

MULTIPLIERS = (0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75)
RETAINED = (3_000_000, 6_000_000, 9_000_000, 12_000_000)
OFFERS = ("basic_offer", "premium_offer")


def decision_curve(y, p, thresholds=None):
    """Net benefit of the score versus treat-all and treat-none."""
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    n = len(y)
    prevalence = float(y.mean())
    grid = thresholds or [round(t, 2) for t in np.arange(0.10, 0.955, 0.05)]
    rows = []
    for threshold in grid:
        threshold = float(threshold)
        selected = p >= threshold
        true_positive = float(y[selected].sum())
        false_positive = float(selected.sum()) - true_positive
        weight = threshold / (1 - threshold)
        rows.append(
            {
                "threshold": round(threshold, 2),
                "model": round(true_positive / n - false_positive / n * weight, 4),
                "treat_all": round(prevalence - (1 - prevalence) * weight, 4),
                "treat_none": 0.0,
                "treated": int(selected.sum()),
            }
        )
    return rows


def sensitivity_curve(customers, base=None):
    """Re-plan the policy across assumed success rates and retained values."""
    config = policy.settings(base)
    rows = []
    for retained in RETAINED:
        for multiplier in MULTIPLIERS:
            overrides = {
                **config,
                "retained_value": retained,
                "basic_success": min(1.0, config["basic_success"] * multiplier),
                "premium_success": min(1.0, config["premium_success"] * multiplier),
            }
            plan = policy.build_plan(customers, overrides)
            rows.append(
                {
                    "retained_value": retained,
                    "success_multiplier": multiplier,
                    "basic_success": round(overrides["basic_success"], 3),
                    "premium_success": round(overrides["premium_success"], 3),
                    "net_benefit": plan["scenario_net_benefit"],
                    "cost": plan["total_cost"],
                    "customers": len(plan["items"]),
                }
            )
    baseline = next(
        r
        for r in rows
        if r["success_multiplier"] == 1.0 and r["retained_value"] == config["retained_value"]
    )
    return {
        "multipliers": list(MULTIPLIERS),
        "retained_values": list(RETAINED),
        "rows": rows,
        "baseline": baseline,
        "breakeven_multiplier": _breakeven(rows, config["retained_value"]),
        "note": (
            "Each point re-plans under identical constraints. Break-even is where total "
            "scenario net benefit reaches zero; below it the same spend destroys assumed value."
        ),
    }


def _breakeven(rows, retained):
    series = sorted(
        (r for r in rows if r["retained_value"] == retained),
        key=lambda r: r["success_multiplier"],
    )
    previous = None
    for row in series:
        if row["net_benefit"] <= 0:
            previous = row
            continue
        if previous is None:
            return None
        span = row["net_benefit"] - previous["net_benefit"]
        if span <= 0:
            return row["success_multiplier"]
        fraction = -previous["net_benefit"] / span
        return round(
            previous["success_multiplier"]
            + fraction * (row["success_multiplier"] - previous["success_multiplier"]),
            3,
        )
    return None


def optimisation_gap(customers, base=None):
    """Exact optimum over the same action set and constraints, against the greedy plan."""
    config = policy.settings(base)
    greedy = policy.build_plan(customers, config)
    options = []
    for index, customer in enumerate(customers):
        for action in policy.compare_actions(customer, config):
            if not action["eligible_for_proposal"] or action["action"] == "no_action":
                continue
            value = action["scenario_net_benefit"]
            options.append((index, float(action["cost"]), -float(action["cost"]) if value is None else float(value)))
    if not options:
        return {"greedy_net_benefit": 0, "exact_net_benefit": 0, "gap_pct": None, "note": "No eligible actions."}
    count = len(options)
    costs = np.array([o[1] for o in options])
    values = np.array([o[2] for o in options])
    row_index = [o[0] for o in options]
    per_customer = sparse.csr_matrix(
        (np.ones(count), (row_index, list(range(count)))),
        shape=(len(customers), count),
    )
    matrix = sparse.vstack(
        [per_customer, sparse.csr_matrix(costs.reshape(1, -1)), sparse.csr_matrix(np.ones((1, count)))]
    )
    lower = np.concatenate([np.zeros(len(customers)), [0.0, 0.0]])
    upper = np.concatenate(
        [np.ones(len(customers)), [float(config["budget"]), float(config["max_customers"])]]
    )
    result = milp(
        c=-values,
        constraints=LinearConstraint(matrix, lower, upper),
        integrality=np.ones(count),
        bounds=Bounds(np.zeros(count), np.ones(count)),
    )
    if not result.success:
        return {
            "greedy_net_benefit": greedy["scenario_net_benefit"],
            "exact_net_benefit": None,
            "gap_pct": None,
            "note": f"Exact allocation not solved: {result.message}",
        }
    exact = float(-result.fun)
    greedy_net = float(greedy["scenario_net_benefit"])
    return {
        "greedy_net_benefit": round(greedy_net, 2),
        "exact_net_benefit": round(exact, 2),
        "gap_absolute": round(exact - greedy_net, 2),
        "gap_pct": round((exact - greedy_net) / abs(greedy_net) * 100, 2) if greedy_net else None,
        "exact_customers": int(np.round(result.x).sum()),
        "note": (
            "Exact mixed-integer optimum over the same eligible actions, budget and capacity, "
            "without the 30% service-review reservation. The shipped plan stays greedy and explainable; "
            "this bounds how much value that simplicity costs."
        ),
    }


def targeting_diagnostic(customers, base=None):
    """Cost per assumed save for the highest-risk customers versus the whole cohort."""
    config = policy.settings(base)
    ordered = sorted(customers, key=lambda c: -c["risk_score"])
    premium_cost = policy.ACTIONS["premium_offer"]["cost"]

    def segment(rows):
        if not rows:
            return None
        expected = sum(r["risk_score"] * config["premium_success"] for r in rows)
        with_issue = sum(
            1
            for r in rows
            if r["features"]["technical_30d"] or r["features"]["billing_30d"]
        )
        return {
            "n": len(rows),
            "mean_risk": round(float(np.mean([r["risk_score"] for r in rows])), 4),
            "expected_saves": round(expected, 2),
            "cost_per_expected_save": round(len(rows) * premium_cost / expected) if expected else None,
            "share_with_open_service_issue": round(with_issue / len(rows), 3),
        }

    return {
        "top_capacity": segment(ordered[: config["max_customers"]]),
        "cohort": segment(ordered),
        "note": (
            "Risk x assumed success is a targeting proxy, not measured uplift. The share with an open "
            "service issue marks where a cheaper service fix may dominate a discount; only a randomised "
            "holdout can confirm responsiveness."
        ),
    }


def strategy_comparison(scores, labels, base=None):
    """Blanket offers against the risk-threshold rule, scored on who actually churned.

    Expected saves are success rate x churners contacted: the brief's rates applied to
    observed outcomes, so this is a retrospective scenario, not measured uplift.
    """
    config = policy.settings(base)
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=float)
    value = config["retained_value"]
    basic, premium = policy.ACTIONS["basic_offer"]["cost"], policy.ACTIONS["premium_offer"]["cost"]
    rate_b, rate_p = config["basic_success"], config["premium_success"]
    # Basic pays off once risk x rate x value covers its cost; premium beats basic
    # once the extra prevention covers the extra cost.
    basic_from = basic / (rate_b * value) if rate_b * value else float("inf")
    premium_from = (
        (premium - basic) / ((rate_p - rate_b) * value) if rate_p > rate_b and value else float("inf")
    )

    def row(name, take_basic, take_premium):
        contacted = take_basic | take_premium
        cost = float(take_basic.sum() * basic + take_premium.sum() * premium)
        saved = float(rate_b * labels[take_basic].sum() + rate_p * labels[take_premium].sum())
        return {
            "strategy": name,
            "contacted": int(contacted.sum()),
            "cost": round(cost, 2),
            "expected_saved": round(saved, 2),
            "net_benefit": round(saved * value - cost, 2),
        }

    everyone = np.ones(len(scores), dtype=bool)
    nobody = ~everyone
    targeted_premium = scores >= max(premium_from, basic_from)
    targeted_basic = (scores >= basic_from) & ~targeted_premium
    unflagged = ~(targeted_basic | targeted_premium)
    return {
        "basic_from": round(basic_from, 4),
        "premium_from": round(premium_from, 4),
        "rows": [
            row("Basic to all", everyone, nobody),
            row("Premium to all", nobody, everyone),
            row("Targeted rule", targeted_basic, targeted_premium),
        ],
        "unflagged": {"n": int(unflagged.sum()), "churned": int(labels[unflagged].sum())},
        "note": (
            "Targeted rule uses out-of-fold scores only. Expected saves apply the assumed "
            "success rates to customers who actually churned among those contacted."
        ),
    }
