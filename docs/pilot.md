# Validation plan

Everything in this repository is retrospective and simulated. This is how the
recommendation would be tested before anyone spends real budget. IOH already has a
churn model; the decision layer here can take its scores in place of the demo
logistic model, so both gates below apply to whichever score feeds the policy.
The candidate is exact budget-constrained mixed offers, with no reserved
capacity for discretionary service reviews. Test those reviews separately unless
the business explicitly requires a quota; ordinary service obligations continue.
The first comparison holds the score source, eligibility, budget and capacity
constant to isolate the allocation policy's contribution.
The sizing illustrations come from `outputs/report.json` (`pilot`), computed by
`retention/decisions.py` (`pilot_design`, `pilot_sample_size`,
`pilot_margin_sample_size`).

## Gate 1: validate on a complete later cohort

The supplied cohort includes all 41 November churners but only 167 of the 575
records without recorded November churn. Their active status is unverified, and
probabilities and metrics are internal to this extract. A prevalence adjustment alone would not make them transportable. Before the pilot,
request and score:

- a complete monthly panel of active customers, with the source-system
  extraction rules;
- historical profile values with effective timestamps;
- confirmation that the churn registry is complete for the outcome window;
- the incumbent model's scores for the same customers.

Assign chronological roles before using later data:

1. **Develop through month T.** Fit or select the score and calibrator using
   mature development outcomes only, choose the eligibility rules and policy,
   and freeze their combined versions. The primary historical replay in this
   repo uses nested held-out calibration; the separate all-data map is fitted
   for future scoring, not independent retrospective evidence.
2. **Validate on untouched T+1.** Score the complete later cohort using the
   frozen artifacts and feature-as-of rules. After labels mature, assess ranking
   (average precision and recall at actual capacity), calibration at the score's
   30-day horizon and the resulting decision eligibility. Compare the incumbent
   score, frozen rules and demo baseline on the same customers. Do not refit on
   T+1 before reporting this validation.
3. **Refit only for a subsequent cohort.** If T+1 is later used for development
   or calibration, its refitted results are no longer independent validation.
   Validate the new version on an untouched subsequent cohort. With only one
   later cohort, a predeclared split or cross-fit is provisional evidence, not
   untouched temporal validation.

Candidate identities change substantially between calibration paths in the
historical extract. Inspect interchangeable candidates and tie-breaking as well
as aggregate scenario value; do not claim the ten proposed people are uniquely
optimal. Proceed only after the frozen score and policy apply to the live target
population.

## Gate 2: the offer-policy pilot

### Design

1. **Population.** Customers the policy could make an offer to: no technical or
   billing contact in the prior 30 days, not blocked by verified consent or
   eligibility, and calibrated risk at or above the basic-offer break-even
   (12.5% at the brief's assumptions). This extract provides proposal eligibility
   only; live consent and issue status are unknown. Verify current issue status
   before choosing either an offer or a review. Customers requiring service
   review are outside this offer-policy test; ordinary service is provided in
   both arms.
2. **Randomisation: 50/50.** Within that population, stratified by risk band and
   region, randomise unique customers once and retain assignment across monthly
   scoring runs. Half use the proposed mixed-offer allocation and half use the
   frozen current retention practice. Use the same incumbent score, eligibility,
   budget and capacity per randomised customer in both arms. Both policies may
   leave some assigned customers untreated; analyse everyone as assigned.
3. **Freeze the comparator and economics.** Record existing campaigns,
   incumbent offers, ordinary service obligations, contact/suppression rules and
   all associated costs in each arm. Name the proposed policy's additions or
   substitutions explicitly. BAU means that defined current practice and need
   not mean no offer. Freeze versions, resource limits, outcomes, analysis and
   rollout rule before assignment. A simultaneous score change would confound
   the decision-layer comparison.
4. **Horizon.** Primary outcome is churn within 90 days of scoring. Read 30-day
   churn, offer acceptance, complaints and contact-centre load at 30 days.
   Ninety-day survival can still be delayed churn rather than durable retention;
   use longer follow-up where the finance value requires it.
5. **After rollout: a 10% BAU holdout.** Once the pilot passes, retain a random
   10% of the same eligible population on the same frozen comparator. Preserve
   incumbent offers and service obligations in that arm. A change to no offer
   changes the effect being estimated and requires an explicit new protocol.
   This monitoring holdout is not sized for the pilot decision (see below).

Randomisation, not risk ranking, separates responsiveness from risk. The contrast
estimates the proposed allocation policy against the defined current practice; it does not attribute all treatment-arm retention to the new offers.

### Baseline and break-even

- **Baseline.** The retrospective offer-eligible group is highly selected
  (`cohort_flow` and `pilot` in the report), with only a 30-day observed outcome,
  so neither its churn rate nor its eligible share is a planning baseline.
  Measure the 90-day baseline on the live population. For a fixed absolute effect the sample size peaks near 50% churn, so sizing at 50%
  is the conservative choice.
- **Break-even.** The policy pays for itself when the churn reduction exceeds its
  incremental cost per randomised customer divided by the retained value. That
  cost is the frozen policy's offers, contact and operating costs, net of
  business-as-usual costs, averaged over everyone assigned to the policy arm.
  Compute it before launch. Illustrations at the brief's figures:

  | Offer mix | Average offer cost | Break-even reduction |
  |---|---|---|
  | Premium for everyone (sizing reference) | Rp450,000 | 7.5 points |
  | Illustrative mixed offers: 5 premium, 5 basic | Rp300,000 | 5.0 points |

  These rows assume everyone receives the stated offer mix, no BAU offer cost
  and no additional operating cost. The pilot must use the actual treatment
  fraction and incremental costs across everyone randomised. The illustration
  sizes a premium-for-everyone reference at 7.5 points; this does not power the
  recommended mixed policy at its smaller 5-point hurdle. Smaller effects require
  more customers to detect, so the most expensive offer is not a conservative
  sample-size bound. Recompute sizing for the frozen live policy. (Basic alone
  breaks even at 2.5 points, too small to test affordably on its own.)
- **The brief's assumption** (premium prevents 50% of would-be churn) implies a
  far larger effect: 25 points at a 50% baseline. Sizing for it would leave a
  break-even result undetectable.
- **Value and horizon.** Rp6M is the brief's assumed value per retained customer,
  not measured 90-day margin. Before launch, finance defines whether it means
  revenue or contribution, the valuation horizon, attributable costs and any
  discounting, and how delayed versus sustained churn prevention is monetised.
  Report realised incremental contribution over the observed horizon separately
  from any modelled future value. A 90-day churn difference alone does not prove
  Rp6M of financial benefit.

### Sample size

80% power, 5% two-sided alpha, normal approximation for two proportions.

**Detecting an effect against zero:**

| 90-day baseline | Effect to detect | 50/50: per arm (total) | 90/10: control / treatment (total) |
|---|---|---|---|
| 30% | Premium break-even, 7.5 pts | 540 (1,080) | 290 / 2,605 (2,895) |
| 30% | Brief's assumption, 15 pts | 121 (242) | 61 / 544 (605) |
| 50% | Premium break-even, 7.5 pts | **693 (1,386)** | 383 / 3,442 (3,825) |
| 50% | Brief's assumption, 25 pts | 58 (116) | 30 / 267 (297) |

For the premium-for-everyone illustration, about 700 per arm detects a 7.5-point
reduction against zero at a 50% baseline. This is not the mixed policy's sample
size. It does not show that the reduction beats the 7.5-point break-even. If the pilot observes exactly
50% against 42.5% at that size, the 95% interval for the reduction is about 2.3
to 12.7 points: clearly positive, but still compatible with an unprofitable effect.

**Showing the effect beats break-even** (lower 95% bound above 7.5 points, 80% power):

| 90-day baseline | True reduction assumed | 50/50: per arm |
|---|---|---|
| 30% | 15 pts (twice break-even) | 471 |
| 50% | 15 pts (twice break-even) | 667 |

So about 700 per arm answers the profitability question only if the true effect
is near twice break-even. If a smaller effect is plausible, size up or predeclare
how an inconclusive profitability result will be handled. Detecting benefit alone
is not a pass under the rollout rule below.

The 1,400 unique eligible customers (about 700 per arm) are an illustration
conditional on the baseline, effect, costs and assumptions above. Measure the live
recruitment funnel, freeze the offer mix and treatment fraction, and recompute
power using BAU churn and incremental policy costs before launch. The selected
extract's eligible share is not a live recruitment forecast; consent is unknown.
For an illustrative target of 1,400 eligible customers:

| Verified live eligible share | Unique customers to score |
|---|---:|
| 10% | 14,000 |
| 20% | 7,000 |
| 30% | 4,667 |

Pool consecutive monthly runs if needed, deduplicating customers and preserving
assignment. Running the same illustrative pilot 90/10 would need about 2.8 times
as many customers for the same power, which is why the 10% split is reserved for
monitoring after rollout. No sample size here is a fixed live commitment.

### What this pilot measures, and what it does not

- **The offer policy's effect, not each offer's rate.** The policy chooses the
  offer, so two arms do not separate the basic and premium success rates. If the
  decision needs them, randomise the offer itself: a second stage, or three arms
  (defined BAU, BAU plus basic, BAU plus premium) with α split over the two
  contrasts. Freeze which incumbent incentives are replaced or retained in each
  arm; a true no-offer control is equivalent only if BAU includes no offers.
  Under the illustrative 50% baseline and costs above, that needs about **839 per arm** to see the premium break-even
  (7.5 points) and about **7,598 per arm** for the basic break-even (2.5 points)
  (`pilot.offer_arms` in the report).
- **Not service reviews.** The recommended default reserves no discretionary
  review slots. An optional quota consumes shared resources while review benefit
  is counted as zero. Report its opportunity cost under the same frozen risks,
  budget and capacity, and test the additional benefit separately before treating
  it as value. In the nested held-out replay, reserving three billing reviews
  gives up Rp1.66M of scenario value against the no-quota default. The reviews
  need about 0.277 extra retained customers between them, or 9.2 points each,
  to repay that cost. These are exploratory targets, not measured service effects. Ordinary service obligations are not gated by risk.
- **Calibration only in the control arm.** The offer changes outcomes in the
  policy arm, so check the score's calibration at the 30-day horizon on control
  customers. They cover only the offer-eligible part of the score range; Gate 1
  covers the rest.

## Metrics

- Primary: 90-day churn difference and finance-defined incremental net value per
  randomised customer, including all delivered treatment and operating costs net
  of BAU. Report observed contribution separately from scenario valuation
  (churn reduction × assumed retained value − incremental cost).
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

## Proposed decision and experiment contract

Before production, join the current score/evidence and approval record to:

| Field group | Required meaning |
|---|---|
| Score validity | Feature-as-of timestamp, scoring time, 30-day horizon, expiry, score/model/calibrator versions |
| Decision | Proposal and campaign IDs, policy/comparator versions, budget/capacity, pending consent/issue/eligibility checks |
| Experiment | Unique customer assignment, assignment time, arm and randomisation probability; keep assignment across repeat scores |
| Delivery | Assigned action, actual treatment delivered, time, cost, refusal/non-delivery reason; assignment alone is not delivery |
| Outcome | 30/90-day windows, mature outcome date, churn/retention, contribution and cost provenance |

These are proposed source-system interfaces, not a production capability of the
simulated workbench. Synthetic outcomes are never training labels. Test agent
natural-language scope/task accuracy separately from deterministic tool contracts;
report real-prompt English/Indonesian scope correctness, unsupported claims,
completion, latency and cost before claiming live-model accuracy.
