#!/usr/bin/env node
// 过程记录恢复 / 折叠 / 嵌入的回归测试（jsdom 模拟刷新与切会话）
// 覆盖：按快照序号建连、已回复+active（主线与 thread 深层）、resync 闭环、
//       旧连接迟到 resync、resync 与切会话并发不串写、未回复 active 终止按钮、完成事件清理
const fs = require("fs");
const path = require("path");

let JSDOM = null;
for (const candidate of ["jsdom", "/Users/inky/code/clowder-ai/node_modules/jsdom"]) {
  try { JSDOM = require(candidate).JSDOM; break; } catch { /* try next */ }
}

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

if (!JSDOM) {
  console.log("⚠️ jsdom 不可用（本机未安装），跳过客户端 DOM 测试");
  process.exit(0);
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

const sessions = {
  // 已回复 + 同 key 仍 active（mcp 时序）；含 thread 深层回复同 key
  "sess-1": {
    messages: [
      { id: "m1", role: "user", text: "问题", timestamp: 1 },
      { id: "p1", role: "permission", requestId: "req1", character: "YYF", toolName: "Bash", input: { command: "ls" }, timestamp: 2, messageId: "m1", status: "allow" },
      { id: "a1", role: "assistant", character: "YYF", text: "主线回复", replyTo: "m1", timestamp: 3, aiMentions: [], verified: true, source: "mcp-tool" },
      { id: "o1", role: "assistant", character: "YYF", text: "thread 发起", replyTo: "m1", timestamp: 4, aiMentions: ["晔晔"], verified: true, threadId: "t1", source: "mcp-tool" },
      { id: "d1", role: "assistant", character: "YYF", text: "thread 深层回复", replyTo: "m1", timestamp: 5, aiMentions: [], verified: true, threadId: "t1", depth: 1, source: "mcp-tool" },
    ],
    lastSeq: 5,
    activeThinking: [{ character: "YYF", messageId: "m1" }],
  },
  // 执行中、未回复（空记录）
  "sess-2": {
    messages: [{ id: "n1", role: "user", text: "另一个会话", timestamp: 1 }],
    lastSeq: 9,
    activeThinking: [{ character: "金渐层k", messageId: "n1" }],
  },
};

let sess1FetchCount = 0;
let sess2FetchCount = 0;
let gateResolve = null;
const gate = new Promise((r) => { gateResolve = r; });

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
  if (url.includes("/api/history")) {
    if (url.includes("sess-1")) {
      sess1FetchCount += 1;
      if (sess1FetchCount === 2) {
        // resync 触发的重载：挂起模拟慢网络，用于 resync×切会话并发测试
        return Promise.resolve({ ok: true, json: () => gate.then(() => ({ sessionId: "sess-1", createdAt: 0, ...sessions["sess-1"] })) });
      }
      return ok({ sessionId: "sess-1", createdAt: 0, ...sessions["sess-1"] });
    }
    sess2FetchCount += 1;
    const lastSeq = sess2FetchCount === 1 ? 9 : 12; // resync 重载后序号推进
    return ok({ sessionId: "sess-2", createdAt: 0, ...sessions["sess-2"], lastSeq });
  }
  if (url.includes("/api/characters")) return ok({ characters: { "YYF": { cli: "codex", id: "r1" }, "金渐层k": { cli: "kimi", id: "r2" } } });
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
      window.sessionStorage.setItem("sessionId", "sess-1");
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

(async () => {
  try {
    // ── 初始化：按快照序号建连 ──
    await waitFor(() => esInstances.length >= 1);
    const es1 = esInstances[0];
    assert(!!es1, "init 建立 SSE 连接");
    assert(es1 && es1.url.includes("afterSeq=5"), "建连携带快照序号 afterSeq=5");

    // ── 主线已回复 + 同 key active：无空 thinking，回复带"处理中"标记 ──
    assert(!document.getElementById("thinking-YYF-m1"), "主线已回复 + active：不新建空 thinking");
    const mainReply = document.querySelector('[data-msg-id="a1"]');
    assert(!!mainReply && !!mainReply.querySelector(".msg-processing"), "主线回复恢复'处理中'标记");

    // ── thread 深层回复同 key：同样不新建空 thinking，badge 挂到深层回复上 ──
    const deepReply = document.querySelector('[data-msg-id="d1"]');
    assert(!!deepReply, "thread 深层回复已渲染");
    assert(!!deepReply && !!deepReply.querySelector(".msg-processing"), "thread 深层回复恢复'处理中'标记");
    assert(!document.getElementById("thinking-YYF-m1"), "thread 场景仍无空 thinking");

    // ── 完成事件（携带 messageId）：清标记、无残留 ──
    es1.emit("status", { character: "YYF", status: "online", messageId: "m1" });
    await sleep(100);
    assert(!mainReply.querySelector(".msg-processing") && !(deepReply && deepReply.querySelector(".msg-processing")), "完成事件清除'处理中'标记");
    assert(!document.getElementById("thinking-YYF-m1"), "完成后无 live thinking 残留");

    // ── resync 闭环：关旧 → 重载（挂起）→ 此刻切会话 → 旧快照不得覆盖 B ──
    es1.emit("resync", {});
    await waitFor(() => sess1FetchCount >= 2);
    assert(es1.closed, "resync 立即关闭旧连接");
    assert(sess1FetchCount === 2, "resync 触发一次历史重载");

    // 切到 sess-2：B 渲染完成
    esInstances.length = 0;
    dom.window.eval('switchSession("sess-2")');
    await waitFor(() => esInstances.length >= 1 && !!document.getElementById("thinking-金渐层k-n1"));
    const es2 = esInstances[0];
    assert(!!es2, "切换后建立新 SSE");
    assert((document.body.textContent || "").includes("另一个会话"), "B 会话内容已渲染");

    // 放行 A 的慢快照：必须被丢弃，不能覆盖 B
    gateResolve();
    await sleep(300);
    assert((document.body.textContent || "").includes("另一个会话"), "A 的旧快照未覆盖 B 的 DOM");
    assert(!(document.body.textContent || "").includes("主线回复"), "A 的旧快照未写入 B");

    // ── B 自己的 resync 不被 A 的防重吞掉（防重绑定连接而非全局锁）──
    const fetchesBefore = sess2FetchCount;
    es2.emit("resync", {});
    await waitFor(() => es2.closed);
    assert(es2.closed, "B 的 resync 关闭旧连接");
    await waitFor(() => esInstances.length >= 2);
    const es3 = esInstances[1];
    assert(!!es3 && es3.url.includes("afterSeq=12"), `B resync 后按新快照重连 afterSeq=12: ${es3 && es3.url}`);
    assert(sess2FetchCount === fetchesBefore + 1, "B 的 resync 恰好重载一次");

    // ── 切会话后未回复的 active invoke：有终止按钮；完成后移除 ──
    const kimi = document.getElementById("thinking-金渐层k-n1");
    assert(!!kimi && !!kimi.querySelector(".abort-btn"), "未回复 active 恢复终止按钮");
    if (kimi) {
      es3.emit("status", { character: "金渐层k", status: "online", messageId: "n1" });
      await sleep(100);
      assert(!document.getElementById("thinking-金渐层k-n1"), "完成后空 live thinking 被移除");
    }

    // ── 全文无未归档 thinking 残留 ──
    let residue = false;
    for (const el of document.querySelectorAll('[id^="thinking-"]')) {
      if (!el.dataset.archived) residue = true;
    }
    assert(!residue, "无未归档 thinking 残留");
  } catch (e) {
    console.error(e);
    failed += 1;
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
