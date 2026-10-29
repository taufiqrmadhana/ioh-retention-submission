# Validation plan

Everything in this repository is retrospective and simulated. This is how the
recommendation would be tested before anyone spends real budget. The numbers
below come from `outputs/report.json` (`pilot`), computed by
`retention/decisions.py` (`pilot_design`, `pilot_sample_size`).

## Design

One design, used in the deck, the workbench and here:

1. **Population.** Customers the policy could make an offer to: no technical or
   billing contact in the prior 30 days, not blocked by consent or eligibility,
   and a calibrated risk at or above the basic-offer break-even (12.5% at the
   brief's assumptions). In the November cohort that is 43 of 208 customers (21%).
   Customers with a recent service or billing contact take the review route and
   are not part of this offer test.
2. **Pilot randomisation: 50/50.** Within that population, stratified by risk
   band and region, half receive the policy's offer and half receive business as
   usual. A 50/50 split gives the most power for a given number of customers.
3. **Horizon.** Primary outcome is churn within 90 days of scoring. Read
   offer acceptance, complaints and contact-centre load at 30 days.
4. **After rollout: a 10% holdout.** Once the pilot passes, keep a random 10% of
   the same population on no offer, so uplift keeps being measured and decay is
   caught. This holdout is for monitoring; it is not sized to make the pilot
   decision (see the 90/10 column below).

Randomisation, not risk ranking, separates responsiveness from risk. Without a
control group the result cannot be attributed to the offer.

## Baseline and effect

- **Baseline.** November churn in the pilot population was 88.4% (38 of 43),
  but that is a 30-day rate on out-of-fold scores in a cohort whose inclusion
  depends on the outcome (`cohort_flow` in the report), so it is not a planning
  baseline. The 90-day baseline must be measured on the live population. For a
  fixed absolute effect the sample size peaks near 50% churn, so sizing at 50%
  is the conservative choice.
- **Smallest effect worth detecting.** A premium offer pays for itself when it
  cuts churn by its cost divided by the retained value: Rp450K / Rp6M =
  **7.5 points**, whatever the baseline. That is the effect the pilot must be
  able to see. (The basic offer breaks even at 2.5 points, too small to test
  affordably on its own.)
- **The brief's assumption** (premium prevents 50% of would-be churn) implies a
  far larger effect: 25 points at a 50% baseline. Sizing for it would leave a
  break-even result undetectable.

## Sample size

80% power, 5% two-sided alpha, normal approximation for two proportions.

| 90-day baseline | Effect to detect | 50/50: per arm (total) | 90/10: control / treatment (total) |
|---|---|---|---|
| 30% | Premium break-even, 7.5 pts | 540 (1,080) | 290 / 2,605 (2,895) |
| 30% | Brief's assumption, 15 pts | 121 (242) | 61 / 544 (605) |
| 50% | Premium break-even, 7.5 pts | **693 (1,386)** | 383 / 3,442 (3,825) |
| 50% | Brief's assumption, 25 pts | 58 (116) | 30 / 267 (297) |

Plan the pilot on about 1,400 offer-eligible customers, 700 per arm. At the
cohort's 21% eligible share that means roughly 6,800 scored customers; pool
consecutive monthly scoring runs if one month is not enough. Running the pilot
90/10 instead would need about 2.8 times as many customers for the same power,
which is why the 10% split is kept for after rollout.

## Metrics

- Primary: 90-day churn difference between arms.
- Secondary: cost per retained customer (offer cost / absolute churn reduction),
  incremental margin, offer acceptance rate.
- Guardrails: complaint volume, NPS, contact-centre load, discount abuse (repeat
  offers to the same customer).
- Model health: score distribution drift (PSI), calibration error on the treated
  population, share of customers with missing history.

## Decision rules (agreed before the test)

- Ship: churn reduction significant at 5% and its estimate at or above the
  7.5-point break-even, i.e. cost per retained customer below the Rp6M retained
  value.
- Iterate: directionally positive but below break-even or underpowered; extend,
  or narrow to the segment with the largest effect.
- Stop: no effect at the full sample, or a guardrail breach.

## Assumptions this test would settle

- The 20% and 50% prevention rates used in the plan are placeholders; the pilot
  replaces them with measured effects.
- Service reviews currently capture no value in the model. If resolution data shows
  they prevent churn, they move from a reservation to a scored action.
- Eligibility and consent are unknown at scoring time and must be resolved before
  any outreach.
