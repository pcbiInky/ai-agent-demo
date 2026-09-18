#!/usr/bin/env node
// 工具执行记录二级折叠（.tool-records）的回归测试（jsdom 模拟实时 SSE）
// 覆盖：pending 卡片留在折叠外、allow/deny 成功后归组计数、
//       HTTP 非 2xx 与 fetch reject 时按钮恢复不折叠可重试、
//       重复 permission-resolved SSE 不重复卡片或计数
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (err) {
  console.error(`❌ 无法加载 jsdom（请先 npm install）：${err.message}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

const IDS = [
  "messages", "message-input", "send-btn", "chat-container", "jump-to-latest-btn",
  "session-id-display", "new-session-btn", "session-list", "mention-hints",
  "character-statuses", "chat-title-text", "chat-subtitle", "edit-session-meta-btn",
  "settings-btn", "settings-modal", "settings-form", "settings-error",
  "settings-save-btn", "settings-cancel-btn", "settings-title", "settings-subtitle",
  "settings-skills-panel", "thread-panel", "thread-messages", "thread-close-btn",
  "skill-trace-list", "skill-list",
];

// /api/permission-response 的可控行为：ok / http500 / reject
let permBehavior = "ok";

const esInstances = [];
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    esInstances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

function stubFetch(url) {
  const ok = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  if (url.includes("/api/permission-response")) {
    if (permBehavior === "reject") return Promise.reject(new Error("network down"));
    if (permBehavior === "http500") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    return ok({ ok: true });
  }
  if (url.includes("/api/history")) {
    return ok({
      sessionId: "sess-fold",
      createdAt: 0,
      messages: [{ id: "u1", role: "user", text: "干活", timestamp: 1 }],
      lastSeq: 1,
      activeThinking: [],
    });
  }
  if (url.includes("/api/characters")) return ok({ characters: { "YYF": { cli: "codex", id: "r1" } } });
  if (url.includes("/members") && !url.includes("runtime-metrics")) return ok({ members: [] });
  if (url.includes("/api/sessions/") && url.includes("skill-traces")) return ok({ traces: [] });
  if (url.includes("/api/sessions/") && !url.includes("runtime-metrics")) return ok({ session: { title: "t", workingDirectory: "/x" } });
  if (url.includes("/api/skills")) return ok({ skills: [] });
  if (url.includes("/api/sessions") && !url.includes("runtime-metrics")) return ok({ sessions: [] });
  return ok({});
}

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>${IDS.map((id) => `<div id="${id}"></div>`).join("")}</body></html>`,
  {
    runScripts: "outside-only",
    url: "http://localhost/",
    beforeParse(window) {
      window.fetch = stubFetch;
      window.EventSource = MockEventSource;
      window.sessionStorage.setItem("sessionId", "sess-fold");
      if (!window.crypto || !window.crypto.randomUUID) {
        window.crypto = { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) };
      }
    },
  }
);

dom.window.eval(appJs);
const { document } = dom.window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, n = 80) => {
  for (let i = 0; i < n; i++) { await sleep(50); try { if (fn()) return true; } catch { /* retry */ } }
  return false;
};

const inFold = (requestId) => {
  const card = document.getElementById(`perm-card-${requestId}`);
  return !!card && !!card.closest(".tool-records-content");
};
const foldSummary = () => document.querySelector(".tool-records-summary")?.textContent || "";
const cardCount = () => document.querySelectorAll(".perm-card").length;

(async () => {
  try {
    await waitFor(() => esInstances.length >= 1);
    const es = esInstances[0];
    assert(!!es, "init 建立 SSE 连接");

    // 开始一轮执行，建立 thinking 容器
    es.emit("thinking", { character: "YYF", messageId: "u1" });
    await waitFor(() => !!document.getElementById("thinking-YYF-u1"));
    assert(!!document.getElementById("thinking-YYF-u1"), "thinking 容器已创建");

    // ── 1. pending 的非 Bash 工具卡片留在折叠外 ──
    es.emit("permission", { requestId: "rq-edit", character: "YYF", toolName: "Edit", input: { file_path: "/x.js", old_string: "a", new_string: "b" }, messageId: "u1" });
    await waitFor(() => !!document.getElementById("perm-card-rq-edit"));
    const editCard = document.getElementById("perm-card-rq-edit");
    assert(!!editCard, "Edit 待审批卡片已渲染");
    assert(!!editCard && !!editCard.closest(".perm-container"), "pending Edit 卡片在 perm-container 内");
    assert(!inFold("rq-edit"), "pending Edit 卡片不在折叠组内");
    assert(!document.querySelector(".tool-records"), "尚无已处理卡片时不创建折叠组");
    const editBtns = editCard ? [...editCard.querySelectorAll(".perm-btn")] : [];
    assert(editBtns.length === 2 && editBtns.every((b) => !b.disabled), "pending 卡片按钮可点");

    // ── 2. allow / deny 成功后都进入折叠组，计数正确 ──
    permBehavior = "ok";
    dom.window.eval('respondPermission("rq-edit", "allow")');
    await waitFor(() => inFold("rq-edit"));
    assert(inFold("rq-edit"), "allow 成功后 Edit 卡片进入折叠组");
    assert(foldSummary() === "工具执行记录 · 1 条", `折叠组计数 1: ${foldSummary()}`);
    assert(!!editCard.querySelector(".perm-resolved-label.allowed"), "Edit 卡片标记已允许");

    es.emit("permission", { requestId: "rq-write", character: "YYF", toolName: "Write", input: { file_path: "/y.js", content: "x" }, messageId: "u1" });
    await waitFor(() => !!document.getElementById("perm-card-rq-write"));
    assert(!inFold("rq-write"), "pending Write 卡片留在折叠外");
    dom.window.eval('respondPermission("rq-write", "deny")');
    await waitFor(() => inFold("rq-write"));
    assert(inFold("rq-write"), "deny 成功后 Write 卡片也进入折叠组");
    assert(foldSummary() === "工具执行记录 · 2 条", `折叠组计数 2: ${foldSummary()}`);
    const writeCard = document.getElementById("perm-card-rq-write");
    assert(!!writeCard && !!writeCard.querySelector(".perm-resolved-label.denied"), "Write 卡片标记已拒绝");

    // ── 3. HTTP 4xx/5xx 与 fetch reject：按钮恢复、不归组、可重试 ──
    es.emit("permission", { requestId: "rq-bash", character: "YYF", toolName: "Bash", input: { command: "rm -rf /tmp/x" }, messageId: "u1" });
    await waitFor(() => !!document.getElementById("perm-card-rq-bash"));

    permBehavior = "http500";
    dom.window.eval('respondPermission("rq-bash", "allow")');
    await waitFor(() => !!document.querySelector("#perm-card-rq-bash .perm-send-fail"));
    const bashCard = document.getElementById("perm-card-rq-bash");
    assert(!inFold("rq-bash"), "HTTP 500 后卡片不归组");
    assert(!!bashCard && !!bashCard.querySelector(".perm-send-fail"), "HTTP 500 后显示失败提示");
    assert(!!bashCard && [...bashCard.querySelectorAll(".perm-btn")].every((b) => !b.disabled), "HTTP 500 后按钮恢复可点");
    assert(foldSummary() === "工具执行记录 · 2 条", "HTTP 500 后折叠组计数不变");

    permBehavior = "reject";
    dom.window.eval('respondPermission("rq-bash", "allow")');
    await waitFor(() => !!document.querySelector("#perm-card-rq-bash .perm-send-fail"));
    assert(!inFold("rq-bash"), "fetch reject 后卡片不归组");
    assert(!!bashCard && [...bashCard.querySelectorAll(".perm-btn")].every((b) => !b.disabled), "fetch reject 后按钮恢复可点");

    // 重试成功：提示清除并归组
    permBehavior = "ok";
    dom.window.eval('respondPermission("rq-bash", "allow")');
    await waitFor(() => inFold("rq-bash"));
    assert(inFold("rq-bash"), "重试成功后卡片归组");
    assert(!bashCard.querySelector(".perm-send-fail"), "重试成功后失败提示被清除");
    assert(foldSummary() === "工具执行记录 · 3 条", `折叠组计数 3: ${foldSummary()}`);

    // ── 4. 成功后重复 permission-resolved SSE：不重复卡片或计数 ──
    const before = cardCount();
    es.emit("permission-resolved", { requestId: "rq-edit", behavior: "allow" });
    es.emit("permission-resolved", { requestId: "rq-edit", behavior: "allow", message: "默认授权" });
    await sleep(150);
    assert(cardCount() === before, "重复 permission-resolved 不产生重复卡片");
    assert(foldSummary() === "工具执行记录 · 3 条", `重复 SSE 后计数仍正确: ${foldSummary()}`);
    assert(document.querySelectorAll(".tool-records").length === 1, "同一容器只保留一个折叠组");
  } catch (e) {
    console.error(e);
    failed += 1;
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
