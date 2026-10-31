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
    """Check the exact planner against an independent MILP, with reviews held fixed."""
    config = policy.settings(base)
    plan = policy.build_plan(customers, config)
    plan_net = float(plan["scenario_net_benefit"])
    reviews = [i for i in plan["items"] if i["action"] not in OFFERS]
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
            "plan_net_benefit": plan_net,
            "note": f"Exact allocation not solved: {same['message'] or free['message']}",
        }
    exact_same = same["value"] - review_cost
    gap = exact_same - plan_net
    reservation = free["value"] - exact_same
    # Retained customers the reviews must add between them to repay what they displace.
    hurdle = reservation / config["retained_value"] if config["retained_value"] else None
    return {
        "plan_net_benefit": round(plan_net, 2),
        "reviews_in_plan": len(reviews),
        "review_cost": review_cost,
        "exact_same_reviews_net_benefit": round(exact_same, 2),
        "algorithm_gap_absolute": round(gap, 2),
        "algorithm_gap_pct": round(gap / abs(plan_net) * 100, 2) if plan_net else None,
        "exact_offers_only_net_benefit": round(free["value"], 2),
        "exact_offers_only_customers": free["customers"],
        "review_reservation_cost": round(reservation, 2),
        "review_hurdle": None
        if hurdle is None or not reviews
        else {
            "extra_retained_customers": round(hurdle, 4),
            "per_review_retention_points": round(hurdle / len(reviews) * 100, 2),
        },
        "note": (
            "Algorithm gap checks the dynamic-programming plan against an independent MILP under the same "
            "budget, capacity and the same service reviews. Reservation cost is the scenario value an "
            "offers-only optimum would add by dropping those reviews; reviews have unmeasured benefit, "
            "so this is the price of a business rule, not a weakness of the allocator. The review hurdle "
            "is the extra retention the reviews would need, at the assumed retained value, to repay it: "
            "a target for a service test, not evidence that reviews work."
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
        "expected_saves": round(sum(i["scenario_prevented_churn"] or 0 for i in items), 3),
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
            {"strategy": "policy_plan", "label": "Pilot candidate: exact mixed offers", **_summary(plan["items"], labels)},
            {"strategy": "offers_only", "label": "Exact mixed offers, no review slots", **_summary(policy.build_plan(customers, {**config, "review_share": 0})["items"], labels)},
            {"strategy": "review_reservation", "label": "Optional constraint: 30% review slots", **_summary(policy.build_plan(customers, {**config, "review_share": 0.3})["items"], labels)},
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
        "review_share": config["review_share"],
        "note": (
            "Rows share budget, capacity and eligibility rules. The pilot candidate defaults to no review slots; "
            "the 30% review sensitivity shows the scenario price of reserving "
            "slots for reviews whose benefit is unmeasured. The uncapped threshold "
            "rule gives every customer their best positive offer with no budget; without the policy checks it "
            "would send offers to customers whose recent service or billing contact must be reviewed first."
        ),
    }


def _offer_breakeven(config):
    """Lowest risk at which the basic offer has positive scenario net benefit."""
    scale = config["basic_success"] * config["retained_value"]
    return policy.ACTIONS["basic_offer"]["cost"] / scale if scale else None


def plan_impact(customers, base=None, labels=None, cross_fitted=None):
    """Compare primary held-out pricing with raw scores and an exploratory fitted replay."""
    config = policy.settings(base)
    raw_only = [{k: v for k, v in c.items() if k != "calibrated_risk"} for c in customers]
    raw, primary = policy.build_plan(raw_only, config), policy.build_plan(customers, config)
    threshold = _offer_breakeven(config)

    def picked(plan):
        return {(i["customer_id"], i["action"]) for i in plan["items"]}

    def ids(plan):
        return {i["customer_id"] for i in plan["items"]}

    result = {
        "raw": _summary(raw["items"], labels),
        "calibrated": _summary(primary["items"], labels),
        "primary": _summary(primary["items"], labels),
        "same_customers": len(ids(raw) & ids(primary)),
        "same_customer_actions": len(picked(raw) & picked(primary)),
        "offer_breakeven_risk": threshold,
        "above_breakeven_raw": None if threshold is None else sum(c["risk_score"] >= threshold for c in customers),
        "above_breakeven_calibrated": None if threshold is None else sum(policy.decision_risk(c) >= threshold for c in customers),
        "note": "Primary retrospective pricing uses held-out calibration maps. Raw-score and fitted-map totals use different probabilities; compare selection as well as value. All results remain internal to the selected cohort.",
    }
    fitted_available = all("fitted_calibrated_risk" in c for c in customers)
    if cross_fitted or fitted_available:
        reference = customers if cross_fitted else [
            {**c, "calibrated_risk": c["fitted_calibrated_risk"]} for c in customers
        ]
        held = [
            {**c, "calibrated_risk": float(cross_fitted[c["customer_id"]])} for c in customers
        ] if cross_fitted else customers
        reference_plan, held_plan = policy.build_plan(reference, config), policy.build_plan(held, config)
        top = max(policy.decision_risk(c) for c in reference)
        result["fitted_exploratory"] = _summary(reference_plan["items"], labels)
        result["cross_fitted"] = {
            **_summary(held_plan["items"], labels),
            "same_customers_as_fitted": len(ids(reference_plan) & ids(held_plan)),
            "same_customer_actions_as_fitted": len(picked(reference_plan) & picked(held_plan)),
            "same_customers_as_calibrated": len(ids(reference_plan) & ids(held_plan)),
            "same_customer_actions_as_calibrated": len(picked(reference_plan) & picked(held_plan)),
            "gate_flips": None if threshold is None else sum(
                (policy.decision_risk(c) >= threshold) != (policy.decision_risk(h) >= threshold)
                for c, h in zip(reference, held)
            ),
            "customers_at_top_calibrated_risk": sum(policy.decision_risk(c) == top for c in reference),
            "note": (
                "Held-out maps exclude each priced customer's outer fold from model and calibrator fitting. "
                "The all-data fitted map is a future-scoring artifact whose same-cohort replay is exploratory. "
                "Similar aggregate value does not establish stable candidate identities: use the published "
                "raw-score/customer-ID tie-break as an administrative rule, not proof of uniquely optimal people."
            ),
        }
    return result


PREMIUM_GRID = tuple(round(0.2 + 0.025 * i, 3) for i in range(17))


def premium_stress(customers, base=None):
    """Policy plan versus single-offer strategies as the premium success rate falls.

    Basic success, budget and capacity stay fixed. Crossings are found by bisection
    on the re-planned values, like the break-even.
    """
    config = policy.settings(base)

    def values(premium):
        c = {**config, "premium_success": premium}
        return {
            "policy_plan": policy.build_plan(customers, c)["scenario_net_benefit"],
            "premium_by_risk": sum(a["scenario_net_benefit"] for a in _offer_by_risk(customers, c, "premium_offer")),
            "basic_by_risk": sum(a["scenario_net_benefit"] for a in _offer_by_risk(customers, c, "basic_offer")),
        }

    def crossing(first, second, low=0.0, high=1.0, tolerance=1e-5):
        def gap(premium):
            v = values(premium)
            return v[first] - v[second]

        if gap(low) > 0 or gap(high) <= 0:
            return None
        while high - low > tolerance:
            middle = (low + high) / 2
            if gap(middle) > 0:
                high = middle
            else:
                low = middle
        return ceil(high * 10_000) / 10_000

    return {
        "settings": {"budget": config["budget"], "max_customers": config["max_customers"], "basic_success": config["basic_success"]},
        "rows": [{"premium_success": p, **values(p)} for p in PREMIUM_GRID],
        "policy_beats_basic_above": crossing("policy_plan", "basic_by_risk"),
        "premium_beats_basic_above": crossing("premium_by_risk", "basic_by_risk"),
        "note": (
            "The exact mixed-offer plan can match the basic-only plan when premium prevention is too low. "
            "A required review quota can displace offers; review benefit is counted as zero."
        ),
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


def pilot_margin_sample_size(p_control, p_treatment, margin, alpha=0.05, power=0.8):
    """Per-arm size (50/50) for the lower end of the two-sided 1 - alpha interval of the
    churn reduction to clear `margin` with the given power, normal approximation."""
    effect = p_control - p_treatment
    if effect - margin <= 1e-9:
        raise ValueError("The assumed effect must exceed the margin")
    z = norm.ppf(1 - alpha / 2) + norm.ppf(power)
    variance = p_control * (1 - p_control) + p_treatment * (1 - p_treatment)
    return ceil(z**2 * variance / (effect - margin) ** 2)


def difference_interval(p_control, p_treatment, per_arm, alpha=0.05):
    """Approximate two-sided interval for an observed churn reduction at `per_arm` customers per arm."""
    se = sqrt((p_control * (1 - p_control) + p_treatment * (1 - p_treatment)) / per_arm)
    difference, z = p_control - p_treatment, norm.ppf(1 - alpha / 2)
    return [round(float(difference - z * se), 4), round(float(difference + z * se), 4)]


def pilot_design(customers, labels, base=None, baselines=(0.3, 0.5)):
    """Size one offer-policy pilot: who is randomised, over what horizon, against which effect.

    Population: customers the policy could offer to (no recent service/billing contact,
    not blocked) whose risk clears the basic-offer break-even. Customers routed to a
    service review are not in it. Primary outcome: 90-day churn. The profitability
    hurdle is the policy arm's incremental cost per randomised customer divided by the
    retained value; premium for everyone (cost / retained value) is the conservative
    reference used for sizing.
    """
    config = policy.settings(base)
    threshold = _offer_breakeven(config)
    population = [
        c
        for c in customers
        if threshold is not None
        and policy.decision_risk(c) >= threshold
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
    worst = max(baselines)
    planned = next(
        r["split_50_50"]["control"]
        for r in rows
        if r["baseline_90d_churn"] == worst and r["effect"] == "premium_breakeven"
    )
    # Showing that the effect beats break-even, not just zero, needs an effect above it.
    margin_rows = [
        {
            "baseline_90d_churn": baseline,
            "assumed_reduction": round(2 * breakeven, 4),
            "per_arm": pilot_margin_sample_size(baseline, baseline - 2 * breakeven, breakeven),
        }
        for baseline in baselines
    ]
    # The shipped plan's offers, as an example of a cheaper mix than premium for everyone.
    offers = [i for i in policy.build_plan(customers, config)["items"] if i["action"] in OFFERS]
    mix_cost = sum(i["cost"] for i in offers) / len(offers) if offers else None
    # Separating basic from premium needs the action itself randomised: three arms,
    # each offer against business as usual, alpha split over the two contrasts.
    offer_arms = {
        offer: {
            "breakeven_absolute_reduction": round(policy.ACTIONS[offer]["cost"] / config["retained_value"], 4),
            "per_arm": pilot_sample_size(
                worst, worst - policy.ACTIONS[offer]["cost"] / config["retained_value"], alpha=0.025
            )["control"],
        }
        for offer in OFFERS
    }
    return {
        "name": "offer-policy pilot",
        "population": "Offer-eligible customers (no recent service/billing contact, not blocked) with risk at or above the basic-offer break-even.",
        "offer_breakeven_risk": threshold,
        "population_in_cohort": len(population),
        "population_share_of_cohort": round(len(population) / len(customers), 4),
        "observed_30d_churn_in_population": observed,
        "horizon": "90-day",
        "validation_sequence": "Develop the score, calibration and policy through month T; freeze the combined artifacts, then score an untouched complete T+1 cohort and assess mature outcomes. Subsequent refitting requires a new untouched validation cohort.",
        "comparator": "Frozen current retention practice (BAU), including incumbent campaigns, offers, costs, service obligations and suppression rules; use the same comparator in the post-rollout holdout.",
        "attribution": "Hold score source, eligibility, budget and capacity constant when comparing allocation policies. Define experimental additions separately from incumbent actions.",
        "recruitment": {
            "eligible_target": 1400,
            "illustrative_scored_customers": {"10pct_eligible": 14000, "20pct_eligible": 7000, "30pct_eligible": 4667},
            "note": "Arithmetic illustrations, not a forecast from the selected cohort. Measure unique-customer live eligibility and consent, then recompute power with frozen mix, treatment fraction, BAU costs and baseline.",
        },
        "value_definition": "Rp6M is an assumed value per sustained save, with horizon and contribution meaning to be defined by finance. Ninety-day retention alone does not establish that value; report realized incremental margin separately.",
        "horizon_bridge": (
            "The model predicts 30-day churn. Read 30-day churn as a secondary outcome and check the score's "
            "calibration in the control arm only, since the offer changes outcomes in the other arm; the "
            "control arm covers only the offer-eligible part of the score range. 90-day churn is primary so "
            "offers that only delay churn are not counted as saves."
        ),
        "breakeven_definition": (
            "Incremental cost per randomised customer in the policy arm (offers, contact and operating "
            "costs, net of business-as-usual costs) divided by the retained value. Freeze the policy, its "
            "budget and capacity per eligible customer, and compute this before launch."
        ),
        "premium_breakeven_absolute_reduction": breakeven,
        "plan_offer_mix": None
        if mix_cost is None
        else {
            "actions": {a: sum(i["action"] == a for i in offers) for a in OFFERS if any(i["action"] == a for i in offers)},
            "average_offer_cost": round(mix_cost),
            "breakeven_absolute_reduction": round(mix_cost / config["retained_value"], 4),
        },
        "planned_per_arm": planned,
        "interval_at_breakeven_effect": {
            "baseline_90d_churn": worst,
            "observed_reduction": round(breakeven, 4),
            "per_arm": planned,
            "interval_95pct": difference_interval(worst, worst - breakeven, planned),
            "note": (
                "An observed reduction equal to break-even at the planned size is significantly above zero, "
                "but its interval still includes unprofitable effects."
            ),
        },
        "margin_rows": margin_rows,
        "decision_rule": (
            "Ship when the lower end of the 95% interval for incremental net value per randomised customer "
            "(churn reduction x retained value - incremental cost) is above zero. Stop on no effect at the "
            "full sample or a guardrail breach. Anything else follows the rule agreed before launch; no "
            "unplanned extension and no segment picked after seeing results."
        ),
        "randomisation": "Randomise unique customers once, stratified by risk band and region; keep the assignment when pooling monthly scoring runs.",
        "what_two_arms_measure": (
            "Policy versus business as usual measures the offer policy's effect, not the basic and premium "
            "success rates separately, because the policy chooses the offer. Measuring each rate needs the "
            "offer randomised: a second stage, or three arms sized below. Service reviews are outside this "
            "pilot and need their own test."
        ),
        "offer_arms_at_baseline": worst,
        "offer_arms": offer_arms,
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
        expected = sum(policy.decision_risk(r) * config["premium_success"] for r in rows)
        with_contact = sum(
            1
            for r in rows
            if r["features"]["technical_30d"] or r["features"]["billing_30d"]
        )
        return {
            "n": len(rows),
            "mean_risk": round(float(np.mean([policy.decision_risk(r) for r in rows])), 4),
            "expected_saves": round(expected, 2),
            "cost_per_expected_save": round(len(rows) * premium_cost / expected) if expected else None,
            "share_with_recent_service_contact": round(with_contact / len(rows), 3),
        }

    return {
        "top_capacity": segment(ordered[: config["max_customers"]]),
        "cohort": segment(ordered),
        "note": (
            "Risk x assumed success is a targeting proxy, not measured uplift. The share with a recent "
            "technical or billing contact marks where a service check may come before a discount; "
            "resolution status is unknown, so verify the current issue status, and no recorded contact "
            "does not mean no service problem. Only a randomised holdout can confirm responsiveness."
        ),
    }
