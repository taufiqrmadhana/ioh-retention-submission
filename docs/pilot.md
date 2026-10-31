# Validation plan

Everything in this repository is retrospective and simulated. This is how the
recommendation would be tested before anyone spends real budget. IOH already has a
churn model; the decision layer here can take its scores in place of the demo
logistic model, so both gates below apply to whichever score feeds the policy.
The numbers come from `outputs/report.json` (`pilot`), computed by
`retention/decisions.py` (`pilot_design`, `pilot_sample_size`,
`pilot_margin_sample_size`).

## Gate 1: validate on a complete later cohort

The supplied cohort includes all 41 November churners but only 167 of the 575
non-churners, so its probabilities and metrics are internal to that extract. A
prevalence adjustment alone would not make them transportable. Before the pilot,
request and score:

- a complete monthly panel of active customers, with the source-system
  extraction rules;
- historical profile values with effective timestamps;
- confirmation that the churn registry is complete for the outcome window;
- the incumbent model's scores for the same customers.

Then check ranking (average precision and recall at the real capacity) and
calibration on a later, mature month, against the incumbent score as well as the
demo model. The calibration map shipped here is fitted on the same 208 customers it
prices, so it is in-sample for the retrospective plan; refit it on the later cohort.

## Gate 2: the offer-policy pilot

### Design

1. **Population.** Customers the policy could make an offer to: no technical or
   billing contact in the prior 30 days, not blocked by consent or eligibility,
   and a calibrated risk at or above the basic-offer break-even (12.5% at the
   brief's assumptions). In the November cohort that is 43 of 208 customers (21%).
   Customers with a recent service or billing contact take the review route and
   are not part of this test, so it is an offer-policy pilot, not a test of the
   whole policy.
2. **Randomisation: 50/50.** Within that population, stratified by risk band and
   region, half receive the policy's offer and half receive business as usual. A
   50/50 split gives the most power for a given number of customers. Randomise
   unique customers once and keep the assignment when pooling monthly scoring runs.
3. **Agreed before launch.** What business as usual means, the frozen action
   policy, its budget and capacity per eligible customer, the primary outcome, the
   analysis and the rollout rule.
4. **Horizon.** Primary outcome is churn within 90 days of scoring, so offers that
   only delay churn do not count as saves. Read 30-day churn, offer acceptance,
   complaints and contact-centre load at 30 days. Longer follow-up may still be
   needed to separate a longer delay from durable retention.
5. **After rollout: a 10% holdout.** Once the pilot passes, keep a random 10% of
   the same population on no offer, so uplift keeps being measured and decay is
   caught. This holdout is for monitoring; it is not sized to make the pilot
   decision (see the 90/10 column below).

Randomisation, not risk ranking, separates responsiveness from risk. Without a
control group the result cannot be attributed to the offer.

### Baseline and break-even

- **Baseline.** November churn in the pilot population was 88.4% (38 of 43),
  but that is a 30-day rate on out-of-fold scores in a cohort whose inclusion
  depends on the outcome (`cohort_flow` in the report), so it is not a planning
  baseline. The 90-day baseline must be measured on the live population. For a
  fixed absolute effect the sample size peaks near 50% churn, so sizing at 50%
  is the conservative choice.
- **Break-even.** The policy pays for itself when the churn reduction exceeds its
  incremental cost per randomised customer divided by the retained value. That
  cost is the frozen policy's offers, contact and operating costs, net of
  business-as-usual costs, averaged over everyone assigned to the policy arm.
  Compute it before launch. Illustrations at the brief's figures:

  | Offer mix | Average offer cost | Break-even reduction |
  |---|---|---|
  | Premium for everyone (sizing reference) | Rp450,000 | 7.5 points |
  | Demo plan's offers: 6 premium, 1 basic | Rp407,143 | 6.8 points |
  | Mixed-offer optimum: 5 premium, 5 basic | Rp300,000 | 5.0 points |

  The pilot is sized against 7.5 points, the most expensive case. (The basic
  offer alone breaks even at 2.5 points, too small to test affordably on its own.)
- **The brief's assumption** (premium prevents 50% of would-be churn) implies a
  far larger effect: 25 points at a 50% baseline. Sizing for it would leave a
  break-even result undetectable.

### Sample size

80% power, 5% two-sided alpha, normal approximation for two proportions.

**Detecting an effect against zero:**

| 90-day baseline | Effect to detect | 50/50: per arm (total) | 90/10: control / treatment (total) |
|---|---|---|---|
| 30% | Premium break-even, 7.5 pts | 540 (1,080) | 290 / 2,605 (2,895) |
| 30% | Brief's assumption, 15 pts | 121 (242) | 61 / 544 (605) |
| 50% | Premium break-even, 7.5 pts | **693 (1,386)** | 383 / 3,442 (3,825) |
| 50% | Brief's assumption, 25 pts | 58 (116) | 30 / 267 (297) |

About 700 per arm detects a 7.5-point reduction against zero. It does not show
that the reduction beats the 7.5-point break-even. If the pilot observes exactly
50% against 42.5% at that size, the 95% interval for the reduction is about 2.3
to 12.7 points: clearly positive, but still compatible with an unprofitable effect.

**Showing the effect beats break-even** (lower 95% bound above 7.5 points, 80% power):

| 90-day baseline | True reduction assumed | 50/50: per arm |
|---|---|---|
| 30% | 15 pts (twice break-even) | 471 |
| 50% | 15 pts (twice break-even) | 667 |

So about 700 per arm answers the profitability question only if the true effect
is near twice break-even. If a smaller effect is plausible, either size up or have
management accept, in advance, that a pass may still be unprofitable.

Plan on about 1,400 offer-eligible customers, 700 per arm. At the cohort's 21%
eligible share that means roughly 6,800 scored customers; pool consecutive
monthly scoring runs if one month is not enough. Running the pilot 90/10 instead
would need about 2.8 times as many customers for the same power, which is why the
10% split is kept for after rollout.

### What this pilot measures, and what it does not

- **The offer policy's effect, not each offer's rate.** The policy chooses the
  offer, so two arms do not separate the basic and premium success rates. If the
  decision needs them, randomise the offer itself: a second stage, or three arms
  (no offer, basic, premium) with α split over the two contrasts. At a 50%
  baseline that needs about **839 per arm** to see the premium break-even
  (7.5 points) and about **7,598 per arm** for the basic break-even (2.5 points)
  (`pilot.offer_arms` in the report).
- **Not service reviews.** In the demo plan, three billing reviews take slots
  that offers would otherwise use, giving up Rp1.67M of scenario value. To repay
  that, the reviews would need about 0.28 extra retained customers between them,
  roughly 9.3 points of retention each (`economics.optimisation.review_hurdle`).
  That is a target for a separate service test, not evidence that reviews work.
  The risk gate covers discretionary retention reviews only; ordinary service
  obligations are not gated by risk.
- **Calibration only in the control arm.** The offer changes outcomes in the
  policy arm, so check the score's calibration at the 30-day horizon on control
  customers. They cover only the offer-eligible part of the score range; Gate 1
  covers the rest.

## Metrics

- Primary: 90-day churn difference between arms, and incremental net value per
  randomised customer (churn reduction × retained value − incremental cost).
- Secondary: 30-day churn, cost per retained customer, offer acceptance rate.
- Guardrails: complaint volume, NPS, contact-centre load, discount abuse (repeat
  offers to the same customer), treatment exposure by region and group.

## Decision rules (agreed before the test)

- Ship: the lower end of the 95% interval for incremental net value per
  randomised customer is above zero.
- Stop: no effect at the full sample, or a guardrail breach.
- Anything else follows the rule written down before launch. Do not extend the
  test unplanned or pick the segment with the largest effect after seeing results.

## Monitoring

| Layer | What to monitor | What it tells the business | Owner | Response |
|---|---|---|---|---|
| Data and model | Cohort coverage, missing history, delayed labels, average precision and recall at actual capacity, calibration in the control arm | Whether the ranking and risk estimates still apply | Data science | A data-integrity failure pauses automated proposals; drift triggers a refit on mature outcomes |
| Policy | Randomised incremental margin, 30/90-day churn, costs, complaints, service workload, treatment exposure by group | Whether the decisions create value with acceptable customer outcomes | Retention / CRM with finance | An inconclusive result follows the agreed decision rule; a guardrail breach stops the arm |
| Agent and workflow | Scope accuracy, validation rejections, flagged claims, override rate, tool errors, latency and cost | Whether the interface is useful and trustworthy | Product and engineering | Above the agreed error rates, switch off the live agent; the deterministic planner stays |

Thresholds are agreed with the business, not taken from this extract.

## Assumptions this test would settle

- The 20% and 50% prevention rates used in the plan are placeholders. The
  two-arm pilot replaces them with one measured effect for the offer policy;
  separate rates need the offer randomised.
- Service reviews currently capture no value in the model. If a service test
  shows they prevent churn, they move from a reservation to a scored action.
- Eligibility and consent are unknown at scoring time and must be resolved before
  any outreach.
