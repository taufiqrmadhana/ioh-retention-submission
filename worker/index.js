import { DurableObject } from "cloudflare:workers";
import intelligence from "../outputs/intelligence.json";
import report from "../outputs/report.json";
import { buildPlan, compareActions, settings, validatePlan } from "../web/policy.js";
import { runAgent, validateScope } from "./agent.js";
import { cleanHistory, runAssistant } from "./assistant.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

// A private Durable Object binding isolates each visitor's proposals and audit
// trail. Global/IP counters are also durable; no in-memory-only rate limiting.
export class RetentionStore extends DurableObject {
  async fetch(request) {
    const { op, ...args } = await request.json();
    if (op === "rate") {
      return this.ctx.storage.transaction(async (tx) => {
        const previous = await tx.get("counter");
        const count = previous?.window === args.window ? previous.count : 0;
        if (count >= args.limit) return json({ allowed: false }, 429);
        await tx.put("counter", { window: args.window, count: count + 1 });
        return json({ allowed: true });
      });
    }
    if (op === "save") {
      const plan = {
        ...args.plan,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      };
      const key = `plan:${plan.id}`;
      const existing = await this.ctx.storage.list({ prefix: "plan:" });
      if (existing.size >= 50)
        return json(
          { error: "This session has reached its 50-plan limit." },
          429,
        );
      await this.ctx.storage.put(key, plan);
      await this.event(plan.id, "plan_created", {
        total_cost: plan.total_cost,
        items: plan.items.length,
        source: args.source,
      });
      return json(plan);
    }
    if (op === "list") {
      const plans = [
        ...(await this.ctx.storage.list({ prefix: "plan:" })).values(),
      ].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const events = [
        ...(await this.ctx.storage.list({ prefix: "event:" })).values(),
      ].sort((a, b) => b.at.localeCompare(a.at));
      return json({ plans, events });
    }
    if (op === "transition") {
      return this.ctx.storage.transaction(async (tx) => {
        const key = `plan:${args.id}`,
          plan = await tx.get(key);
        if (!plan)
          return json(
            { error: "Plan not found in this browser session." },
            404,
          );
        const target =
          args.action === "approve"
            ? "simulated_approved"
            : args.action === "reject"
              ? "rejected"
              : null;
        if (!target) return json({ error: "Invalid transition" }, 400);
        if (plan.status === target) return json({ ...plan, idempotent: true });
        if (plan.status !== "pending_review")
          return json({ error: "Plan already reviewed." }, 409);
        if (args.acknowledged !== true)
          return json(
            { error: "Acknowledge the review checklist first." },
            400,
          );
        plan.status = target;
        plan.reviewed_at = new Date().toISOString();
        await tx.put(key, plan);
        await tx.put(`event:${crypto.randomUUID()}`, {
          id: crypto.randomUUID(),
          plan_id: plan.id,
          at: plan.reviewed_at,
          kind: target,
          detail: { simulation: true, external_actions: 0 },
        });
        return json(plan);
      });
    }
    if (op === "outcome") {
      const plan = await this.ctx.storage.get(`plan:${args.id}`);
      if (!plan || plan.status !== "simulated_approved")
        return json({ error: "Approve a simulation first." }, 409);
      if (!["retained", "churned", "no_response"].includes(args.outcome))
        return json({ error: "Invalid simulated outcome" }, 400);
      if (!plan.items.some((i) => i.customer_id === args.customer_id))
        return json({ error: "Customer not in plan" }, 400);
      await this.event(args.id, "simulated_outcome", {
        customer_id: args.customer_id,
        outcome: args.outcome,
        synthetic: true,
        training_eligible: false,
      });
      return json({
        recorded: true,
        synthetic: true,
        training_eligible: false,
      });
    }
    if (op === "agent_event") {
      await this.event(null, args.kind, args.detail);
      return json({ recorded: true });
    }
    return json({ error: "Unknown operation" }, 400);
  }
  async event(plan_id, kind, detail) {
    const id = crypto.randomUUID();
    await this.ctx.storage.put(`event:${id}`, {
      id,
      plan_id,
      kind,
      at: new Date().toISOString(),
      detail,
    });
  }
}

async function store(env, name, payload) {
  const stub = env.STORE.get(env.STORE.idFromName(name));
  return stub.fetch(
    new Request("https://store.local", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
}
async function consume(env, name, window, limit) {
  return (await store(env, name, { op: "rate", window, limit })).ok;
}
const sessionId = (request) =>
  request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)retention_session=([a-f0-9-]{36})(?:;|$)/)?.[1] ??
  crypto.randomUUID();

const sha256 = async (text) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

async function runAgentRequest(request, env, session, body) {
  if (!env.DEEPSEEK_API_KEY)
    return json(
      {
        error:
          "Live agent is not configured. The deterministic planner remains available.",
      },
      503,
    );
  if (
    typeof body.prompt !== "string" ||
    body.prompt.trim().length < 5 ||
    body.prompt.length > 1500
  )
    throw new Error("Use a prompt of 5–1500 characters");
  const config = settings(body.settings);
  if (!body.scope) throw new Error("Select contact, region and internet scope controls");
  const scope = validateScope(body.scope, intelligence.customers);
  const ip = await sha256(request.headers.get("CF-Connecting-IP") ?? "local");
  if (
    !(await consume(env, `agent-ip:${ip}`, Math.floor(Date.now() / 600000), 5)) ||
    !(await consume(env, "agent-global", Math.floor(Date.now() / 86400000), 60))
  )
    return json(
      {
        error:
          "Demo AI quota reached. Try later or use the deterministic planner.",
      },
      429,
    );
  const started = Date.now();
  try {
    const result = await runAgent({
      prompt: body.prompt,
      config,
      scope,
      customers: intelligence.customers,
      apiKey: env.DEEPSEEK_API_KEY,
      model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    });
    if (result.plan) {
      validatePlan(result.plan, intelligence.customers);
      const saved = await store(env, session, {
        op: "save",
        plan: {
          ...result.plan,
          agent_trace: result.trace,
          agent_model: result.model,
          token_usage: result.token_usage,
        },
        source: "deepseek",
      });
      if (!saved.ok) return saved;
      result.plan = await saved.json();
    }
    await store(env, session, {
      op: "agent_event",
      kind: "agent_completed",
      detail: {
        model: result.model,
        latency_ms: Date.now() - started,
        token_usage: result.token_usage,
        tool_calls: result.trace.length,
        rejected_calls: result.trace.filter((t) => t.status === "rejected")
          .length,
        plan_submitted: !!result.plan,
      },
    });
    return json(result);
  } catch (e) {
    await store(env, session, {
      op: "agent_event",
      kind: "agent_failed",
      detail: {
        latency_ms: Date.now() - started,
        token_usage: e.token_usage ?? 0,
        error: e.message,
        trace: e.trace ?? [],
      },
    });
    return json(
      {
        error:
          e.name === "TimeoutError"
            ? "AI provider timed out. The deterministic planner is available."
            : e.message,
      },
      502,
    );
  }
}

async function runChatRequest(request, env, body) {
  if (!env.DEEPSEEK_API_KEY)
    return json({ error: "The assistant is not configured on this deployment." }, 503);
  const messages = cleanHistory(body.messages);
  const ip = await sha256(request.headers.get("CF-Connecting-IP") ?? "local");
  if (
    !(await consume(env, `chat-ip:${ip}`, Math.floor(Date.now() / 600000), 20)) ||
    !(await consume(env, "chat-global", Math.floor(Date.now() / 86400000), 400))
  )
    return json({ error: "The assistant is busy. Try again in a few minutes." }, 429);
  try {
    return json(
      await runAssistant({
        messages,
        page: typeof body.page === "string" ? body.page : null,
        customers: intelligence.customers,
        report,
        apiKey: env.DEEPSEEK_API_KEY,
        model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
        baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      }),
    );
  } catch (e) {
    return json(
      {
        error:
          e.name === "TimeoutError"
            ? "The AI provider timed out. Try again."
            : e.message,
      },
      502,
    );
  }
}

async function route(request, env, url, session) {
  if (request.method === "GET") {
    if (url.pathname === "/api/bootstrap")
      return json({
        intelligence,
        report,
        agent_available: !!env.DEEPSEEK_API_KEY,
        model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
      });
    if (url.pathname === "/api/assistant")
      return json({ available: !!env.DEEPSEEK_API_KEY });
    if (url.pathname === "/api/history")
      return store(env, session, { op: "list" });
    if (url.pathname === "/api/customer") {
      const c = intelligence.customers.find(
        (c) => c.customer_id === url.searchParams.get("id"),
      );
      return c
        ? json({ customer: c, actions: compareActions(c) })
        : json({ error: "Unknown customer" }, 404);
    }
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404);

  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin)
    return json({ error: "Cross-origin request rejected" }, 403);
  if (!request.headers.get("Content-Type")?.includes("application/json"))
    return json({ error: "Expected JSON" }, 415);
  if (Number(request.headers.get("Content-Length") ?? 0) > 16384)
    return json({ error: "Request too large" }, 413);
  const raw = await request.text();
  if (raw.length > 16384) return json({ error: "Request too large" }, 413);
  const body = JSON.parse(raw);
  if (!body || Array.isArray(body) || typeof body !== "object")
    throw new Error("Expected a JSON object");
  if (
    !(await consume(
      env,
      `session-rate:${session}`,
      Math.floor(Date.now() / 60000),
      30,
    ))
  )
    return json({ error: "Too many requests; retry in a minute." }, 429);

  switch (url.pathname) {
    case "/api/plan":
      return store(env, session, {
        op: "save",
        plan: buildPlan(intelligence.customers, settings(body.settings)),
        source: "deterministic",
      });
    case "/api/agent":
      return runAgentRequest(request, env, session, body);
    case "/api/chat":
      return runChatRequest(request, env, body);
    case "/api/review":
      return store(env, session, {
        op: "transition",
        id: body.id,
        action: body.action,
        acknowledged: body.acknowledged,
      });
    case "/api/outcome":
      return store(env, session, {
        op: "outcome",
        id: body.id,
        customer_id: body.customer_id,
        outcome: body.outcome,
      });
    default:
      return json({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const session = sessionId(request);
    let response;
    try {
      response = await route(request, env, url, session);
    } catch (e) {
      response = json(
        { error: e instanceof SyntaxError ? "Invalid JSON" : e.message },
        400,
      );
    }
    // Every API response, early rejections included, carries the session cookie.
    const headers = new Headers(response.headers);
    headers.set(
      "Set-Cookie",
      `retention_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${url.protocol === "https:" ? "; Secure" : ""}`,
    );
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
};
