// The worker agent (worker/agent.js) against a scripted provider: no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../../worker/agent.js";

const customer = (id, region, risk, technical = 0, internet = "Fiber optic") => ({
  customer_id: id,
  region,
  risk_score: risk,
  consent: "unknown",
  eligibility: "review_required",
  evidence: ["Fixture"],
  features: { technical_30d: technical, billing_30d: 0, hasInternetService: internet },
});
const CUSTOMERS = [
  customer("TEST-1", "Jakarta", 0.7),
  customer("TEST-2", "Bandung", 0.2, 1, "DSL"),
];

// Replays one list of [tool, args] per round; fills in the latest simulation_id on submit.
function scripted(...rounds) {
  let round = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (message) =>
      new Response(
        JSON.stringify({ choices: [{ message }], usage: { total_tokens: 10 } }),
      );
    if (round >= rounds.length) return reply({ content: "Done." });
    const calls = rounds[round++].map(([name, args], index) => {
      if (name === "submit_retention_plan") {
        const simulation = body.messages
          .filter((m) => m.role === "tool")
          .map((m) => JSON.parse(m.content))
          .reverse()
          .find((r) => r && r.simulation_id);
        args = { simulation_id: simulation.simulation_id, rationale: "ok" };
      }
      return {
        id: `${round}-${index}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      };
    });
    return reply({ tool_calls: calls });
  };
}

const run = (fetcher, config = {}) =>
  runAgent({
    prompt: "Prepare a plan",
    config,
    customers: CUSTOMERS,
    apiKey: "test",
    fetcher,
  });

test("backend plans every customer in scope, including ones the model never read", async () => {
  const result = await run(
    scripted(
      [["simulate_retention_plan", { focus: "all", region: "any", internet: "any" }]],
      [["submit_retention_plan", {}]],
    ),
  );
  assert.equal(result.plan.candidates_evaluated, 2);
  assert.deepEqual(
    Object.fromEntries(result.plan.items.map((i) => [i.customer_id, i.action])),
    { "TEST-1": "premium_offer", "TEST-2": "technical_review" },
  );
  assert.ok(result.plan.items.every((i) => i.executable === false));
});

test("scope filters by contact type and region", async () => {
  const result = await run(
    scripted(
      [["simulate_retention_plan", { focus: "no_contact", region: "Jakarta", internet: "any" }]],
      [["submit_retention_plan", {}]],
    ),
  );
  assert.deepEqual(result.plan.scope, { focus: "no_contact", region: "Jakarta", internet: "any" });
  assert.deepEqual(result.plan.items.map((i) => i.customer_id), ["TEST-1"]);
});

test("unknown regions, empty scopes, hand-picked IDs and unread customers are rejected", async () => {
  const result = await run(
    scripted([
      ["simulate_retention_plan", { focus: "all", region: "Atlantis", internet: "any" }],
      ["simulate_retention_plan", { focus: "billing", region: "any", internet: "any" }],
      ["simulate_retention_plan", { customer_ids: ["TEST-1"] }],
      ["get_customer_context", { customer_id: "TEST-2" }],
      ["send_sms", { customer_id: "TEST-1" }],
    ]),
  );
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.trace.map((t) => t.status),
    Array(5).fill("rejected"),
  );
});

test("budget and capacity come from the user settings, not the model", async () => {
  const result = await run(
    scripted(
      [["simulate_retention_plan", { focus: "all", region: "any", internet: "any" }]],
      [["submit_retention_plan", {}]],
    ),
    { budget: 50000, maxCustomers: 1 },
  );
  assert.equal(result.plan.total_cost, 50000);
  assert.deepEqual(result.plan.items.map((i) => i.action), ["technical_review"]);
});

test("scope filters by internet type", async () => {
  const result = await run(
    scripted(
      [["simulate_retention_plan", { focus: "all", region: "any", internet: "Fiber optic" }]],
      [["submit_retention_plan", {}]],
    ),
  );
  assert.equal(result.plan.candidates_evaluated, 1);
  assert.deepEqual(result.plan.items.map((i) => i.customer_id), ["TEST-1"]);
});

// Small evaluations of what the agent says against what the backend recorded.
const replies = (...messages) => {
  let round = 0;
  return async () =>
    new Response(
      JSON.stringify({ choices: [{ message: messages[Math.min(round++, messages.length - 1)] }] }),
    );
};

test("a false approval claim without a plan reports no plan and is flagged", async () => {
  const result = await run(replies({ content: "Approved. Premium offers were sent to TEST-1." }));
  assert.equal(result.plan, null);
  assert.equal(result.outcome.status, "no_plan_submitted");
  assert.ok(result.claim_flags.some((f) => f.includes("approval")));
});

test("the outcome shows the scope the backend planned, whatever the text claims", async () => {
  const fetcher = scripted([
    ["simulate_retention_plan", { focus: "all", region: "any", internet: "any" }],
  ]);
  let simulation;
  const result = await runAgent({
    prompt: "Plan Bandung only",
    config: {},
    customers: CUSTOMERS,
    apiKey: "test",
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      const tool = body.messages.filter((m) => m.role === "tool").at(-1);
      if (!tool) return fetcher(url, init);
      simulation = JSON.parse(tool.content);
      const args = {
        simulation_id: simulation.simulation_id,
        rationale: "Approved for Bandung; this will reduce churn by half.",
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: "s", type: "function", function: { name: "submit_retention_plan", arguments: JSON.stringify(args) } }] } }],
        }),
      );
    },
  });
  assert.equal(result.outcome.status, "pending_review");
  assert.deepEqual(result.outcome.scope, { focus: "all", region: "any", internet: "any" });
  assert.equal(result.outcome.total_cost, result.plan.total_cost);
  assert.equal(result.claim_flags.length, 2);
});

test("a provider failure raises with the trace so far", async () => {
  let round = 0;
  const fetcher = async (url, init) =>
    round++ === 0
      ? scripted([["get_priority_customers", { focus: "all", region: "any", internet: "any", limit: 1 }]])(url, init)
      : new Response("boom", { status: 500 });
  await assert.rejects(run(fetcher), (e) => /Provider request failed/.test(e.message) && e.trace.length === 1);
});
