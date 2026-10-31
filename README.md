# Customer Retention — IOH Technical Test

Churn analysis and budget-aware retention planning for the supplied telco extract: point-in-time cohort, out-of-fold model evidence, a deterministic policy, and a bounded tool-calling agent that proposes actions for human review. Nothing is executed against customers.

IOH already has a churn model. The contribution here is the decision layer that could take its scores: who is eligible for which action, what fits the budget, and how to measure whether the action creates incremental margin. The logistic model is a transparent baseline for the demo; nothing here shows it beats IOH's model or current retention practice, neither of which was supplied.

**Demo:** [indosat.madgun.us](https://indosat.madgun.us)

## Layout

- `data/` — the three supplied datasets.
- `retention/analysis.py` — cohort construction, features, model evaluation, calibration check, out-of-fold scores.
- `retention/policy.py` — action eligibility, costs, budget and capacity allocation.
- `retention/decisions.py` — decision diagnostics: break-even, exact-allocation gap, strategy comparison, pilot sizing.
- `retention/agent.py` — tool-calling agent over the analysis and policy.
- `web/` — the workbench frontend (vanilla JS, no build step). `web/policy.js` is the JS port of the policy, shared by the browser and the worker.
- `worker/` — Cloudflare Worker: serves `web/`, exposes `/api/*`, owns validation, approval state and the agent call.
- `web/assistant.js` + `worker/assistant.js` — the floating chat assistant (`/api/chat`). It answers questions about this project, guides users through each page (`worker/guide.js`, with links that jump to and highlight a panel), and runs read-only what-if simulations through the same policy; it cannot save, approve or execute plans. Uses the same `DEEPSEEK_API_KEY` as the agent.
- `outputs/` — generated artefacts; `intelligence.json` (scores, no labels) and `report.json` (evaluation) are committed because the API serves them.
- `tests/` — Python checks; `tests/js/` — JavaScript checks for the policy port, the worker agent and the workbench in a browser; `tests/fixtures/policy_cases.json` — policy cases both languages must reproduce.
- `docs/pilot.md` — how the recommendation would be tested for real.

## Run the analysis (Python)

Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --frozen
uv run python -m retention analyze
uv run python -m retention plan --budget 3000000 --limit 10
uv run pytest -q
```

Agent run needs `DEEPSEEK_API_KEY` in the environment or in an ignored `.env`:

```bash
uv run python -m retention agent "Prioritise technical reviews and compare retention offers."
```

## Run the workbench (Cloudflare Worker)

Node 22+. The Worker runs locally under `wrangler dev`, with a local Durable Object for plan history; no Cloudflare account is needed.

```bash
npm ci
npm run dev
```

Open http://localhost:8787. Everything except the live agent and chat works without a key. To enable them, copy `.dev.vars.example` to `.dev.vars` and set `DEEPSEEK_API_KEY`.

```bash
npm test
npm run check
```

`npm test` runs the JavaScript tests. The browser test is skipped unless Playwright is installed (`npm i --no-save playwright && npx playwright install chromium`). `npm run check` bundles the Worker without deploying it.

To deploy to your own account: `npx wrangler deploy`, then `npx wrangler secret put DEEPSEEK_API_KEY`. `wrangler.jsonc` has no account ID or routes; attach a custom domain in the Cloudflare dashboard.

If the policy changes on purpose, regenerate the shared cases with `uv run python -m tests.policy_fixtures`; both test suites must then pass.

## Method in one paragraph

Decision date 01 Nov 2025, outcome window [01 Nov, 01 Dec). The cohort is the 208 customers with an October usage row who had not churned by 1 Nov; 408 other not-yet-churned customers have no October row and are excluded, while every November churner has one, so the 19.7% churn rate describes this observable cohort, not the whole active base. Features are computed strictly before the snapshot; resolution status is excluded because it has no historical timestamp. Customers are split 75/25 inside one cohort, preprocessing is fit on train only, and demo scores come from five-fold out-of-fold logistic regression. The raw score orders customers; a smoothed-isotonic calibrated risk prices them, because raw scores overstate risk between 12% and 30%. That map is fitted on all 208 out-of-fold scores and labels, so applied back to the same customers the historical plan is in-sample; it is out-of-sample only for a later cohort. The policy reserves up to 30% of capacity (`review_share`, 0 to 50%) for service reviews of customers with a recent contact whose risk clears the offer break-even (12.5% at the brief's assumptions), then fills offers by greedy marginal net benefit per rupiah within budget. Net benefit = calibrated risk × assumed prevention × retained value − cost; rates and retained value are assumptions, not measured uplift. The agent turns a request into a scope (contact type, region, internet type); the backend evaluates every customer in that scope, and proposals require approval and record a simulation only. Unknown consent is not consent: no action is executable until a lawful basis for contact is verified (UU PDP No. 27/2022).

## Decision diagnostics

`outputs/report.json` carries these checks next to the plan:

- *cohort_flow* — who is excluded from the cohort and why.
- *subgroups* — churn, score and recall by gender and region, with recall measured at one cohort-wide top-20% cutoff. A per-group quota would cap Bandung (12 slots for 25 churners), so groups are compared at the shared cutoff.
- *calibration_check* — raw scores rank well but overstate risk between 12% and 30% (none of the customers scored 12.5–20% churned). Sigmoid, isotonic and smoothed isotonic are each fitted out-of-fold and compared on Brier and log-loss; smoothed isotonic is the only one that lowers both. Decisions use `calibrated_risk` from one smoothed-isotonic map fitted on all out-of-fold scores (deployment-style, monotone, so the raw ranking is kept); the raw score only orders customers. Calibration improves the nested out-of-fold Brier and log-loss but not the 52-customer holdout, so the evidence is mixed and the map is provisional. Because the map saw every label it prices, `plan_impact.cross_fitted` re-prices the plan with nested held-out risks: same mix, spend and near-identical value (Rp15.64M against Rp15.71M), but only 1 of the 10 chosen customers is the same and 12 customers cross the 12.5% gate. 32 customers share the top calibrated risk, so the economics cannot tell them apart; which of them get offers is not a robust result.
- *rule_check* — the four-condition segment (month-to-month, tenure under 6 months, fiber, electronic check) holds every November churner. With "no recent contact" added it flags 40 customers with 38 churners, close to the model's top 20%. The model's added value is the order inside the segment and a graded score for spend; the segment was found by looking at all labels, so it is optimistic. Both rules are also in the holdout comparison.
- *economics.sensitivity* — the same policy re-planned across assumed success rates and retained values. Break-even is found by bisection on the re-planned plan, because the plan's mix changes between grid points.
- *economics.optimisation* — the algorithm gap (greedy against an exact optimiser that keeps the same service reviews) and, separately, the scenario value the review reservation gives up, plus the hurdle that would repay it: about 0.28 extra retained customers across the three reviews, 9.3 points of retention each. That is a target for a service test, not evidence.
- *economics.strategies* — the policy plan against mixed offers with no review slots, premium-only and basic-only targeting at the same budget, capacity and eligibility, plus an uncapped threshold rule with and without the service/billing checks. At Rp3M / 10: mixed offers Rp17.38M (5 premium, 5 basic, the exact optimum), policy plan Rp15.71M (6 premium, 1 basic, 3 billing reviews). The Rp1.67M gap is the scenario price of the review reservation. The reservation and the review gate are business assumptions: review benefit is unmeasured, so neither follows from the economics.
- *economics.premium_stress* — the same comparison as the premium success rate falls. Below about 34% basic-only beats the policy plan, because the review slots displace basic offers while review benefit counts as zero.
- *economics.decision_curve* — net benefit against treating everyone and treating no one.
- *pilot* — the offer-policy pilot for `docs/pilot.md`: population, horizon, break-even definition (incremental cost per randomised customer ÷ retained value; premium for everyone, 7.5 points, is the sizing reference), sample sizes to detect that effect against zero, the larger sizes or effects needed to show it beats break-even, the decision rule, what the two-arm design cannot measure (each offer's own rate, service reviews) and the three-arm sizes that would.
- *manifest* — model, calibrator and policy versions with SHA-256 of the code that produced the outputs; a test fails if the committed outputs are stale.

## Known limits

Cohort inclusion depends on the outcome (see above), so the very high model metrics describe the observable cohort, and the 6.7% figure is just 41 of 616, not a verified churn rate for the active base. The extract supports a retrospective decision prototype and hypotheses for a pilot; it does not establish live probabilities or ROI. Calibrated risks are in-sample for the historical plan. A recent technical or billing contact means "verify the current issue status": resolution is unknown, and no recorded contact does not rule out a service problem. No out-of-time validation — earlier snapshots are outcome-selected, and the December snapshot has no observed future labels. Churn-registry completeness through 30 November is assumed. Benefits are scenario economics; consent, contact limits and offer eligibility are unknown in the supplied data. The extract looks like a postpaid, fiber-heavy book; IOH is mostly prepaid, where churn would mean no top-up for 60–90 days, offers would be data bonuses and retained value is far below Rp6M, so the break-even risk (cost ÷ success × value) would be much higher. Those prepaid figures are assumptions to replace with IOH data. The workbench surfaces the same evidence — cohort, out-of-fold scores, plan and approval trail — so the audit path is inspectable in the UI.
