// Floating retention assistant. A small draggable companion that opens a chat
// panel; answers come from /api/chat and stay within this workbench.

const STORE_KEY = "retention-assistant";
const POS_KEY = "retention-assistant-pos";
const TIPS_KEY = "retention-assistant-tips";
const MAX_SEND = 10;
const MAX_CHARS = 2000;
const PAGES = {
  overview: "Overview",
  customers: "Customer explorer",
  agent: "Agent workspace",
  evidence: "Evidence & model",
};
// One nudge per page per session, and the question it asks when clicked.
const PAGE_HELP = {
  overview: ["New here? I can give you a quick tour of this page.", "Give me a quick tour of the Overview page."],
  customers: ["Want to know how to read a customer's risk?", "How do I read the Customer explorer and a customer's detail?"],
  agent: ["I can walk you through making and approving a plan.", "Walk me through making, reviewing and approving a plan."],
  evidence: ["Charts look dense? Ask me how to read them.", "How do I read the charts on Evidence & model?"],
};
const SUGGESTIONS = [
  "How do I make and approve a plan?",
  "Why is IOH-430 high risk?",
  "Simulate Rp5M for 15 customers",
  "Cara baca grafik calibration gimana?",
];
const GREETING =
  "Hi! I'm your guide to this workbench. Ask me what a page or chart means, how to make a plan, why a customer like IOH-430 is high risk, or run a budget what-if. Simulations are never saved or sent to customers.";
const currentPage = () => {
  const hash = location.hash.slice(1);
  return Object.hasOwn(PAGES, hash) ? hash : "overview";
};

const read = (store, key) => {
  try {
    return JSON.parse(store.getItem(key));
  } catch {
    return null;
  }
};
const write = (store, key, value) => {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep the chat in memory only */
  }
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const money = (n) =>
  !n
    ? "Rp 0"
    : Math.abs(n) >= 1e6
    ? `Rp ${(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}m`
    : `Rp ${Math.round(n / 1000)}k`;

function format(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\bIOH-\d{3,4}\b/g,
      (id) => `<button type="button" class="customer-button" data-customer="${id}">${id}</button>`,
    );
}
// [Label](#page) or [Label](#page/Panel title) become buttons that open the
// page and highlight the panel.
const LINK = /\[([^\]\n]{1,80})\]\(#(overview|customers|agent|evidence)(?:\/([^)\n]{1,80}))?\)/g;
function inline(text) {
  let html = "",
    last = 0;
  for (const m of text.matchAll(LINK)) {
    html += format(text.slice(last, m.index));
    html += `<button type="button" class="chat-link" data-goto="${m[2]}" data-section="${esc(m[3] ?? "")}">${esc(m[1].replace(/\*/g, ""))}</button>`;
    last = m.index + m[0].length;
  }
  return html + format(text.slice(last));
}
function markdown(text) {
  const out = [];
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      const tag = bullet[1] ? "ol" : "ul";
      if (list !== tag) {
        if (list) out.push(`</${list}>`);
        out.push(tag === "ol" && bullet[1] !== "1" ? `<ol start="${Number(bullet[1])}">` : `<${tag}>`);
        list = tag;
      }
      out.push(`<li>${inline(bullet[2])}</li>`);
      continue;
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join("");
}

const ACTION_LABELS = {
  premium_offer: "premium",
  basic_offer: "basic",
  technical_review: "technical review",
  billing_review: "billing review",
};
function simulationCard(sim, index) {
  const s = sim.settings;
  const actions = Object.entries(sim.actions)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${ACTION_LABELS[k] ?? k}`)
    .join(" · ");
  return `<div class="sim-card">
    <div class="sim-head"><span>Simulation · retention-v2</span><small>not saved</small></div>
    <dl>
      <div><dt>Budget</dt><dd>${money(s.budget)}</dd></div>
      <div><dt>Customers</dt><dd>${sim.customers} / ${s.maxCustomers}</dd></div>
      <div><dt>Spend</dt><dd>${money(sim.total_cost)}</dd></div>
      <div><dt>Scenario net</dt><dd>${money(sim.scenario_net_benefit)}</dd></div>
    </dl>
    <p>${esc(actions || "No eligible actions within these limits")}</p>
    <p class="sim-assumptions">Success ${Math.round(s.basicSuccess * 100)}% basic / ${Math.round(s.premiumSuccess * 100)}% premium · retained value ${money(s.retainedValue)}</p>
    <button type="button" class="sim-apply" data-sim="${index}">Open in agent workspace</button>
  </div>`;
}

const PET = (id) => `<svg viewBox="0 0 56 56" aria-hidden="true">
  <defs><radialGradient id="${id}" cx="34%" cy="28%" r="78%"><stop offset="0" stop-color="#b44c6e"/><stop offset="1" stop-color="#741633"/></radialGradient></defs>
  <circle cx="28" cy="28" r="28" fill="url(#${id})"/>
  <ellipse cx="14.5" cy="33.5" rx="3.8" ry="2.3" fill="#f4b6c9" opacity=".6"/>
  <ellipse cx="41.5" cy="33.5" rx="3.8" ry="2.3" fill="#f4b6c9" opacity=".6"/>
  <g class="pet-eye"><ellipse cx="20.5" cy="25" rx="4.8" ry="5.8" fill="#fff"/><circle class="pet-pupil" cx="20.5" cy="25.8" r="2.6" fill="#2b0713"/></g>
  <g class="pet-eye"><ellipse cx="35.5" cy="25" rx="4.8" ry="5.8" fill="#fff"/><circle class="pet-pupil" cx="35.5" cy="25.8" r="2.6" fill="#2b0713"/></g>
  <path d="M23.5 36q4.5 3.8 9 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>
</svg>`;

let messages = read(sessionStorage, STORE_KEY) ?? [];
let available = null;
let pending = false;
let open = false;

const root = document.createElement("div");
root.className = "assistant";
root.innerHTML = `
  <div class="pet-tip" role="status" hidden><button type="button" class="pet-tip-body"><span></span><strong>Show me →</strong></button><button type="button" class="pet-tip-close" aria-label="Dismiss tip">×</button></div>
  <button type="button" class="pet" aria-label="Open retention assistant" aria-expanded="false" aria-controls="assistant-panel">${PET("pet-fill")}<span class="pet-label" aria-hidden="true">Ask AI</span><span class="pet-badge" hidden></span></button>
  <section class="chat-panel" id="assistant-panel" role="dialog" aria-label="Retention assistant" hidden>
    <header class="chat-head">
      <span class="chat-avatar">${PET("pet-fill-small")}</span>
      <div><strong>Retention assistant</strong><small>Your guide to this workbench</small></div>
      <button type="button" class="chat-icon" data-chat="reset" aria-label="Start a new chat" title="New chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button type="button" class="chat-icon" data-chat="close" aria-label="Close assistant" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </header>
    <div class="chat-log" aria-live="polite"></div>
    <form class="chat-form">
      <textarea rows="1" maxlength="${MAX_CHARS}" placeholder="Ask about a page, a customer or a budget…" aria-label="Message"></textarea>
      <button type="submit" class="chat-send" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </form>
    <p class="chat-note">AI answers can be wrong. Numbers come from the workbench tools.</p>
  </section>`;
document.body.append(root);

const pet = root.querySelector(".pet");
const panel = root.querySelector(".chat-panel");
const log = root.querySelector(".chat-log");
const form = root.querySelector(".chat-form");
const input = form.querySelector("textarea");
const badge = root.querySelector(".pet-badge");
const tip = root.querySelector(".pet-tip");

function save() {
  write(sessionStorage, STORE_KEY, messages.slice(-30));
}

function render() {
  const items = [
    available === false ? "" : `<div class="msg bot">${markdown(GREETING)}</div>`,
    ...messages.map((m, i) =>
      m.role === "user"
        ? `<div class="msg user">${esc(m.content)}</div>`
        : `<div class="msg bot${m.error ? " error" : ""}">${markdown(m.content)}${(m.simulations ?? [])
            .slice(-2)
            .map((s, j) => simulationCard(s, `${i}:${j}`))
            .join("")}${m.error ? `<button type="button" class="chat-retry" data-chat="retry">Try again</button>` : ""}</div>`,
    ),
  ];
  if (!messages.length && available !== false)
    items.push(
      `<div class="chat-chips"><button type="button" class="chip-main" data-ask="${esc(PAGE_HELP[currentPage()][1])}">Explain this page</button>${SUGGESTIONS.map((s) => `<button type="button" data-ask="${esc(s)}">${esc(s)}</button>`).join("")}</div>`,
    );
  if (available === false)
    items.push(
      `<div class="chat-off">The assistant is not configured on this deployment. Set <code>DEEPSEEK_API_KEY</code> on the Worker to enable it; the dashboard and policy planner still work.</div>`,
    );
  if (pending) items.push(`<div class="msg bot typing" aria-label="Assistant is thinking"><i></i><i></i><i></i></div>`);
  log.innerHTML = items.join("");
  log.scrollTop = log.scrollHeight;
  input.disabled = available === false;
  form.querySelector(".chat-send").disabled = pending || available === false;
  root.classList.toggle("thinking", pending);
}

// Keep the request small: the last few turns, under the API's 16 KB body limit.
function payload() {
  const turns = messages
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  let recent = turns.slice(-MAX_SEND);
  while (recent.length > 1 && (recent[0].role !== "user" || JSON.stringify(recent).length > 12000))
    recent = recent.slice(1);
  return { messages: recent, page: currentPage() };
}

async function send(text) {
  const content = text.trim();
  if (!content || pending || available === false) return;
  messages = messages.filter((m) => !m.error);
  messages.push({ role: "user", content: content.slice(0, MAX_CHARS) });
  pending = true;
  save();
  render();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) available = false;
    if (!res.ok) throw new Error(data.error || "The assistant could not answer.");
    messages.push({ role: "assistant", content: data.answer, simulations: data.simulations ?? [] });
  } catch (e) {
    messages.push({ role: "assistant", content: e.message || "Network error.", error: true });
  } finally {
    pending = false;
    save();
    render();
    if (!open) badge.hidden = false;
  }
}

function retry() {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  messages = messages.filter((m) => !m.error);
  messages.pop();
  send(lastUser.content);
}

// ---- Position: draggable, snaps to the nearest side, remembered per browser.
const PET_SIZE = () => pet.offsetWidth || 56;
let pos = read(localStorage, POS_KEY) ?? { side: "right", bottom: 24 };
function place() {
  const max = window.innerHeight - PET_SIZE() - 16;
  pos.bottom = Math.min(Math.max(pos.bottom, 16), Math.max(16, max));
  root.style.setProperty("--pet-bottom", `${pos.bottom}px`);
  root.dataset.side = pos.side;
  if (open) placePanel();
}
function placePanel() {
  if (window.innerWidth <= 640) {
    panel.style.top = panel.style.bottom = "";
    return;
  }
  const h = Math.min(620, window.innerHeight - 32);
  const petTop = window.innerHeight - pos.bottom - PET_SIZE();
  const lower = petTop + PET_SIZE() / 2 > window.innerHeight / 2;
  let top = lower ? window.innerHeight - pos.bottom - h : petTop;
  top = Math.min(Math.max(top, 16), window.innerHeight - h - 16);
  panel.style.height = `${h}px`;
  panel.style.top = `${top}px`;
}

let drag = null;
let suppressClick = false;
pet.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const r = pet.getBoundingClientRect();
  drag = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
  pet.setPointerCapture(e.pointerId);
});
pet.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  drag.moved = true;
  root.classList.add("dragging");
  const left = Math.min(Math.max(e.clientX - drag.dx, 8), window.innerWidth - PET_SIZE() - 8);
  const top = Math.min(Math.max(e.clientY - drag.dy, 8), window.innerHeight - PET_SIZE() - 8);
  pet.style.left = `${left}px`;
  pet.style.top = `${top}px`;
});
const endDrag = (e) => {
  if (!drag) return;
  if (drag.moved) {
    const r = pet.getBoundingClientRect();
    pos = {
      side: r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right",
      bottom: window.innerHeight - r.bottom,
    };
    write(localStorage, POS_KEY, pos);
    pet.style.left = pet.style.top = "";
    root.classList.remove("dragging");
    place();
    suppressClick = true;
  }
  drag = null;
  if (e.pointerId !== undefined && pet.hasPointerCapture(e.pointerId)) pet.releasePointerCapture(e.pointerId);
};
pet.addEventListener("pointerup", endDrag);
pet.addEventListener("pointercancel", endDrag);
pet.addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  if (e.key === "ArrowLeft") pos.side = "left";
  if (e.key === "ArrowRight") pos.side = "right";
  if (e.key === "ArrowUp") pos.bottom += 40;
  if (e.key === "ArrowDown") pos.bottom -= 40;
  place();
  write(localStorage, POS_KEY, pos);
});
window.addEventListener("resize", place);

// ---- Eyes follow the pointer a little; the pet blinks on its own via CSS.
let frame = 0;
window.addEventListener("pointermove", (e) => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const r = pet.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2),
      dy = e.clientY - (r.top + r.height / 2),
      d = Math.hypot(dx, dy) || 1;
    root.style.setProperty("--look-x", `${((dx / d) * Math.min(d / 80, 1) * 1.8).toFixed(2)}px`);
    root.style.setProperty("--look-y", `${((dy / d) * Math.min(d / 80, 1) * 2).toFixed(2)}px`);
  });
});

// ---- Open / close.
async function checkAvailable() {
  if (available !== null) return;
  try {
    const res = await fetch("/api/assistant");
    available = res.ok ? (await res.json()).available !== false : null;
  } catch {
    available = null;
  }
  render();
}
function setOpen(next) {
  open = next;
  panel.hidden = !open;
  root.classList.toggle("open", open);
  document.body.classList.toggle("assistant-open", open);
  pet.setAttribute("aria-expanded", String(open));
  pet.setAttribute("aria-label", open ? "Close retention assistant" : "Open retention assistant");
  if (open) {
    badge.hidden = true;
    hideTip();
    placePanel();
    render();
    checkAvailable();
    setTimeout(() => input.focus(), 30);
  }
}
pet.addEventListener("click", () => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  setOpen(!open);
  if (!open) pet.focus();
});

root.addEventListener("click", (e) => {
  // On phones the dimmed backdrop belongs to the root element.
  if (e.target === root && open) setOpen(false);
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.chat === "close") {
    setOpen(false);
    pet.focus();
  }
  if (b.dataset.chat === "reset" && !pending) {
    messages = [];
    save();
    render();
    input.focus();
  }
  if (b.dataset.chat === "retry") retry();
  if (b.dataset.ask) send(b.dataset.ask);
  if (b.dataset.sim) {
    const [i, j] = b.dataset.sim.split(":").map(Number);
    const sim = messages[i]?.simulations?.slice(-2)[j];
    if (sim) window.dispatchEvent(new CustomEvent("retention:apply-settings", { detail: sim.settings }));
  }
  if (b.classList.contains("pet-tip-close")) hideTip();
  if (b.classList.contains("pet-tip-body")) {
    hideTip();
    setOpen(true);
    send(PAGE_HELP[currentPage()][1]);
  }
  if (b.dataset.goto) {
    const section = b.dataset.section;
    if (window.innerWidth <= 640) setOpen(false);
    // No "explain this page" nudge for a page the chat just sent them to.
    write(sessionStorage, TIPS_KEY, [...(read(sessionStorage, TIPS_KEY) ?? []), b.dataset.goto]);
    if (b.dataset.goto === currentPage()) {
      highlight(section);
    } else {
      location.hash = b.dataset.goto;
      setTimeout(() => highlight(section), 120);
    }
  }
});

// Scroll to a panel, card or button by its visible title and flash it.
function highlight(section) {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const want = (section ?? "").trim().toLowerCase();
  if (!want) return window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  const nodes = [...document.querySelectorAll("#main h2, #main .metric .label, #main button, #main summary, #main label")];
  const text = (n) => n.textContent.replace(/\s+/g, " ").trim().toLowerCase();
  const hit =
    nodes.find((n) => text(n) === want) ??
    nodes.find((n) => text(n).startsWith(want)) ??
    nodes.find((n) => text(n).includes(want));
  if (!hit) return;
  if (hit.tagName === "SUMMARY") hit.parentElement.open = true;
  const target = hit.matches("button, summary, label") ? hit : (hit.closest(".metric, .panel") ?? hit);
  // Step the chat out of the way when it would cover what we point at.
  if (open) {
    const p = panel.getBoundingClientRect(),
      t = target.getBoundingClientRect();
    if (t.left < p.right && t.right > p.left) setOpen(false);
  }
  target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  target.classList.remove("tour-flash");
  void target.offsetWidth;
  target.classList.add("tour-flash");
  setTimeout(() => target.classList.remove("tour-flash"), 2600);
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  if (!text.trim() || pending) return;
  input.value = "";
  grow();
  send(text);
});
const grow = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
};
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open && !document.querySelector("dialog[open]")) {
    setOpen(false);
    pet.focus();
  }
});

// ---- Page nudges: a short offer to explain each page, once per session.
let tipTimer = 0;
function hideTip() {
  tip.hidden = true;
  root.classList.remove("tipping");
  clearTimeout(tipTimer);
}
function maybeTip(delay) {
  const page = currentPage();
  const seen = read(sessionStorage, TIPS_KEY) ?? [];
  if (seen.includes(page) || seen.includes("muted")) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (open || currentPage() !== page) return;
    write(sessionStorage, TIPS_KEY, [...seen, page]);
    tip.querySelector(".pet-tip-body span").textContent = PAGE_HELP[page][0];
    tip.hidden = false;
    root.classList.add("tipping");
    tipTimer = setTimeout(hideTip, 9000);
  }, delay);
}
tip.querySelector(".pet-tip-close").addEventListener("click", () =>
  write(sessionStorage, TIPS_KEY, [...(read(sessionStorage, TIPS_KEY) ?? []), "muted"]),
);
window.addEventListener("hashchange", () => {
  hideTip();
  maybeTip(900);
  if (open && !messages.length) render();
});
maybeTip(1500);

place();
render();
