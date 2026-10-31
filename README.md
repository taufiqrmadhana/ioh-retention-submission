# Customer Retention — IOH Technical Test

Churn analysis and budget-aware retention planning for the supplied telco extract: point-in-time cohort, out-of-fold model evidence, a deterministic policy, and a bounded tool-calling agent that proposes actions for human review. Nothing is executed against customers.

IOH already has a churn model. The contribution here is the decision layer that could take its scores: who is eligible for which action, what fits the budget, and how to measure whether the action creates incremental margin. The recommendation is to validate frozen incumbent scores on a complete later cohort, then test a budget-constrained mixed-offer policy against current retention practice with the same scores, eligibility, budget and capacity. Discretionary service reviews are a separate test or an explicit business constraint; ordinary service obligations continue independently. The logistic model is a transparent baseline for the demo; nothing here shows it beats IOH's model or current retention practice, neither of which was supplied.

**Demo:** [indosat.madgun.us](https://indosat.madgun.us)

## Layout

- `data/` — the three supplied datasets.
- `retention/analysis.py` — cohort construction, features, model evaluation, calibration check, out-of-fold scores.
- `retention/policy.py` — action eligibility, costs, budget and capacity allocation.
- `retention/decisions.py` — decision diagnostics: break-even, allocation comparison, strategy comparison, pilot sizing.
- `retention/agent.py` — tool-calling agent over the analysis and policy.
- `web/` — the workbench frontend (vanilla JS, no build step). `web/policy.js` is the JS port of the policy, shared by the browser and the worker.
- `worker/` — Cloudflare Worker: serves `web/`, exposes `/api/*`, owns validation, approval state and the agent call.
- `web/assistant.js` + `worker/assistant.js` — the floating chat assistant (`/api/chat`). It answers questions about this project, guides users through each page (`worker/guide.js`, with links that jump to and highlight a panel), and runs read-only what-if simulations through the same policy; it cannot save, approve or execute plans. Uses the same `DEEPSEEK_API_KEY` as the agent.
- `outputs/` — generated artefacts; `intelligence.json` (scores, no labels) and `report.json` (evaluation) are served by the API; `cohort.csv` and `manifest.json` are committed for reproducibility.
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
uv run python -m retention agent "Prepare a retention proposal for Bandung." --region Bandung
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

Decision date 01 Nov 2025, outcome window [01 Nov, 01 Dec). The cohort is the 208 customers with an October usage row who had not churned by 1 Nov; 408 other not-yet-churned records have no October row and are excluded, while every recorded November churner has one. The 19.7% rate describes this observable cohort, not the whole active base. Features are computed strictly before the snapshot; resolution status is excluded because it has no historical timestamp. Customers are split 75/25 inside one cohort, preprocessing is fit on train only, and raw demo scores come from five-fold out-of-fold logistic regression. Primary historical pricing uses nested held-out smoothed-isotonic risks: neither a customer's model fit nor their calibration fit sees that customer's label. The all-data calibration map is retained as a fitted artifact for future scoring and an exploratory historical sensitivity. The default policy makes no discretionary service reservation (`review_share=0`); it chooses positive-value basic/premium offers exactly within budget and capacity, after eligibility checks. An optional `review_share` (0 to 50%) represents an explicit operational constraint, with review benefit counted as zero until measured. Net benefit = calibrated risk × assumed prevention × retained value − cost. The 20%/50% rates mean assumed prevention among customers who would otherwise churn; they are not measured uplift. The user selects structured scope controls (contact type, region, internet type); the backend enforces that exact scope on scoped agent tool calls and evaluates every customer in it. Proposals require approval and record a simulation only. Unknown consent is not permission to contact: live consent, issue status and offer eligibility must be verified before outreach.

## Decision diagnostics

`outputs/report.json` carries these checks next to the plan:

- *cohort_flow* — who is excluded from the cohort and why.
- *subgroups* — churn, score and recall by gender and region, with recall measured at one cohort-wide top-20% cutoff. A per-group quota would cap Bandung (12 slots for 25 churners), so groups are compared at the shared cutoff.
- *calibration_check* — sigmoid, isotonic and smoothed isotonic are fitted without each evaluated customer's label and compared on Brier and log-loss. Smoothed isotonic improves nested out-of-fold Brier and log-loss but not the 52-customer holdout, so the evidence is mixed and the map is provisional. Nested held-out risks now drive the historical replay; five per-fold maps can reorder customers, so raw OOF rank remains a separate descriptive ranking. The one-map all-data refit is intended for future scoring and is in-sample when applied back to this cohort. `plan_impact` compares both paths: the held-out mixed-offer replay returns Rp17.29M of scenario net value versus Rp17.38M for the fitted-map sensitivity, yet only 4 of 10 customer IDs overlap (one identical customer-action pair). Twelve customers cross the 12.5% gate, and 32 share the top fitted risk. Similar aggregate value does not establish a uniquely optimal customer list. Calibration-method and policy choices were explored on this extract, so this replay is still internal evidence and requires untouched later validation.
- *rule_check* — the four-condition segment (month-to-month, tenure under 6 months, fiber, electronic check) holds every November churner. With "no recent contact" added it flags 40 customers with 38 churners, close to the model's top 20%. The model's added value is the order inside the segment and a graded score for spend; the segment was found by looking at all labels, so it is optimistic. Both rules are also in the holdout comparison.
- *economics.sensitivity* — the same policy re-planned across assumed success rates and retained values. Break-even is found by bisection on the re-planned plan, because the plan's mix changes between grid points.
- *economics.optimisation* — exact dynamic-programming budget/capacity allocation, checked against an independent mixed-integer optimiser under the same discretionary review constraint. The exact planner can leave capacity unused when that creates more assumed value; the check verifies the assumed optimization problem, not intervention effects.
- *economics.strategies* — the recommended mixed-offer policy, an explicit 30% review-reservation scenario, premium-only and basic-only targeting at equal budget, capacity and eligibility, plus an uncapped threshold rule with and without service/billing checks. At Rp3M / 10 customers, the held-out default uses 5 premium + 5 basic offers for Rp17.29M scenario net value. Reserving 3 billing reviews yields 6 premium + 1 basic + 3 reviews, spending Rp2.925M for Rp15.64M scenario net value. The Rp1.66M opportunity cost requires about 0.277 extra retained customers across those reviews (9.2 points each) to repay it. Reviews have unmeasured benefit counted as zero; a quota therefore needs a business owner or separate evidence. Recent contacts first require verification of current issue status, rather than automatic incentives.
- *economics.premium_stress* — the same comparison as premium prevention falls. The exact mixed-offer policy can substitute basic offers; favorable values still depend on the assumed rates and customer value.
- *economics.decision_curve* — net benefit against treating everyone and treating no one.
- *pilot* — the offer-policy pilot for `docs/pilot.md`: population, horizon, break-even definition (incremental cost per randomised customer ÷ retained value; premium for everyone, 7.5 points, is the sizing reference), sample sizes to detect that effect against zero, the larger sizes or effects needed to show it beats break-even, the decision rule, what the two-arm design cannot measure (each offer's own rate, service reviews) and the three-arm sizes that would.
- *manifest* — model, calibrator and policy versions, source-data and implementation/dependency fingerprints, and a shared run identifier. Isolated regeneration checks the committed report and intelligence against their inputs and code; it does not establish validity beyond the supplied extract.

## Known limits

Cohort inclusion depends on the outcome (see above), so the very high model metrics describe the observable cohort, and the 6.7% figure is just 41 of 616, not a verified churn rate for the active base. The extract supports a retrospective decision prototype and hypotheses for a pilot; it does not establish live probabilities or ROI. Nested historical calibration excludes each customer's own label, but model/calibration/policy development on this extract remains exploratory. The all-data refit is in-sample when replayed on the same customers. Candidate identities are unstable across calibration paths even when aggregate scenario value is similar. A recent technical or billing contact means "verify the current issue status": resolution is unknown, and no recorded contact does not rule out a service problem. No out-of-time validation — earlier snapshots are outcome-selected, and the December snapshot has no observed future labels. Churn-registry completeness through 30 November is assumed. Benefits are scenario economics; consent, contact limits and offer eligibility are unknown in the supplied data. The extract looks like a postpaid, fiber-heavy book; IOH is mostly prepaid, where churn would mean no top-up for 60–90 days, offers would be data bonuses and retained value is far below Rp6M, so the break-even risk (cost ÷ success × value) would be much higher. Those prepaid figures are assumptions to replace with IOH data. The workbench surfaces the same evidence — cohort, out-of-fold scores, plan and approval trail — so the audit path is inspectable in the UI.

## Decision record and agent evaluation

The prototype's proposed record links the score and evidence to eligibility, action economics, versions and approval state. Before a live pilot, extend that contract with feature-as-of time, 30-day score horizon, score expiry, proposal/campaign ID, immutable experiment assignment, comparator version, actual delivered treatment and cost, and the date outcomes become mature. A 90-day outcome is measured separately from the score's 30-day horizon. Assignment is not proof of delivery, and delayed churn is not automatically durable retention. Synthetic demo feedback remains excluded from training.

Tool-contract tests establish allowed arguments, arithmetic and state validation. Natural-language task success is a separate evaluation: use English and Indonesian prompts for region/contact scopes, unsupported constraints, conflicting goals and misleading instructions, then report scope correctness, unsupported claims, completion, latency and cost. No measured live-model task-accuracy result is claimed by the mocked tests. The workbench requires user-selectable structured scope and enforces the same contact/region/internet scope on scoped tools in both runtimes. A prompt asking to change scope should direct the user to update those controls without submitting a plan. The backend does not independently parse natural-language intent; a user must correct a mismatch in the visible scope before requesting a plan. Bilingual scripted mismatch tests verify this enforcement, not live-model interpretation accuracy.

With `DEEPSEEK_API_KEY` already configured in the shell, run the seven real-prompt
cases with:

```bash
node scripts/evaluate-agent.mjs
```

The cases cover English/Indonesian requests, region/contact scopes, unsupported
filters, conflicting goals and misleading instructions. The current environment
has no configured key, so the saved `outputs/agent-evaluation.json` has status
`not_run`; no live-model task-accuracy result is available. The harness records
scope enforcement, expected submission, latency and token counts. Manually review
task completion and unsupported claims before reporting accuracy; claim flags are
heuristics. Cost remains `null` unless reconciled with provider billing, since
tokens alone do not establish billed cost. Scripted guardrail tests remain
separate from these natural-language evaluation results.
