"""Deterministic proposal eligibility and budget-constrained retention allocation."""

from math import floor, isfinite

POLICY_VERSION = "retention-v2"
DEFAULTS = {
    "budget": 3_000_000,
    "max_customers": 10,
    "retained_value": 6_000_000,
    "basic_success": 0.2,
    "premium_success": 0.5,
    "prioritize_technical": True,
}
ACTIONS = {
    "basic_offer": {"label": "Basic offer", "cost": 150_000},
    "premium_offer": {"label": "Premium offer", "cost": 450_000},
    "technical_review": {"label": "Technical service review", "cost": 50_000},
    "billing_review": {"label": "Billing review", "cost": 25_000},
    "no_action": {"label": "No action", "cost": 0},
}


def settings(overrides=None):
    """Validate the user-controlled budget, capacity and economic assumptions."""
    values = {**DEFAULTS, **(overrides or {})}
    bounds = {
        "budget": (0, 10_000_000),
        "max_customers": (1, 20),
        "retained_value": (0, 12_000_000),
        "basic_success": (0, 1),
        "premium_success": (0, 1),
    }
    for key, (minimum, maximum) in bounds.items():
        value = values[key]
        if (
            type(value) not in (int, float)
            or not isfinite(value)
            or not minimum <= value <= maximum
        ):
            raise ValueError(f"Invalid {key}")
    for key in ("budget", "max_customers"):
        if values[key] != int(values[key]):
            raise ValueError("Budget and customer limit must be integers")
        values[key] = int(values[key])
    if type(values["prioritize_technical"]) is not bool:
        raise ValueError("Invalid prioritize_technical")
    return {key: values[key] for key in DEFAULTS}


def decision_risk(customer):
    """Probability used for economics: calibrated when available, else the raw score.

    The raw score orders customers; the calibrated risk prices them.
    """
    return customer.get("calibrated_risk", customer["risk_score"])


def review_floor(overrides=None):
    """Lowest risk at which any offer has positive scenario net benefit.

    A service review is the first step towards an offer, so it is proposed only
    for customers whose risk would justify one once the issue is resolved.
    None when no offer can break even under the current assumptions.
    """
    config = settings(overrides)
    floors = [
        ACTIONS[action]["cost"] / (config[success] * config["retained_value"])
        for action, success in (("basic_offer", "basic_success"), ("premium_offer", "premium_success"))
        if config[success] * config["retained_value"] > 0
    ]
    return min(floors) if floors else None


def compare_actions(customer, overrides=None):
    """Return authoritative costs and scenario values; never authorize execution."""
    config = settings(overrides)
    technical = customer["features"]["technical_30d"] > 0
    billing = customer["features"]["billing_30d"] > 0
    blocked = (
        customer.get("consent") == "denied"
        or customer.get("eligibility") == "ineligible"
    )
    risk_floor = review_floor(config)
    risk = decision_risk(customer)
    worth_review = risk_floor is not None and risk >= risk_floor
    results = []
    for action, details in ACTIONS.items():
        offer = action.endswith("_offer")
        allowed = (
            (not technical and not billing)
            if offer
            else (
                technical if action == "technical_review" else billing and not technical
            )
            and worth_review
        )
        eligible = action == "no_action" or (not blocked and allowed)
        success = {
            "basic_offer": config["basic_success"],
            "premium_offer": config["premium_success"],
        }.get(action)
        gross = (
            None
            if success is None
            else risk * success * config["retained_value"]
        )
        if blocked:
            reason = "Customer is ineligible or has denied contact consent."
        elif offer and (technical or billing):
            reason = (
                "Verify the recent service/billing issue before offering an incentive."
            )
        elif action.endswith("_review") and not worth_review and (technical or billing):
            reason = "Risk is below the offer break-even; observe instead of reviewing."
        elif action == "no_action":
            reason = "Observe; no outreach or incentive."
        else:
            reason = "Proposal only. Unknown consent is not consent: verify a lawful basis for contact (UU PDP No. 27/2022), account status, resolution, contact frequency and offer eligibility before any outreach."
        results.append(
            {
                "action": action,
                **details,
                "eligible_for_proposal": eligible,
                "executable": False,
                "review_required": action != "no_action",
                # Match nearest-rupiah rounding, including half ties toward +infinity.
                "scenario_net_benefit": None
                if gross is None
                else floor(gross - details["cost"] + 0.5),
                "scenario_prevented_churn": None
                if success is None
                else risk * success,
                "reason": reason,
                "cost_source": "Assignment reference"
                if offer
                else (
                    "No cost"
                    if action == "no_action"
                    else "Illustrative operating-cost assumption"
                ),
            }
        )
    return results


def build_plan(customers, overrides=None):
    """Reserve review capacity, then greedily allocate profitable offer increments."""
    config = settings(overrides)
    ordered = sorted(customers, key=lambda c: (-c["risk_score"], c["customer_id"]))
    selected, spent = {}, 0
    reviews = [
        c
        for c in ordered
        if c["features"]["technical_30d"] or c["features"]["billing_30d"]
    ]
    reviews.sort(
        key=lambda c: (
            -int(c["features"]["technical_30d"] > 0)
            if config["prioritize_technical"]
            else 0,
            -c["risk_score"],
        )
    )
    review_capacity = max(1, floor(config["max_customers"] * 0.3))
    for customer in reviews:
        action = next(
            (
                a
                for a in compare_actions(customer, config)
                if a["eligible_for_proposal"]
                and a["action"] in ("technical_review", "billing_review")
            ),
            None,
        )
        if (
            action
            and spent + action["cost"] <= config["budget"]
            and len(selected) < review_capacity
        ):
            selected[customer["customer_id"]] = {
                "customer_id": customer["customer_id"],
                "risk_score": customer["risk_score"],
                **action,
            }
            spent += action["cost"]

    # Greedy marginal benefit per rupiah, including upgrades; not a global optimum.
    while True:
        candidates = []
        for customer in ordered:
            old = selected.get(customer["customer_id"])
            if old is None and len(selected) >= config["max_customers"]:
                continue
            if old and not old["action"].endswith("_offer"):
                continue
            for action in compare_actions(customer, config):
                if not action["eligible_for_proposal"] or not action["action"].endswith(
                    "_offer"
                ):
                    continue
                extra = action["cost"] - (old["cost"] if old else 0)
                gain = action["scenario_net_benefit"] - (
                    old["scenario_net_benefit"] if old else 0
                )
                if extra > 0 and gain > 0 and spent + extra <= config["budget"]:
                    candidates.append((gain / extra, gain, customer, action, extra))
        if not candidates:
            break
        # Ties in calibrated value (one isotonic block) fall back to the raw ranking.
        candidates.sort(
            key=lambda item: (
                -item[0],
                -item[1],
                -item[2]["risk_score"],
                item[2]["customer_id"],
            )
        )
        _, _, customer, action, extra = candidates[0]
        spent += extra
        selected[customer["customer_id"]] = {
            "customer_id": customer["customer_id"],
            "risk_score": customer["risk_score"],
            **action,
        }

    items = list(selected.values())
    prevented = 0.0
    for item in items:
        prevented += item["scenario_prevented_churn"] or 0
    plan = {
        "policy_version": POLICY_VERSION,
        "status": "pending_review",
        "settings": config,
        "items": items,
        "total_cost": spent,
        "remaining_budget": config["budget"] - spent,
        "scenario_net_benefit": sum(
            a["scenario_net_benefit"]
            if a["scenario_net_benefit"] is not None
            else -a["cost"]
            for a in items
        ),
        "scenario_prevented_churn": prevented,
        "methodology": "Reserve up to 30% of customer capacity (rounded down; minimum one) for service reviews of customers whose risk clears the offer break-even; allocate the rest to offers by greedy marginal net benefit per rupiah. No global-optimum claim.",
        "economic_note": "Scenario only. Success is assumed conditional prevention among would-be churners; service-review benefit is unmeasured and assigned zero in the net total. All costs charged upfront.",
        "review_checklist": [
            "Confirm account is still active",
            "Verify consent or another lawful basis for contact (UU PDP No. 27/2022) and the frequency cap",
            "Verify service/billing resolution",
            "Check offer eligibility and remaining campaign budget",
        ],
        "skipped": [
            {
                "customer_id": c["customer_id"],
                "reason": (
                    "Contact consent denied"
                    if c.get("consent") == "denied"
                    else "Customer ineligible"
                    if c.get("eligibility") == "ineligible"
                    else "Budget/capacity limit, service prerequisite, or no positive assumed net benefit"
                ),
            }
            for c in ordered
            if c["customer_id"] not in selected
        ],
    }
    validate_plan(plan, customers)
    return plan


_MISSING = object()


def validate_plan(plan, customers):
    """Reject fabricated actions, costs, execution flags and aggregate economics.

    Missing fields count as forged (ValueError), matching validatePlan in web/policy.js.
    """
    if not isinstance(plan, dict) or not isinstance(plan.get("settings"), dict):
        raise ValueError("Plan settings are missing")
    config, seen = settings(plan["settings"]), set()
    cost, benefit, prevented = 0, 0, 0.0
    items = plan.get("items")
    if not isinstance(items, list) or len(items) > config["max_customers"]:
        raise ValueError("Customer capacity exceeded")
    lookup = {c["customer_id"]: c for c in customers}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Unknown customer")
        customer_id = item.get("customer_id", _MISSING)
        if customer_id in seen:
            raise ValueError("Duplicate customer")
        if customer_id not in lookup:
            raise ValueError("Unknown customer")
        seen.add(customer_id)
        trusted = next(
            (
                a
                for a in compare_actions(lookup[customer_id], config)
                if a["action"] == item.get("action", _MISSING)
            ),
            None,
        )
        if (
            not trusted
            or not trusted["eligible_for_proposal"]
            or trusted["action"] == "no_action"
        ):
            raise ValueError("Action is not eligible")
        if (
            item.get("cost", _MISSING) != trusted["cost"]
            or item.get("scenario_net_benefit", _MISSING) != trusted["scenario_net_benefit"]
        ):
            raise ValueError("Untrusted economic calculation")
        if (
            item.get("executable", _MISSING) is not False
            or item.get("review_required", _MISSING) is not True
            or item.get("scenario_prevented_churn", _MISSING) != trusted["scenario_prevented_churn"]
        ):
            raise ValueError("Untrusted execution flags or prevention estimate")
        cost += trusted["cost"]
        benefit += (
            trusted["scenario_net_benefit"]
            if trusted["scenario_net_benefit"] is not None
            else -trusted["cost"]
        )
        prevented += trusted["scenario_prevented_churn"] or 0
    if cost > config["budget"] or cost != plan.get("total_cost", _MISSING):
        raise ValueError("Budget validation failed")
    claimed = plan.get("scenario_prevented_churn")
    if (
        plan.get("remaining_budget", _MISSING) != config["budget"] - cost
        or plan.get("scenario_net_benefit", _MISSING) != benefit
        or type(claimed) not in (int, float)
        or not isfinite(claimed)
        or abs(claimed - prevented) > 1e-9
    ):
        raise ValueError("Untrusted aggregate economics")
    return True
