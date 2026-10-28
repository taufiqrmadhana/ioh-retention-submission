# Validation plan

Everything in this repository is retrospective and simulated. This is how the
recommendation would be tested before anyone spends real budget.

## Design

1. Score the live book with the frozen pipeline and lock the model version.
2. Randomise the top two risk bands 50/50 into treatment and control.
3. Treatment receives the policy's action; control receives business as usual.
4. Measure at 30 days (contact resolution, offer acceptance) and 90 days (churn,
   ARPU, margin).

Randomisation, not risk ranking, is what separates responsiveness from risk. Without
control the result cannot be attributed to the offer.

## Sample size

Baseline churn in the supplied cohort is 19.7%. With 80% power and 5% two-sided
alpha:

- detect a 10 point reduction: about 250 customers per arm
- detect a 5 point reduction: about 1,000 customers per arm

Plan the pilot on 2,000 high-risk customers (1,000 per arm) so a 5 point effect is
resolvable. Below that, only large effects are detectable and a null result proves
nothing.

## Metrics

- Primary: 90-day churn rate difference between arms.
- Secondary: cost per retained customer, incremental margin, offer acceptance rate.
- Guardrails: complaint volume, NPS, contact-centre load, discount abuse (repeat
  offers to the same customer).
- Model health: score distribution drift (PSI), calibration error on the treated
  population, share of customers with missing history.

## Decision rules (agreed before the test)

- Ship: churn reduction significant at 5%, cost per retained customer below one
  month of retained margin.
- Iterate: directionally positive but underpowered; extend or narrow to the segment
  with the largest effect.
- Stop: no effect after 1,000 per arm, or guardrail breach.

## Assumptions this test would settle

- The 20% and 50% prevention rates used in the plan are placeholders; the pilot
  replaces them with measured effects.
- Service reviews currently capture no value in the model. If resolution data shows
  they prevent churn, they move from a reservation to a scored action.
- Eligibility and consent are unknown at scoring time and must be resolved before
  any outreach.
