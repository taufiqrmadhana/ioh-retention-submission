"""Command-line entry points for analysis and retention planning."""

import argparse
import json
import sys
from pathlib import Path

OUTPUTS = Path(__file__).resolve().parents[1] / "outputs"


def save(name, value):
    OUTPUTS.mkdir(exist_ok=True)
    path = OUTPUTS / name
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(
        description="Churn analysis and retention planning"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "analyze", help="Prepare data, evaluate models and export scores"
    )
    for command in ("plan", "agent"):
        sub = commands.add_parser(command)
        sub.add_argument("--budget", type=int, default=3_000_000, help="Budget in IDR")
        sub.add_argument("--limit", type=int, default=10, help="Maximum customers")
        if command == "agent":
            sub.add_argument("prompt", help="Retention objective for the agent")
    args = parser.parse_args()

    if args.command == "analyze":
        from .analysis import main as analyze

        analyze()
        return

    intelligence = OUTPUTS / "intelligence.json"
    if not intelligence.exists():
        parser.error("Run 'python -m retention analyze' first.")
    customers = json.loads(intelligence.read_text())["customers"]
    config = {"budget": args.budget, "max_customers": args.limit}
    if args.command == "plan":
        from .policy import build_plan

        plan = build_plan(customers, config)
        print(f"{len(plan['items'])} customers | Cost: Rp{plan['total_cost']:,}")
        print(f"Saved to {save('plan.json', plan)}")
    else:
        from .agent import run_agent

        try:
            result = run_agent(
                prompt=args.prompt,
                customers=customers,
                config=config,
                on_event=lambda event: print(
                    f"{event['step']}. {event['tool']}: {event['status']}"
                ),
            )
        except Exception as error:
            if hasattr(error, "trace"):
                save(
                    "agent_error.json",
                    {
                        "error": str(error),
                        "trace": error.trace,
                        "token_usage": getattr(error, "token_usage", 0),
                    },
                )
            raise
        print(result["answer"])
        print(f"Saved to {save('agent_result.json', result)}")
        if result.get("plan") is None:
            raise RuntimeError(
                "Agent completed without a submitted proposal; inspect the trace."
            )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
