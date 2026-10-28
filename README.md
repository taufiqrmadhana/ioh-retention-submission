# Customer Retention — IOH Technical Test

Churn analysis and budget-aware retention planning for the supplied telco extract: point-in-time cohort, out-of-fold model evidence, a deterministic policy, and a bounded tool-calling agent that proposes actions for human review. Nothing is executed against customers.

**Demo:** [indosat.madgun.us](https://indosat.madgun.us)

## Layout

- `data/` — the three supplied datasets.
- `retention/analysis.py` — cohort construction, features, model evaluation, out-of-fold scores.
- `retention/policy.py` — action eligibility, costs, budget and capacity allocation.
- `retention/agent.py` — tool-calling agent over the analysis and policy.
- `web/` — the workbench frontend (vanilla JS, no build step).
- `worker/` — API layer: serves `web/`, exposes `/api/*`, owns validation, approval state and the agent call.
- `outputs/` — generated artefacts; `intelligence.json` (scores, no labels) and `report.json` (evaluation) are committed because the API serves them.
- `tests/` — analysis, policy and agent checks.

## Run

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

## Method in one paragraph

Decision date 01 Nov 2025, outcome window [01 Nov, 01 Dec). Features are computed strictly before the snapshot; resolution status is excluded because it has no historical timestamp. Customers are split 75/25 inside one cohort, preprocessing is fit on train only, and demo scores come from five-fold out-of-fold logistic regression. The policy reserves up to 30% of capacity for service reviews, then fills offers by greedy marginal net benefit per rupiah within budget. Net benefit = risk × assumed prevention × retained value − cost; rates and retained value are assumptions, not measured uplift. Agent proposals require approval and record a simulation only.

## Known limits

No out-of-time validation — earlier snapshots are outcome-selected, and the December snapshot has no observed future labels. Churn-registry completeness through 30 November is assumed. Benefits are scenario economics; consent, contact limits and offer eligibility are unknown in the supplied data. See the methodology notes in the workbench for the audit and monitoring plan.
