export const POLICY_VERSION = "retention-v2";
export const DEFAULTS = Object.freeze({
  budget: 3000000,
  maxCustomers: 10,
  retainedValue: 6000000,
  basicSuccess: 0.2,
  premiumSuccess: 0.5,
  prioritizeTechnical: true,
  // Business assumption, not a learned optimum: share of customer capacity reserved
  // for service reviews, whose retention benefit is unmeasured. 0 gives offers only.
  reviewShare: 0.3,
});
export const ACTIONS = Object.freeze({
  basic_offer: { label: "Basic offer", cost: 150000 },
  premium_offer: { label: "Premium offer", cost: 450000 },
  technical_review: { label: "Technical service review", cost: 50000 },
  billing_review: { label: "Billing review", cost: 25000 },
  no_action: { label: "No action", cost: 0 },
});

export function settings(input = {}) {
  const s = { ...DEFAULTS, ...input };
  for (const [key, min, max] of [
    ["budget", 0, 10000000],
    ["maxCustomers", 1, 20],
    ["retainedValue", 0, 12000000],
    ["basicSuccess", 0, 1],
    ["premiumSuccess", 0, 1],
    ["reviewShare", 0, 0.5],
  ]) {
    if (
      typeof s[key] !== "number" ||
      !Number.isFinite(s[key]) ||
      s[key] < min ||
      s[key] > max
    )
      throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(s.maxCustomers) || !Number.isInteger(s.budget))
    throw new Error("Budget and customer limit must be integers");
  if (typeof s.prioritizeTechnical !== "boolean")
    throw new Error("Invalid prioritizeTechnical");
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k]]));
}

// Reserved review slots: share of capacity, rounded down, at least one unless zero.
export const reviewCapacity = (s) =>
  s.reviewShare > 0 ? Math.max(1, Math.floor(s.maxCustomers * s.reviewShare)) : 0;

// Probability used for economics: calibrated when available, else the raw
// score. The raw score orders customers; the calibrated risk prices them.
export const decisionRisk = (customer) =>
  customer.calibrated_risk ?? customer.risk_score;

// Lowest risk at which any offer has positive scenario net benefit. A service
// review is the first step towards an offer, so it is proposed only above it.
// Null when no offer can break even under the current assumptions.
export function reviewFloor(input = {}) {
  const s = settings(input);
  const floors = [
    ["basic_offer", s.basicSuccess],
    ["premium_offer", s.premiumSuccess],
  ]
    .filter(([, success]) => success * s.retainedValue > 0)
    .map(([action, success]) => ACTIONS[action].cost / (success * s.retainedValue));
  return floors.length ? Math.min(...floors) : null;
}

export function compareActions(customer, input = {}) {
  const s = settings(input);
  const technical = customer.features.technical_30d > 0;
  const billing = customer.features.billing_30d > 0;
  const blocked =
    customer.consent === "denied" || customer.eligibility === "ineligible";
  const floor = reviewFloor(s);
  const risk = decisionRisk(customer);
  const worthReview = floor !== null && risk >= floor;
  return Object.entries(ACTIONS).map(([action, a]) => {
    const isOffer = action.endsWith("_offer");
    const eligible =
      action === "no_action" ||
      (!blocked &&
        (isOffer
          ? !technical && !billing
          : (action === "technical_review"
              ? technical
              : billing && !technical) && worthReview));
    const success =
      action === "basic_offer"
        ? s.basicSuccess
        : action === "premium_offer"
          ? s.premiumSuccess
          : null;
    const gross =
      success === null ? null : risk * success * s.retainedValue;
    return {
      action,
      ...a,
      eligible_for_proposal: eligible,
      executable: false,
      review_required: action !== "no_action",
      scenario_net_benefit: gross === null ? null : Math.round(gross - a.cost),
      scenario_prevented_churn:
        success === null ? null : risk * success,
      reason: blocked
        ? "Customer is ineligible or has denied contact consent."
        : isOffer && (technical || billing)
          ? "Recent service/billing contact: verify the current issue status before offering an incentive."
          : action.endsWith("_review") && !worthReview && (technical || billing)
            ? "Risk is below the offer break-even; observe instead of reviewing."
            : action === "no_action"
            ? "Observe; no outreach or incentive."
            : "Proposal only. Unknown consent is not consent: verify a lawful basis for contact (UU PDP No. 27/2022), account status, resolution, contact frequency and offer eligibility before any outreach.",
      cost_source: isOffer
        ? "Assignment reference"
        : action === "no_action"
          ? "No cost"
          : "Illustrative operating-cost assumption",
    };
  });
}

export function buildPlan(customers, input = {}) {
  const s = settings(input);
  const sorted = [...customers].sort(
    (a, b) =>
      b.risk_score - a.risk_score || a.customer_id.localeCompare(b.customer_id),
  );
  const selected = new Map();
  let spent = 0;
  // Explicit service-first allocation; service recovery has no fabricated uplift.
  const reviews = sorted.filter(
    (c) => c.features.technical_30d || c.features.billing_30d,
  );
  reviews.sort(
    (a, b) =>
      (s.prioritizeTechnical
        ? Number(b.features.technical_30d > 0) -
          Number(a.features.technical_30d > 0)
        : 0) || b.risk_score - a.risk_score,
  );
  const reserved = reviewCapacity(s);
  for (const c of reviews) {
    const a = compareActions(c, s).find(
      (a) =>
        a.eligible_for_proposal &&
        ["technical_review", "billing_review"].includes(a.action),
    );
    if (a && spent + a.cost <= s.budget && selected.size < reserved) {
      selected.set(c.customer_id, {
        customer_id: c.customer_id,
        risk_score: c.risk_score,
        ...a,
      });
      spent += a.cost;
    }
  }
  // Greedy marginal benefit per rupiah, including upgrades. Budget feasible,
  // not advertised as globally optimal. Each customer receives at most one action.
  for (;;) {
    const candidates = [];
    for (const c of sorted) {
      const old = selected.get(c.customer_id);
      if (!old && selected.size >= s.maxCustomers) continue;
      if (old && !old.action.endsWith("_offer")) continue;
      for (const a of compareActions(c, s).filter(
        (a) => a.eligible_for_proposal && a.action.endsWith("_offer"),
      )) {
        const extra = a.cost - (old?.cost ?? 0),
          gain = a.scenario_net_benefit - (old?.scenario_net_benefit ?? 0);
        if (extra > 0 && gain > 0 && spent + extra <= s.budget)
          candidates.push({ c, a, extra, gain, ratio: gain / extra });
      }
    }
    // Ties in calibrated value (one isotonic block) fall back to the raw ranking.
    candidates.sort(
      (a, b) =>
        b.ratio - a.ratio ||
        b.gain - a.gain ||
        b.c.risk_score - a.c.risk_score ||
        a.c.customer_id.localeCompare(b.c.customer_id),
    );
    if (!candidates.length) break;
    const { c, a, extra } = candidates[0];
    spent += extra;
    selected.set(c.customer_id, {
      customer_id: c.customer_id,
      risk_score: c.risk_score,
      ...a,
    });
  }
  const items = [...selected.values()];
  const offerNet = items.reduce((n, a) => n + (a.scenario_net_benefit ?? 0), 0);
  const reviewCosts = items
    .filter((a) => !a.action.endsWith("_offer"))
    .reduce((n, a) => n + a.cost, 0);
  const plan = {
    policy_version: POLICY_VERSION,
    status: "pending_review",
    settings: s,
    items,
    total_cost: spent,
    remaining_budget: s.budget - spent,
    scenario_net_benefit: offerNet - reviewCosts,
    scenario_prevented_churn: items.reduce(
      (n, a) => n + (a.scenario_prevented_churn ?? 0),
      0,
    ),
    methodology: `Reserve up to ${Math.round(s.reviewShare * 100)}% of customer capacity (rounded down; minimum one unless zero) for service reviews of customers whose risk clears the offer break-even; allocate the rest to offers by greedy marginal net benefit per rupiah. No global-optimum claim. The reservation and the review gate are business assumptions: review benefit is unmeasured, so neither is derived from the economics.`,
    economic_note:
      "Scenario only. Success is assumed conditional prevention among would-be churners; service-review benefit is unmeasured and assigned zero in the net total. All costs charged upfront.",
    review_checklist: [
      "Confirm account is still active",
      "Verify consent or another lawful basis for contact (UU PDP No. 27/2022) and the frequency cap",
      "Verify service/billing resolution",
      "Check offer eligibility and remaining campaign budget",
    ],
    skipped: sorted
      .filter((c) => !selected.has(c.customer_id))
      .map((c) => ({
        customer_id: c.customer_id,
        reason:
          c.consent === "denied"
            ? "Contact consent denied"
            : c.eligibility === "ineligible"
              ? "Customer ineligible"
              : "Budget/capacity limit, service prerequisite, or no positive assumed net benefit",
      })),
  };
  validatePlan(plan, customers);
  return plan;
}

export function validatePlan(plan, customers) {
  if (!plan?.settings || typeof plan.settings !== "object")
    throw new Error("Plan settings are missing");
  const s = settings(plan.settings),
    ids = new Set();
  let cost = 0,
    benefit = 0,
    prevented = 0;
  if (!Array.isArray(plan.items) || plan.items.length > s.maxCustomers)
    throw new Error("Customer capacity exceeded");
  for (const item of plan.items) {
    if (ids.has(item.customer_id)) throw new Error("Duplicate customer");
    ids.add(item.customer_id);
    const c = customers.find((c) => c.customer_id === item.customer_id);
    if (!c) throw new Error("Unknown customer");
    const trusted = compareActions(c, s).find((a) => a.action === item.action);
    if (!trusted?.eligible_for_proposal || item.action === "no_action")
      throw new Error("Action is not eligible");
    if (
      item.cost !== trusted.cost ||
      item.scenario_net_benefit !== trusted.scenario_net_benefit
    )
      throw new Error("Untrusted economic calculation");
    if (
      item.executable !== false ||
      item.review_required !== true ||
      item.scenario_prevented_churn !== trusted.scenario_prevented_churn
    )
      throw new Error("Untrusted execution flags or prevention estimate");
    cost += trusted.cost;
    benefit += trusted.scenario_net_benefit ?? -trusted.cost;
    prevented += trusted.scenario_prevented_churn ?? 0;
  }
  if (plan.items.filter((i) => !i.action.endsWith("_offer")).length > reviewCapacity(s))
    throw new Error("Service-review reservation exceeded");
  if (cost > s.budget || cost !== plan.total_cost)
    throw new Error("Budget validation failed");
  // NaN fails every comparison, so a missing or NaN aggregate must be rejected
  // explicitly rather than slipping past the tolerance check.
  const claimed = plan.scenario_prevented_churn;
  if (
    plan.remaining_budget !== s.budget - cost ||
    plan.scenario_net_benefit !== benefit ||
    typeof claimed !== "number" ||
    !Number.isFinite(claimed) ||
    Math.abs(claimed - prevented) > 1e-9
  )
    throw new Error("Untrusted aggregate economics");
  return true;
}
