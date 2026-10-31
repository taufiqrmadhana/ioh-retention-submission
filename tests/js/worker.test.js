import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";

let worker, stateDirectory;
const start = () => unstable_dev("worker/index.js", {
  local: true,
  port: 0,
  inspectorPort: 0,
  persist: true,
  persistTo: stateDirectory,
  logLevel: "none",
  vars: { DEEPSEEK_API_KEY: "" },
  experimental: {
    disableExperimentalWarning: true,
    disableDevRegistry: true,
    watch: false,
  },
});

before(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "retention-worker-test-"));
  worker = await start();
});
after(async () => {
  await worker?.stop();
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
});

const session = () => `retention_session=${crypto.randomUUID()}`;
async function request(path, cookie, body, options = {}) {
  const response = await worker.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function save(cookie) {
  const result = await request("/api/plan", cookie, {
    settings: { budget: 150000, maxCustomers: 1 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "pending_review");
  assert.equal(result.body.items.length, 1);
  return result.body;
}


test("Worker plans and audit events persist across restart and remain session-isolated", async () => {
  const owner = session(), outsider = session();
  const plan = await save(owner);
  const ownHistory = await request("/api/history", owner);
  assert.equal(ownHistory.body.plans[0].id, plan.id);
  assert.equal(ownHistory.body.events[0].kind, "plan_created");
  assert.deepEqual((await request("/api/history", outsider)).body, { plans: [], events: [] });
  assert.equal((await request("/api/review", outsider, {
    id: plan.id, action: "approve", acknowledged: true,
  })).status, 404);
  await worker.stop();
  worker = await start();
  const restored = await request("/api/history", owner);
  assert.equal(restored.body.plans[0].id, plan.id);
  assert.equal(restored.body.events.length, 1);
});


test("Worker requires checklist acknowledgement and records approval once", async () => {
  const cookie = session(), plan = await save(cookie);
  const review = (action, acknowledged) => request("/api/review", cookie, {
    id: plan.id, action, acknowledged,
  });
  assert.equal((await review("approve", false)).status, 400);
  assert.equal((await request("/api/history", cookie)).body.plans[0].status, "pending_review");
  const approved = await review("approve", true);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "simulated_approved");
  const repeated = await review("approve", true);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.idempotent, true);
  assert.equal((await review("reject", true)).status, 409);
  const history = (await request("/api/history", cookie)).body;
  assert.equal(history.events.filter((e) => e.kind === "simulated_approved").length, 1);
  assert.equal(history.events.find((e) => e.kind === "simulated_approved").detail.external_actions, 0);
});


test("Worker outcomes require approval and a plan customer; feedback stays synthetic", async () => {
  const cookie = session(), plan = await save(cookie);
  const outcome = (customer_id, value = "retained") => request("/api/outcome", cookie, {
    id: plan.id, customer_id, outcome: value,
  });
  const customer = plan.items[0].customer_id;
  assert.equal((await outcome(customer)).status, 409);
  assert.equal((await request("/api/review", cookie, {
    id: plan.id, action: "approve", acknowledged: true,
  })).status, 200);
  assert.equal((await outcome("UNKNOWN")).status, 400);
  assert.equal((await outcome(customer, "invented")).status, 400);
  const recorded = await outcome(customer);
  assert.equal(recorded.status, 200);
  assert.deepEqual(recorded.body, { recorded: true, synthetic: true, training_eligible: false });
  const events = (await request("/api/history", cookie)).body.events;
  const feedback = events.filter((e) => e.kind === "simulated_outcome");
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].detail.customer_id, customer);
  assert.equal(feedback[0].detail.training_eligible, false);
});


test("Worker rejects malformed input and enforces its per-session request limit", async () => {
  const cookie = session();
  const malformed = await worker.fetch("/api/plan", {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "Invalid JSON");
  assert.equal((await request("/api/plan", cookie, {}, {
    headers: { Origin: "https://another.example" },
  })).status, 403);
  assert.equal((await request("/api/customer?id=UNKNOWN", cookie)).status, 404);
  let accepted = 0, lastStatus;
  for (let i = 0; i < 61; i++) {
    lastStatus = (await request("/api/review", cookie, {
      id: "missing", action: "approve", acknowledged: true,
    })).status;
    if (lastStatus === 429) break;
    assert.equal(lastStatus, 404);
    accepted++;
  }
  assert.equal(lastStatus, 429);
  assert.ok(accepted >= 30 && accepted <= 60);
  assert.equal((await request("/api/review", session(), {
    id: "missing", action: "approve", acknowledged: true,
  })).status, 404);
});
