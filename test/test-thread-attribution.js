#!/usr/bin/env node
// 线程归属回归测试
// 覆盖：SendMessage 传入旧 threadId 时不得复用（需用 replyTo 证实父子关系）、
//       合法续聊仍沿用原线程、历史重建不把旧回复算到最新消息头上、实时与刷新后计数一致
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

let JSDOM = null;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (err) {
  console.error(`无法加载 jsdom（请先 npm install）：${err.message}`);
  process.exit(1);
}

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const dataDir = path.join(projectRoot, "role-system", "data");
const sessionsDir = path.join(dataDir, "sessions");
const logsDir = path.join(projectRoot, "chat-logs");

const server = require("../server");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }
  console.error(`FAIL ${label}`);
  failed += 1;
}

let baseUrl = "";

async function postJson(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function writeSession(sessionId, memberIds) {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  const members = {};
  for (const roleId of memberIds) members[roleId] = { providerSessionId: null };
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, title: "test", members, workingDirectory: "" })
  );
}

function readLog(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(logsDir, `${sessionId}.json`), "utf-8"));
}

function cleanup(sessionId) {
  fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
  fs.rmSync(path.join(sessionsDir, `${sessionId}.json`), { force: true });
}

function seedLog(sessionId, messages) {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, createdAt: Date.now(), messages }, null, 2)
  );
}

const byText = (log, text) => log.messages.find((m) => m.text === text);

async function main() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${tempServer.address().port}`;

  try {
    server.__test.ensureRoleSystemInitializedForTests();
    const roles = server.__test.roleStore.listRoles();
    const roleA = roles[0];
    const roleB = roles[1];
    assert(!!roleA && !!roleB, `取到两个角色用于测试（${roleA?.name} / ${roleB?.name}）`);

    // ── 纯函数：threadId 续用判定 ──
    const isContinuation = server.__test.isThreadContinuation;
    assert(typeof isContinuation === "function", "server 导出 isThreadContinuation 供回归");
    const fixture = [
      { id: "root1", threadId: "root1", aiMentions: [roleB.name] },
      { id: "child1", threadId: "root1", depth: 1, replyTo: "root1" },
      { id: "user2" },
    ];
    assert(isContinuation(fixture, "root1", "root1") === true, "回复线程根消息：沿用该线程");
    assert(isContinuation(fixture, "root1", "child1") === true, "回复线程内消息：沿用该线程");
    assert(isContinuation(fixture, "root1", "user2") === false, "回复线程外的新用户消息：不得沿用旧线程");
    assert(isContinuation(fixture, "root1", null) === false, "无 replyTo 时不得沿用旧线程");
    assert(isContinuation(fixture, "ghost", "ghost") === false, "threadId 在日志中不存在时不沿用");

    // ── 路由级：新一轮召唤传入旧 threadId ──
    const staleSession = `session-${crypto.randomUUID()}`;
    const rootId = `root-${crypto.randomUUID()}`;
    const userMsgId = `user-${crypto.randomUUID()}`;
    cleanup(staleSession);
    writeSession(staleSession, [roleA.id, roleB.id]);
    seedLog(staleSession, [
      { id: rootId, role: "assistant", character: roleA.name, text: "第一轮召唤", timestamp: 1, threadId: rootId, aiMentions: [roleB.name] },
      { id: `reply-${crypto.randomUUID()}`, role: "assistant", character: roleB.name, text: "第一轮回复", timestamp: 2, threadId: rootId, depth: 1, replyTo: rootId },
      { id: userMsgId, role: "user", text: "铲屎官的新指令", timestamp: 3 },
    ]);

    const staleRequestId = `rq-${crypto.randomUUID()}`;
    server.__test.storeApproval(staleRequestId, staleSession, roleA.name, "SendMessage", userMsgId);
    const staleRes = await postJson("/api/mcp-send-message", {
      requestId: staleRequestId,
      text: "新一轮回复",
      atTargets: [roleB.name],
      threadId: rootId,
    });
    assert(staleRes.ok, `旧 threadId 的新一轮 SendMessage 成功（${staleRes.status} ${JSON.stringify(staleRes.body)}）`);
    const staleLog = readLog(staleSession);
    const staleMsg = byText(staleLog, "新一轮回复");
    assert(!!staleMsg, "新消息已落盘");
    assert(staleMsg && staleMsg.threadId === staleMsg.id, `新消息以自身 id 开新线程（threadId=${staleMsg?.threadId}，id=${staleMsg?.id}）`);
    assert(staleMsg && staleMsg.threadId !== rootId, "新消息不复用旧线程 id");
    assert(staleMsg && !Object.prototype.hasOwnProperty.call(staleMsg, "depth"), "新一轮召唤为 depth=0（无 depth 字段）");
    assert(Array.isArray(staleMsg?.aiMentions) && staleMsg.aiMentions.includes(roleB.name), "新消息仍能召唤 atTargets");
    assert(staleLog.messages.filter((m) => m.threadId === rootId).length === 2, `旧线程仍只含原有 2 条消息（实际 ${staleLog.messages.filter((m) => m.threadId === rootId).length}）`);

    // ── 路由级：回复线程内消息时沿用原线程 ──
    const contSession = `session-${crypto.randomUUID()}`;
    const contRootId = `root-${crypto.randomUUID()}`;
    const contChildId = `child-${crypto.randomUUID()}`;
    cleanup(contSession);
    writeSession(contSession, [roleA.id, roleB.id]);
    seedLog(contSession, [
      { id: contRootId, role: "assistant", character: roleA.name, text: "召唤", timestamp: 1, threadId: contRootId, aiMentions: [roleB.name] },
      { id: contChildId, role: "assistant", character: roleB.name, text: "被回复的线程消息", timestamp: 2, threadId: contRootId, depth: 1, replyTo: contRootId },
    ]);
    const contRequestId = `rq-${crypto.randomUUID()}`;
    server.__test.storeApproval(contRequestId, contSession, roleA.name, "SendMessage", contChildId);
    const contRes = await postJson("/api/mcp-send-message", {
      requestId: contRequestId,
      text: "线程内继续回复",
      atTargets: [],
      threadId: contRootId,
    });
    assert(contRes.ok, `线程内续聊 SendMessage 成功（${contRes.status}）`);
    const contMsg = byText(readLog(contSession), "线程内继续回复");
    assert(contMsg && contMsg.threadId === contRootId, "replyTo 能证实父子关系时沿用原线程");

    cleanup(staleSession);
    cleanup(contSession);

    // ── 前端历史重建：旧日志里同 threadId 的新消息不得抢走回复 ──
    await runFrontendChecks(roleA, roleB);
  } catch (err) {
    console.error(err.stack || err.message || String(err));
    failed += 1;
  } finally {
    await new Promise((resolve) => tempServer.close(resolve));
    try {
      server.__test.closeServer();
    } catch {
      // ignore
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// 等价复现线上日志：线程根 + 13 条历史回复 + 一条复用旧 threadId 的新消息 + 一条空文本 error
function buildHistoryFixture(roleA, roleB) {
  const threadId = "thread-root";
  const messages = [
    { id: "u0", role: "user", text: "最初的用户消息", timestamp: 1 },
    { id: threadId, role: "assistant", character: roleA.name, text: "第一轮召唤", timestamp: 2, threadId, aiMentions: [roleB.name], replyTo: "u0" },
  ];
  for (let i = 0; i < 13; i++) {
    messages.push({
      id: `old-reply-${i}`,
      role: "assistant",
      character: i % 2 === 0 ? roleB.name : roleA.name,
      text: `此前往返 ${i + 1}`,
      timestamp: 3 + i,
      threadId,
      depth: 1,
      replyTo: i === 0 ? threadId : `old-reply-${i - 1}`,
    });
  }
  messages.push({ id: "u1", role: "user", text: "铲屎官的新指令", timestamp: 100 });
  messages.push({
    id: "new-msg",
    role: "assistant",
    character: roleA.name,
    text: "新一轮消息（复用了旧 threadId）",
    timestamp: 101,
    threadId,
    aiMentions: [roleB.name],
    replyTo: "u1",
  });
  messages.push({
    id: "empty-error",
    role: "error",
    character: roleB.name,
    text: "",
    timestamp: 102,
    threadId,
    depth: 1,
    replyTo: "new-msg",
  });
  return { sessionId: "sess-thread", createdAt: 0, messages, lastSeq: 200, activeThinking: [] };
}

async function runFrontendChecks(roleA, roleB) {
  const appJs = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const IDS = [
    "messages", "message-input", "send-btn", "chat-container", "jump-to-latest-btn",
    "session-id-display", "new-session-btn", "session-list", "mention-hints",
    "character-statuses", "chat-title-text", "chat-subtitle", "edit-session-meta-btn",
    "settings-btn", "settings-modal", "settings-form", "settings-error",
    "settings-save-btn", "settings-cancel-btn", "settings-title", "settings-subtitle",
    "settings-skills-panel", "thread-panel", "thread-messages", "thread-close-btn",
    "skill-trace-list", "skill-list",
    "diff-panel", "diff-panel-title", "diff-panel-sub", "diff-panel-content", "diff-close-btn",
    "diff-nav", "diff-nav-prev", "diff-nav-count", "diff-nav-next", "diff-resize-handle",
  ];

  const historyPayload = buildHistoryFixture(roleA, roleB);
  const esInstances = [];
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      esInstances.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
    close() {}
  }

  const stubFetch = (url) => {
    const ok = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    if (url.includes("/api/history")) return ok(historyPayload);
    if (url.includes("/api/characters")) return ok({ characters: { [roleA.name]: { cli: "a", id: roleA.id }, [roleB.name]: { cli: "b", id: roleB.id } } });
    if (url.includes("/members") && !url.includes("runtime-metrics")) return ok({ members: [] });
    if (url.includes("/api/sessions/") && url.includes("skill-traces")) return ok({ traces: [] });
    if (url.includes("/api/sessions/") && !url.includes("runtime-metrics")) return ok({ session: { title: "t", workingDirectory: "/x" } });
    if (url.includes("/api/skills")) return ok({ skills: [] });
    if (url.includes("/api/sessions") && !url.includes("runtime-metrics")) return ok({ sessions: [] });
    return ok({});
  };

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>${IDS.map((id) => `<div id="${id}"></div>`).join("")}</body></html>`,
    {
      runScripts: "outside-only",
      url: "http://localhost/",
      beforeParse(window) {
        window.fetch = stubFetch;
        window.EventSource = MockEventSource;
        window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
        window.sessionStorage.setItem("sessionId", "sess-thread");
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
  const barOf = (msgId) => document.querySelector(`[data-msg-id="${msgId}"] .thread-reply-bar`);
  const barText = (msgId) => barOf(msgId)?.textContent || "";

  await waitFor(() => document.querySelector('[data-msg-id="new-msg"]'));
  assert(!!document.querySelector('[data-msg-id="thread-root"]'), "历史重建渲染出线程根消息");
  assert(/13 条回复/.test(barText("thread-root")), `计数条留在真正的线程根上（${barText("thread-root") || "无"}）`);
  assert(!barOf("new-msg"), "复用旧 threadId 的新消息不再挂着 13 条历史回复");
  assert(!barOf("u1"), "用户消息不挂计数条");

  document.querySelector('[data-msg-id="thread-root"] .thread-reply-bar').click();
  await waitFor(() => document.getElementById("thread-panel").classList.contains("open")
    || document.getElementById("thread-messages").children.length > 0);
  const panelText = document.getElementById("thread-messages").textContent;
  assert(panelText.includes("此前往返 1") && panelText.includes("此前往返 13"), "线程面板展示 13 条历史回复");
  assert(!panelText.includes("新一轮消息"), "线程面板不把复用旧 threadId 的新消息当成本线程内容");

  // 空文本 error 不算有效回复：13 条而非 14 条
  assert(!/14 条回复/.test(barText("thread-root")), "空文本 error 记录不计入回复数");

  // ── 实时链路：新召唤开新线程，计数与刷新后一致 ──
  const es = esInstances[0];
  es.emit("reply", {
    character: roleA.name, messageId: "u1", replyId: "live-root", text: "实时新一轮召唤",
    timestamp: 300, threadId: "live-root", aiMentions: [roleB.name],
  });
  await waitFor(() => document.querySelector('[data-msg-id="live-root"]'));
  es.emit("reply", {
    character: roleB.name, messageId: "u1", replyId: "live-reply", text: "实时回复",
    timestamp: 301, threadId: "live-root", depth: 1,
  });
  await waitFor(() => barOf("live-root"));
  assert(/1 条回复/.test(barText("live-root")), `实时新线程只计自己的回复（${barText("live-root")}）`);
  assert(!/13 条回复/.test(barText("live-root")), "实时新线程不继承历史回复");
  assert(/13 条回复/.test(barText("thread-root")), "历史线程计数不受实时新线程影响");

  es.emit("reply", {
    character: roleB.name, messageId: "u1", replyId: "live-empty", text: "",
    timestamp: 302, threadId: "live-root", depth: 1,
  });
  await sleep(200);
  assert(/1 条回复/.test(barText("live-root")), `实时空文本回复不计入（${barText("live-root")}）`);
}

main();
