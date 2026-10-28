# Customer Retention — IOH Technical Test

Python implementation for customer churn analysis and retention planning: prepare the supplied data, evaluate churn models, and use a DeepSeek agent to propose actions within a budget.

**Demo:** [retention.madgun.us](https://retention.madgun.us)

## Code

- `data/` — the three supplied datasets.
- `retention/analysis.py` — data preparation, features, model evaluation and out-of-fold scores.
- `retention/policy.py` — action eligibility, costs and budget allocation.
- `retention/agent.py` — tool-calling agent using the analysis and policy.
- `tests/` — analytical and decisioning checks.

## Run

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --frozen
uv run python -m retention analyze
uv run python -m retention plan --budget 3000000 --limit 10
```

Set `DEEPSEEK_API_KEY` in your environment to run the agent:

```bash
uv run python -m retention agent "Prioritize technical reviews and compare retention offers."
uv run pytest -q
```

Results, scores and proposals are generated in `outputs/`. Model evaluation uses a selected historical cohort, not an out-of-time test. Retention benefits are scenario assumptions; agent proposals require review and do not execute customer actions.
