// Drives the real workbench (web/) in Chromium against a small mock of the
// worker API. Skipped when Playwright is not installed:
//   npm i --no-save playwright && npx playwright install chromium
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { buildPlan, settings } from "../../web/policy.js";
import { INTELLIGENCE } from "./fixtures.js";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  chromium = null;
}
const skip = chromium ? false : "Playwright is not installed";

const web = new URL("../../web/", import.meta.url);
const report = JSON.parse(
  await readFile(new URL("../../outputs/report.json", import.meta.url)),
);
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

let server, browser, origin;
before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/bootstrap")
      return send(res, 200, { intelligence: { customers: INTELLIGENCE }, report, agent_available: false, model: "test" });
    if (path === "/api/history") return send(res, 200, { plans: [], events: [] });
    if (path === "/api/assistant") return send(res, 200, { available: false });
    if (path === "/api/plan") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const plan = buildPlan(INTELLIGENCE, settings(JSON.parse(raw).settings));
      return send(res, 200, { ...plan, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      const body = await readFile(new URL(file, web));
      send(res, 200, body, TYPES[file.slice(file.lastIndexOf("."))] ?? "text/plain");
    } catch {
      send(res, 404, { error: "Not found" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function openAgentPage() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/#agent`);
  await page.waitForSelector("#budget");
  return { page, errors };
}
const setValue = (page, selector, value) =>
  page.$eval(
    selector,
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
const visit = async (page, tab) => {
  await page.click(`.nav-button[data-tab="${tab}"]`);
  await page.waitForFunction((t) => location.hash === `#${t}`, tab);
};

test("a budget change survives switching pages and drives the overview", { skip }, async () => {
  const { page, errors } = await openAgentPage();
  await setValue(page, "#budget", "1500000");
  await setValue(page, "#capacity", "4");
  await visit(page, "overview");
  const budgetCard = await page.textContent(".metric:nth-child(4)");
  assert.match(budgetCard, /1\.500\.000/);
  assert.match(budgetCard, /Capacity: 4 customers/);
  await visit(page, "agent");
  assert.equal(await page.inputValue("#budget"), "1500000");
  assert.equal(await page.inputValue("#capacity"), "4");
  await page.click("#deterministic");
  await page.waitForSelector("#plan-result .plan-summary");
  assert.match(await page.textContent("#plan-result"), /Saved budget: Rp\s?1\.500\.000/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("an empty or out-of-range assumption keeps the last valid settings", { skip }, async () => {
  const { page, errors } = await openAgentPage();
  await page.click("details summary");
  await setValue(page, "#premium-success", "40");
  await setValue(page, "#basic-success", "");
  await setValue(page, "#value", "99999999");
  assert.ok(await page.$(".controls.invalid"));
  await visit(page, "overview");
  await visit(page, "agent");
  await page.click("details summary");
  assert.equal(await page.inputValue("#premium-success"), "40");
  assert.equal(await page.inputValue("#basic-success"), "20");
  assert.equal(await page.inputValue("#value"), "6000000");
  assert.deepEqual(errors, []);
  await page.close();
});
