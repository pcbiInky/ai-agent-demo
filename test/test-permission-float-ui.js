#!/usr/bin/env node
// 审批浮层（输入框上方第二审批入口）的 jsdom 回归测试
// 覆盖：pending 进浮层/自动通过不进、双入口同步禁用与收敛、
//       超过 5 项只渲染最新 5 张 + 溢出入口、permission-resolved 移除、
//       快照同步（loadHistory/syncFloatPerms）、404 已决收敛与未知失效
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
  "perm-float-layer", "input-area",
  "session-id-display", "new-session-btn", "session-list", "mention-hints",
  "character-statuses", "chat-title-text", "chat-subtitle", "edit-session-meta-btn",
  "settings-btn", "settings-modal", "settings-form", "settings-error",
  "settings-save-btn", "settings-cancel-btn", "settings-title", "settings-subtitle",
  "settings-skills-panel", "thread-panel", "thread-messages", "thread-close-btn",
  "skill-trace-list", "skill-list",
  "diff-panel", "diff-panel-title", "diff-panel-sub", "diff-panel-content", "diff-close-btn",
  "diff-nav", "diff-nav-prev", "diff-nav-count", "diff-nav-next", "diff-resize-handle",
];

// /api/permission-response 的可控行为
let permBehavior = "ok";
let deferredResolve = null;
// /api/pending-permissions 的可控快照
let pendingSnapshot = [];
let pendingFetchCount = 0;
let pendingMode = "sync";
let resolvePendingFetch = null;

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
  const ok = (payload) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  if (url.includes("/api/permission-response")) {
    if (permBehavior === "reject") return Promise.reject(new Error("network down"));
    if (permBehavior === "deferred") {
      return new Promise((r) => {
        deferredResolve = () => r({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      });
    }
    if (permBehavior === "http500") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    if (permBehavior === "http404-resolved") {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: "权限请求不存在或已过期", resolved: { behavior: "deny", message: "任务已被终止" } }) });
    }
    if (permBehavior === "http404-unknown") {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: "权限请求不存在或已过期" }) });
    }
    return ok({ ok: true });
  }
  if (url.includes("/api/pending-permissions")) {
    pendingFetchCount += 1;
    if (pendingMode === "deferred") {
      return new Promise((r) => {
        resolvePendingFetch = (payload) => r({ ok: true, status: 200, json: () => Promise.resolve(payload) });
      });
    }
    return ok({ pending: pendingSnapshot });
  }
  if (url.includes("/api/history")) {
    return ok({
      sessionId: "sess-float",
      createdAt: 0,
      messages: [{ id: "u1", role: "user", text: "干活", timestamp: 1 }],
      lastSeq: 1,
      activeThinking: [],
      pendingApprovals: pendingSnapshot,
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
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.sessionStorage.setItem("sessionId", "sess-float");
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

const floatCard = (requestId) => document.getElementById(`perm-float-${requestId}`);
const floatCardCount = () => document.querySelectorAll(".perm-float-card").length;
const execCard = (requestId) => document.getElementById(`perm-card-${requestId}`);
const olderChip = () => {
  const b = document.querySelector(".perm-float-older");
  return b && !b.hidden ? b : null;
};
const newerChip = () => {
  const b = document.querySelector(".perm-float-newer");
  return b && !b.hidden ? b : null;
};

function emitPerm(es, requestId, extra = {}) {
  es.emit("permission", {
    requestId,
    character: "YYF",
    toolName: "Write",
    input: { file_path: `/tmp/${requestId}.txt`, content: "x" },
    timestamp: Date.now(),
    messageId: "u1",
    status: "pending",
    ...extra,
  });
}

(async () => {
  try {
    await waitFor(() => esInstances.length >= 1);
    const es = esInstances[0];
    assert(!!es, "init 建立 SSE 连接");

    es.emit("thinking", { character: "YYF", messageId: "u1" });
    await waitFor(() => !!document.getElementById("thinking-YYF-u1"));

    // ── 1. 手动 pending 进浮层；自动通过不进 ──
    emitPerm(es, "rq-a");
    await waitFor(() => !!floatCard("rq-a"));
    assert(!!floatCard("rq-a"), "pending 请求出现在浮层");
    assert(!!execCard("rq-a"), "执行记录卡片同时存在（双入口）");
    assert(!!floatCard("rq-a").querySelector(".perm-float-wait")?.textContent.includes("等待"), "浮层卡片显示等待时长");

    es.emit("permission", { requestId: "rq-auto", character: "YYF", toolName: "Read", input: { file_path: "/tmp/a" }, messageId: "u1", status: "allow", resolutionMessage: "安全命令默认授权" });
    es.emit("permission-resolved", { requestId: "rq-auto", behavior: "allow", message: "安全命令默认授权" });
    await sleep(150);
    assert(!floatCard("rq-auto"), "自动通过的请求不进浮层");
    assert(floatCardCount() === 1, "浮层仅有手动待审批项");

    // ── 2. 浮层审批：提交中双入口按钮禁用；成功后浮层移除、执行记录折叠标记 ──
    permBehavior = "deferred";
    const respondPromise = dom.window.eval('respondPermission("rq-a", "allow")');
    await waitFor(() => deferredResolve !== null);
    const floatBtns = [...(floatCard("rq-a")?.querySelectorAll(".perm-btn") || [])];
    const execBtns = [...(execCard("rq-a")?.querySelectorAll(".perm-btn") || [])];
    assert(floatBtns.length > 0 && floatBtns.every((b) => b.disabled), "提交中浮层按钮禁用");
    assert(execBtns.length > 0 && execBtns.every((b) => b.disabled), "提交中执行记录按钮同时禁用");
    deferredResolve();
    permBehavior = "ok";
    await respondPromise;
    await waitFor(() => !floatCard("rq-a"));
    assert(!floatCard("rq-a"), "审批成功后浮层卡片移除");
    assert(!!execCard("rq-a")?.querySelector(".perm-resolved-label.allowed"), "执行记录标记已允许");
    assert(!!execCard("rq-a")?.closest(".tool-records-content"), "执行记录卡片归入折叠组");

    // ── 3. permission-resolved SSE（另一入口/超时/终止）同步移除浮层 ──
    emitPerm(es, "rq-b");
    await waitFor(() => !!floatCard("rq-b"));
    es.emit("permission-resolved", { requestId: "rq-b", behavior: "deny", message: "任务已被终止" });
    await waitFor(() => !floatCard("rq-b"));
    assert(!floatCard("rq-b"), "permission-resolved 事件移除浮层卡片");
    assert(!!execCard("rq-b")?.querySelector(".perm-resolved-label.denied"), "执行记录标记已拒绝");

    // ── 4. 6 项并发：同屏始终最多 5 张，溢出按每批 5 张翻页 ──
    for (const id of ["rq-1", "rq-2", "rq-3", "rq-4", "rq-5", "rq-6"]) {
      emitPerm(es, id);
      await sleep(10);
    }
    await waitFor(() => floatCardCount() === 5);
    assert(floatCardCount() === 5, `同屏最多渲染 5 张（实际 ${floatCardCount()}）`);
    assert(!floatCard("rq-1"), "最旧一项不在最新一批");
    assert(!!olderChip()?.textContent.includes("另有 1 项待审批"), "溢出提示显示另有 1 项");
    olderChip().click();
    await sleep(50);
    assert(floatCardCount() === 1 && !!floatCard("rq-1"), "翻到较早一批：每批最多 5 张，此批仅 1 张");
    assert(!!newerChip(), "翻页后出现返回最新入口");
    assert(!olderChip(), "已无更早任务时不再显示查看较早入口");
    newerChip().click();
    await sleep(50);
    assert(floatCardCount() === 5 && !floatCard("rq-1"), "返回最新一批后恢复 5 张");

    // 处理最旧一项后，被挤出可见集合的下一项自动补位
    permBehavior = "ok";
    await dom.window.eval('respondPermission("rq-2", "allow")');
    await waitFor(() => !!floatCard("rq-1"));
    assert(!!floatCard("rq-1") && floatCardCount() === 5, "处理一项后较早任务补位进可见集合");

    // ── 5. 404 已决：以服务端结果收敛，不作为可重试 ──
    permBehavior = "http404-resolved";
    emitPerm(es, "rq-c");
    await waitFor(() => !!floatCard("rq-c"));
    await dom.window.eval('respondPermission("rq-c", "allow")');
    await waitFor(() => !floatCard("rq-c"));
    assert(!floatCard("rq-c"), "404 已决后浮层移除");
    assert(!!execCard("rq-c")?.querySelector(".perm-resolved-label.denied"), "按服务端首次决策（deny）刷新执行记录");

    // ── 6. 404 未知（如服务重启）：标记已处理并触发快照同步 ──
    permBehavior = "http404-unknown";
    pendingSnapshot = [];
    const beforeFetch = pendingFetchCount;
    emitPerm(es, "rq-d");
    await waitFor(() => !!floatCard("rq-d"));
    await dom.window.eval('respondPermission("rq-d", "allow")');
    await waitFor(() => !floatCard("rq-d"));
    assert(!floatCard("rq-d"), "404 未知后浮层移除");
    assert(!!execCard("rq-d")?.querySelector(".perm-resolved-label.expired"), "执行记录标记已处理（中性）");
    assert(pendingFetchCount > beforeFetch, "404 未知触发服务端快照同步");

    // ── 7. 快照同步：以服务端 pending 为权威增删 ──
    emitPerm(es, "rq-e");
    await waitFor(() => !!floatCard("rq-e"));
    pendingSnapshot = [
      { requestId: "rq-f", character: "YYF", toolName: "Bash", input: { command: "ls" }, timestamp: Date.now(), status: "pending" },
    ];
    dom.window.eval("syncFloatPermsFromServer()");
    await waitFor(() => !!floatCard("rq-f") && !floatCard("rq-e"));
    assert(!!floatCard("rq-f"), "快照中遗漏的待审批补进浮层");
    assert(!floatCard("rq-e"), "快照中已不存在的项从浮层移除");

    // ── 8. 交错：旧快照响应晚于已决事件到达，不得把已决任务放回浮层 ──
    pendingMode = "deferred";
    const staleSync = dom.window.eval("syncFloatPermsFromServer()");
    await waitFor(() => resolvePendingFetch !== null);
    emitPerm(es, "rq-stale");
    await waitFor(() => !!floatCard("rq-stale"));
    permBehavior = "ok";
    await dom.window.eval('respondPermission("rq-stale", "allow")');
    assert(!floatCard("rq-stale"), "已决后浮层先移除");
    // 服务端在审批前取好的旧快照此刻才返回，仍把 rq-stale 列为 pending
    resolvePendingFetch({
      pending: [{ requestId: "rq-stale", character: "YYF", toolName: "Write", input: { file_path: "/tmp/rq-stale.txt" }, timestamp: Date.now(), status: "pending" }],
    });
    resolvePendingFetch = null;
    pendingMode = "sync";
    await staleSync;
    await sleep(150);
    assert(!floatCard("rq-stale"), "旧快照晚到不把已决任务放回浮层");

    // ── 9. 两个并发快照 A/B 乱序返回：更新的 B 先应用后，更早的 A 整体丢弃 ──
    emitPerm(es, "rq-x");
    await waitFor(() => !!floatCard("rq-x"));
    pendingMode = "deferred";
    const syncA = dom.window.eval("syncFloatPermsFromServer()");
    await waitFor(() => resolvePendingFetch !== null);
    const resolveA = resolvePendingFetch;
    resolvePendingFetch = null;
    const syncB = dom.window.eval("syncFloatPermsFromServer()");
    await waitFor(() => resolvePendingFetch !== null);
    const resolveB = resolvePendingFetch;
    resolvePendingFetch = null;
    // B（更新，服务端已无 pending）先返回：经快照移除 rq-x（本地无已决记录，tombstone 挡不住）
    resolveB({ pending: [] });
    await syncB;
    assert(!floatCard("rq-x"), "更新快照 B 先应用，移除已不在服务端的项");
    // A（更早，仍列 rq-x 为 pending）最后返回：必须整体丢弃
    resolveA({ pending: [{ requestId: "rq-x", character: "YYF", toolName: "Write", input: { file_path: "/tmp/rq-x.txt" }, timestamp: Date.now(), status: "pending" }] });
    await syncA;
    await sleep(150);
    assert(!floatCard("rq-x"), "更早的快照 A 乱序晚到被丢弃，不覆盖更新快照的结果");
    // 乱序之后新发起的快照仍正常应用
    pendingMode = "sync";
    pendingSnapshot = [{ requestId: "rq-z", character: "YYF", toolName: "Bash", input: { command: "ls" }, timestamp: Date.now(), status: "pending" }];
    dom.window.eval("syncFloatPermsFromServer()");
    await waitFor(() => !!floatCard("rq-z"));
    assert(!!floatCard("rq-z"), "乱序之后新发起的快照仍正常应用");
  } catch (e) {
    console.error(e);
    failed += 1;
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
