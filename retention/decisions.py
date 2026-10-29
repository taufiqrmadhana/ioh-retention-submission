"""Diagnostics for the decision layer: sensitivity, exact-allocation gap, targeting.

These are reported next to the shipped policy, never used to change it silently.
"""

from __future__ import annotations

from math import ceil, sqrt

import numpy as np
import scipy.sparse as sparse
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.stats import norm

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


def _replan(customers, config, multiplier, retained):
    return policy.build_plan(
        customers,
        {
            **config,
            "retained_value": retained,
            "basic_success": min(1.0, config["basic_success"] * multiplier),
            "premium_success": min(1.0, config["premium_success"] * multiplier),
        },
    )


def sensitivity_curve(customers, base=None):
    """Re-plan the policy across assumed success rates and retained values."""
    config = policy.settings(base)
    rows = []
    for retained in RETAINED:
        for multiplier in MULTIPLIERS:
            plan = _replan(customers, config, multiplier, retained)
            rows.append(
                {
                    "retained_value": retained,
                    "success_multiplier": multiplier,
                    "basic_success": round(min(1.0, config["basic_success"] * multiplier), 3),
                    "premium_success": round(min(1.0, config["premium_success"] * multiplier), 3),
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
    breakeven = _breakeven(customers, config, rows, config["retained_value"])
    return {
        "multipliers": list(MULTIPLIERS),
        "retained_values": list(RETAINED),
        "rows": rows,
        "baseline": baseline,
        "breakeven_multiplier": breakeven,
        "breakeven_success": None
        if breakeven is None
        else {
            "basic": round(config["basic_success"] * breakeven, 4),
            "premium": round(config["premium_success"] * breakeven, 4),
        },
        "note": (
            "Each point re-plans under identical constraints. Break-even is the smallest "
            "multiplier at which the re-planned net benefit turns positive, found by bisection "
            "on the plan itself: plan composition changes between grid points, so a straight "
            "line between them would misplace it. Below it the same spend destroys assumed value."
        ),
    }


def _breakeven(customers, config, rows, retained, tolerance=1e-5):
    """Bisect the first sign change of re-planned net benefit along the multiplier grid."""
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
            return None  # already positive at the lowest multiplier on the grid
        low, high = previous["success_multiplier"], row["success_multiplier"]
        while high - low > tolerance:
            middle = (low + high) / 2
            if _replan(customers, config, middle, retained)["scenario_net_benefit"] > 0:
                high = middle
            else:
                low = middle
        # Round up so the reported multiplier is on the positive side of the crossing.
        return ceil(high * 10_000) / 10_000
    return None


def _best_offers(customers, config, budget, capacity, exclude=()):
    """Exact best offer allocation (at most one offer each) under a budget and head count."""
    options = []
    for customer in customers:
        if customer["customer_id"] in exclude:
            continue
        for action in policy.compare_actions(customer, config):
            if action["eligible_for_proposal"] and action["action"] in OFFERS:
                options.append(
                    (customer["customer_id"], float(action["cost"]), float(action["scenario_net_benefit"]))
                )
    if not options or budget <= 0 or capacity <= 0:
        return {"value": 0.0, "customers": 0, "solved": True, "message": ""}
    ids = sorted({o[0] for o in options})
    row = {cid: i for i, cid in enumerate(ids)}
    count = len(options)
    costs = np.array([o[1] for o in options])
    values = np.array([o[2] for o in options])
    per_customer = sparse.csr_matrix(
        (np.ones(count), ([row[o[0]] for o in options], list(range(count)))),
        shape=(len(ids), count),
    )
    matrix = sparse.vstack(
        [per_customer, sparse.csr_matrix(costs.reshape(1, -1)), sparse.csr_matrix(np.ones((1, count)))]
    )
    lower = np.zeros(len(ids) + 2)
    upper = np.concatenate([np.ones(len(ids)), [float(budget), float(capacity)]])
    result = milp(
        c=-values,
        constraints=LinearConstraint(matrix, lower, upper),
        integrality=np.ones(count),
        bounds=Bounds(np.zeros(count), np.ones(count)),
    )
    if not result.success:
        return {"value": None, "customers": None, "solved": False, "message": str(result.message)}
    return {
        "value": float(-result.fun),
        "customers": int(np.round(result.x).sum()),
        "solved": True,
        "message": "",
    }


def optimisation_gap(customers, base=None):
    """Split what the greedy plan leaves behind into an algorithm gap and a policy choice.

    Algorithm gap: exact optimum with the policy's own service reviews held fixed, so
    only the offer allocation can differ. Reservation cost: an offers-only optimum
    versus that, i.e. the scenario value the review reservation gives up by design.
    """
    config = policy.settings(base)
    greedy = policy.build_plan(customers, config)
    greedy_net = float(greedy["scenario_net_benefit"])
    reviews = [i for i in greedy["items"] if i["action"] not in OFFERS]
    review_cost = sum(i["cost"] for i in reviews)
    same = _best_offers(
        customers,
        config,
        config["budget"] - review_cost,
        config["max_customers"] - len(reviews),
        exclude={i["customer_id"] for i in reviews},
    )
    free = _best_offers(customers, config, config["budget"], config["max_customers"])
    if not (same["solved"] and free["solved"]):
        return {
            "greedy_net_benefit": greedy_net,
            "note": f"Exact allocation not solved: {same['message'] or free['message']}",
        }
    exact_same = same["value"] - review_cost
    gap = exact_same - greedy_net
    return {
        "greedy_net_benefit": round(greedy_net, 2),
        "reviews_in_plan": len(reviews),
        "review_cost": review_cost,
        "exact_same_reviews_net_benefit": round(exact_same, 2),
        "algorithm_gap_absolute": round(gap, 2),
        "algorithm_gap_pct": round(gap / abs(greedy_net) * 100, 2) if greedy_net else None,
        "exact_offers_only_net_benefit": round(free["value"], 2),
        "exact_offers_only_customers": free["customers"],
        "review_reservation_cost": round(free["value"] - exact_same, 2),
        "note": (
            "Algorithm gap compares the greedy offer allocation with the exact optimum under the same "
            "budget, capacity and the same service reviews. Reservation cost is the scenario value an "
            "offers-only optimum would add by dropping those reviews; reviews have unmeasured benefit, "
            "so this is the price of a business rule, not a weakness of the allocator."
        ),
    }


def _summary(items, labels=None, blocked=0):
    counts = {}
    for item in items:
        counts[item["action"]] = counts.get(item["action"], 0) + 1
    return {
        "customers": len(items),
        "actions": counts,
        "cost": sum(i["cost"] for i in items),
        "expected_saves": round(sum(i["scenario_prevented_churn"] or 0 for i in items), 2),
        "scenario_net_benefit": sum(
            i["cost"] * -1 if i["scenario_net_benefit"] is None else i["scenario_net_benefit"]
            for i in items
        ),
        "churners_reached": None
        if labels is None
        else int(sum(labels[i["customer_id"]] for i in items)),
        "blocked_by_policy": blocked,
    }


def _blocked(customer):
    return customer.get("consent") == "denied" or customer.get("eligibility") == "ineligible"


def _offer_by_risk(customers, config, action):
    """One offer type down the risk ranking, eligible customers only, within budget and capacity."""
    chosen, spent = [], 0
    for customer in sorted(customers, key=lambda c: (-c["risk_score"], c["customer_id"])):
        if len(chosen) >= config["max_customers"]:
            break
        offer = next(a for a in policy.compare_actions(customer, config) if a["action"] == action)
        if (
            offer["eligible_for_proposal"]
            and offer["scenario_net_benefit"] > 0
            and spent + offer["cost"] <= config["budget"]
        ):
            spent += offer["cost"]
            chosen.append({"customer_id": customer["customer_id"], **offer})
    return chosen


def _threshold_rule(customers, config, respect_checks):
    """Best positive offer for every customer, no budget or capacity cap."""
    chosen, blocked = [], 0
    for customer in customers:
        if _blocked(customer):
            continue
        offers = [a for a in policy.compare_actions(customer, config) if a["action"] in OFFERS]
        if respect_checks:
            offers = [a for a in offers if a["eligible_for_proposal"]]
        best = max(offers, key=lambda a: a["scenario_net_benefit"], default=None)
        if best and best["scenario_net_benefit"] > 0:
            blocked += not best["eligible_for_proposal"]
            chosen.append({"customer_id": customer["customer_id"], **best})
    return chosen, blocked


def strategy_comparison(customers, base=None, labels=None):
    """Strategies under one budget, one capacity and the same eligibility rules.

    `churners_reached` uses retrospective November labels and is reported for
    context only; expected saves use risk x assumed success, never labels.
    The uncapped threshold rule is listed separately because it ignores the
    budget and capacity; its unchecked variant is not allowed by the policy.
    """
    config = policy.settings(base)
    plan = policy.build_plan(customers, config)
    checked, _ = _threshold_rule(customers, config, respect_checks=True)
    unchecked, blocked = _threshold_rule(customers, config, respect_checks=False)
    blocked_ids = {
        i["customer_id"] for i in unchecked if not i["eligible_for_proposal"]
    }
    return {
        "settings": {"budget": config["budget"], "max_customers": config["max_customers"]},
        "rows": [
            {"strategy": "policy_plan", "label": "Policy plan: reviews first, then offers", **_summary(plan["items"], labels)},
            {"strategy": "premium_by_risk", "label": "Premium offer to the highest risk", **_summary(_offer_by_risk(customers, config, "premium_offer"), labels)},
            {"strategy": "basic_by_risk", "label": "Basic offer to the highest risk", **_summary(_offer_by_risk(customers, config, "basic_offer"), labels)},
        ],
        "uncapped_threshold_rule": {
            "with_policy_checks": _summary(checked, labels),
            "without_policy_checks": {
                **_summary(unchecked, labels, blocked),
                "blocked_churners": None
                if labels is None
                else int(sum(labels[c] for c in blocked_ids)),
            },
        },
        "note": (
            "Rows share the budget, capacity and eligibility rules of the shipped plan. The uncapped threshold "
            "rule gives every customer their best positive offer with no budget; without the policy checks it "
            "would send offers to customers whose recent service or billing contact must be reviewed first."
        ),
    }


def _offer_breakeven(config):
    """Lowest risk at which the basic offer has positive scenario net benefit."""
    scale = config["basic_success"] * config["retained_value"]
    return policy.ACTIONS["basic_offer"]["cost"] / scale if scale else None


def plan_impact(customers, scores, base=None, labels=None):
    """How a plan changes if the same policy runs on alternative scores (e.g. calibrated)."""
    config = policy.settings(base)
    swapped = [{**c, "risk_score": float(scores[c["customer_id"]])} for c in customers]
    raw, alt = policy.build_plan(customers, config), policy.build_plan(swapped, config)
    threshold = _offer_breakeven(config)

    def picked(plan):
        return {(i["customer_id"], i["action"]) for i in plan["items"]}

    return {
        "raw": _summary(raw["items"], labels),
        "alternative": _summary(alt["items"], labels),
        "same_customers": len({i["customer_id"] for i in raw["items"]} & {i["customer_id"] for i in alt["items"]}),
        "same_customer_actions": len(picked(raw) & picked(alt)),
        "offer_breakeven_risk": threshold,
        "above_breakeven_raw": None if threshold is None else sum(c["risk_score"] >= threshold for c in customers),
        "above_breakeven_alternative": None if threshold is None else sum(c["risk_score"] >= threshold for c in swapped),
        "note": "Each plan's net benefit is valued with its own scores; compare actions and churners reached, not only the totals.",
    }


def pilot_sample_size(p_control, p_treatment, alpha=0.05, power=0.8, control_share=0.5):
    """Two-proportion sample size (normal approximation) with any control share."""
    if not 0 < control_share < 1 or p_control == p_treatment:
        raise ValueError("Need a control share in (0, 1) and a non-zero effect")
    kc, kt = control_share, 1 - control_share
    pooled = kc * p_control + kt * p_treatment
    z_alpha, z_power = norm.ppf(1 - alpha / 2), norm.ppf(power)
    total = (
        z_alpha * sqrt(pooled * (1 - pooled) * (1 / kc + 1 / kt))
        + z_power * sqrt(p_control * (1 - p_control) / kc + p_treatment * (1 - p_treatment) / kt)
    ) ** 2 / (p_control - p_treatment) ** 2
    control, treatment = ceil(total * kc), ceil(total * kt)
    return {"control": control, "treatment": treatment, "total": control + treatment}


def pilot_design(customers, labels, base=None, baselines=(0.3, 0.5)):
    """Size one pilot: who is randomised, over what horizon, against which effect.

    Population: customers the policy could offer to (no recent service/billing contact,
    not blocked) whose risk clears the basic-offer break-even. Primary outcome: 90-day
    churn. Smallest effect worth detecting: the absolute churn reduction at which a
    premium offer pays for itself, cost / retained value, whatever the baseline.
    """
    config = policy.settings(base)
    threshold = _offer_breakeven(config)
    population = [
        c
        for c in customers
        if threshold is not None
        and c["risk_score"] >= threshold
        and next(a for a in policy.compare_actions(c, config) if a["action"] == "premium_offer")["eligible_for_proposal"]
    ]
    observed = sum(labels[c["customer_id"]] for c in population) / len(population) if population else None
    breakeven = policy.ACTIONS["premium_offer"]["cost"] / config["retained_value"]
    rows = []
    for baseline in baselines:
        for effect_name, effect in (
            ("premium_breakeven", breakeven),
            ("brief_assumption", baseline * config["premium_success"]),
        ):
            rows.append(
                {
                    "baseline_90d_churn": baseline,
                    "effect": effect_name,
                    "absolute_reduction": round(effect, 4),
                    "split_50_50": pilot_sample_size(baseline, baseline - effect),
                    "split_90_10": pilot_sample_size(baseline, baseline - effect, control_share=0.1),
                }
            )
    return {
        "population": "Offer-eligible customers (no recent service/billing contact, not blocked) with risk at or above the basic-offer break-even.",
        "offer_breakeven_risk": threshold,
        "population_in_cohort": len(population),
        "population_share_of_cohort": round(len(population) / len(customers), 4),
        "observed_30d_churn_in_population": observed,
        "horizon": "90-day",
        "premium_breakeven_absolute_reduction": breakeven,
        "rows": rows,
        "note": (
            "The 30-day rate is retrospective, measured on out-of-fold scores in an outcome-selected cohort, "
            "so 90-day baselines are planning values to replace with the live population's rate. For a fixed "
            "absolute effect the required sample is largest near 50% churn, so sizing at 0.5 is conservative."
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
