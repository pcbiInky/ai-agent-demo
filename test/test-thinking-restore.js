#!/usr/bin/env node
// 过程记录恢复 / 折叠 / 嵌入的回归测试（jsdom 模拟刷新与切会话）
// 覆盖：按快照序号建连、已回复+active（主线与 thread 深层）、resync 闭环、
//       旧连接迟到 resync、resync 与切会话并发不串写、未回复 active 终止按钮、完成事件清理、
//       错误消息绑定（实时 error SSE 与历史重放的执行记录均嵌入错误气泡）
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (err) {
  // 依赖缺失是环境错误，必须失败而不是静默跳过（否则 CI 显示绿但断言没跑）
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

const sessions = {
  // 已回复 + 同 key 仍 active（mcp 时序）；含 thread 深层回复同 key
  "sess-1": {
      messages: [
        { id: "m1", role: "user", text: "问题", timestamp: 1 },
        { id: "th1", role: "thinking", character: "YYF", text: "先检查现有实现。", timestamp: 2, messageId: "m1" },
        { id: "p1", role: "permission", requestId: "req1", character: "YYF", toolName: "Bash", input: { command: "ls" }, timestamp: 2, messageId: "m1", status: "allow" },
      { id: "a1", role: "assistant", character: "YYF", text: "主线回复", replyTo: "m1", timestamp: 3, aiMentions: [], source: "mcp-tool" },
      { id: "o1", role: "assistant", character: "YYF", text: "thread 发起", replyTo: "m1", timestamp: 4, aiMentions: ["晔晔"], threadId: "t1", source: "mcp-tool" },
      { id: "d1", role: "assistant", character: "YYF", text: "thread 深层回复", replyTo: "m1", timestamp: 5, aiMentions: [], threadId: "t1", depth: 1, source: "mcp-tool" },
      // 召唤链：YYF 在 thread 里 @晔晔，晔晔的深层回复 + 其执行记录绑定 c1
      { id: "c1", role: "assistant", character: "YYF", text: "@晔晔 来看一下", replyTo: "m1", timestamp: 6, aiMentions: ["晔晔"], threadId: "t1" },
      { id: "pc1", role: "permission", requestId: "reqc1", character: "晔晔", toolName: "Bash", input: { command: "chain-cmd" }, timestamp: 7, messageId: "c1", status: "allow" },
      { id: "d2", role: "assistant", character: "晔晔", text: "晔晔的链式回复", replyTo: "c1", timestamp: 8, aiMentions: [], threadId: "t1", depth: 1 },
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
  // 同角色对同父消息两条回复（重复召唤）：执行记录应留在先渲染的回复里
  "sess-3": {
    messages: [
      { id: "m1", role: "user", text: "dup", timestamp: 1 },
      { id: "p1", role: "permission", requestId: "reqd1", character: "YYF", toolName: "Bash", input: { command: "dup-cmd" }, timestamp: 2, messageId: "m1", status: "allow" },
      { id: "r1", role: "assistant", character: "YYF", text: "回复一", replyTo: "m1", timestamp: 3, aiMentions: [] },
      { id: "r2", role: "assistant", character: "YYF", text: "回复二", replyTo: "m1", timestamp: 4, aiMentions: [] },
    ],
    lastSeq: 20,
    activeThinking: [],
  },
  // 历史错误绑定：permission.messageId 与 error.replyTo 对应
  "sess-4": {
    messages: [
      { id: "e1", role: "user", text: "触发故障", timestamp: 1 },
      { id: "ep1", role: "permission", requestId: "req-e1", character: "晔晔", toolName: "Bash", input: { command: "err-cmd" }, timestamp: 2, messageId: "e1", status: "allow" },
      { id: "ee1", role: "error", character: "晔晔", error: "历史故障", replyTo: "e1", timestamp: 3 },
    ],
    lastSeq: 30,
    activeThinking: [],
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
    if (url.includes("sess-4")) {
      return ok({ sessionId: "sess-4", createdAt: 0, ...sessions["sess-4"] });
    }
    if (url.includes("sess-3")) {
      return ok({ sessionId: "sess-3", createdAt: 0, ...sessions["sess-3"] });
    }
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
  if (url.includes("/api/characters")) return ok({ characters: { "YYF": { cli: "codex", id: "r1" }, "金渐层k": { cli: "kimi", id: "r2" }, "晔晔": { cli: "dsh", id: "r3" } } });
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

    // ── 主线已回复 + 同 key active：无空 thinking，过程记录包含已折叠的 Thinking ──
    assert(!document.getElementById("thinking-YYF-m1"), "主线已回复 + active：不新建空 thinking");
    const mainReply = document.querySelector('[data-msg-id="a1"]');
    assert(!!mainReply && !mainReply.querySelector(".msg-processing"), "主线回复不再显示顶部'仍在处理中'标记");
    const mainThinking = mainReply && mainReply.querySelector(".thinking-process");
    assert(!!mainThinking, "主线回复的过程记录包含 Thinking 折叠");
    assert(!!mainThinking && !mainThinking.open, "历史 Thinking 默认折叠");
    assert(!!mainThinking && mainThinking.textContent.includes("先检查现有实现。"), "历史 Thinking 内容恢复正确");

    // ── thread 深层回复同 key：同样不新建空 thinking，也不重复显示顶部标记 ──
    const deepReply = document.querySelector('[data-msg-id="d1"]');
    assert(!!deepReply, "thread 深层回复已渲染");
    assert(!!deepReply && !deepReply.querySelector(".msg-processing"), "thread 深层回复无顶部处理标记");
    assert(!document.getElementById("thinking-YYF-m1"), "thread 场景仍无空 thinking");

    // ── 完成事件（携带 messageId）：无残留 ──
    es1.emit("status", { character: "YYF", status: "online", messageId: "m1" });
    await sleep(100);
    assert(!document.getElementById("thinking-YYF-m1"), "完成后无 live thinking 残留");

    // ── 召唤链：thread 深层回复的执行记录嵌入该回复，不另起角色行 ──
    const chainReply = document.querySelector('[data-msg-id="d2"]');
    assert(!!chainReply, "链式回复已渲染");
    const chainEmbed = chainReply && chainReply.querySelector(":scope > .bubble-wrapper > .thinking-embed");
    assert(!!chainEmbed, "链式回复内嵌执行记录");
    if (chainEmbed) {
      assert(chainEmbed.querySelectorAll(".perm-card").length === 1, "链式嵌入块含 1 张卡片");
      const t = chainEmbed.querySelector(".msg-time");
      assert(t && t.textContent === "过程记录 · 1 条执行记录", `链式嵌入摘要正确: ${t && t.textContent}`);
    }
    // 嵌入块本身保留归档 id（供后续权限请求定位），只校验顶层没有独立行
    const standaloneChain = [...document.querySelectorAll("#messages > *")].some((el) => el.id.startsWith("thinking-archive-晔晔-c1-"));
    assert(!standaloneChain, "链式场景无独立过程记录行");

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

    // ── 同角色同父消息两条回复：记录留在先渲染的 r1，不被搬到 r2 ──
    esInstances.length = 0;
    dom.window.eval('switchSession("sess-3")');
    await waitFor(() => !!document.querySelector('[data-msg-id="r1"]'));
    const r1 = document.querySelector('[data-msg-id="r1"]');
    const r2 = document.querySelector('[data-msg-id="r2"]');
    const r1Embed = r1 && r1.querySelector(":scope > .bubble-wrapper > .thinking-embed");
    const r2Embed = r2 && r2.querySelector(":scope > .bubble-wrapper > .thinking-embed");
    assert(!!r1Embed, "先渲染的回复一保留执行记录");
    assert(!!r1Embed && r1Embed.querySelectorAll(".perm-card").length === 1, "回复一的嵌入块含 1 张卡片");
    assert(!r2Embed, "后渲染的回复二不搬走执行记录");
    const dupStandalone = [...document.querySelectorAll("#messages > *")].some((el) => el.id.startsWith("thinking-archive-YYF-m1-"));
    assert(!dupStandalone, "重复回复场景无独立过程记录行");

    // ── 实时：error SSE 后执行记录嵌入错误气泡，摘要保持"执行中断" ──
      const liveEs = esInstances[0];
      liveEs.emit("thinking", { character: "YYF", messageId: "rt-err-1" });
      await sleep(50);
      liveEs.emit("thinking-content", { character: "YYF", messageId: "rt-err-1", text: "正在定位故障", delta: false });
      await sleep(50);
      const liveThinking = document.getElementById("thinking-YYF-rt-err-1")?.querySelector(".thinking-process");
      assert(!!liveThinking && !liveThinking.hidden, "收到 Thinking 内容后网页显示 Thinking 折叠标签");
      assert(!!liveThinking && liveThinking.querySelector("summary")?.textContent === "Thinking 过程", "网页 Thinking 折叠标题正确");
      assert(!!liveThinking && liveThinking.open, "执行中 Thinking 内容展开显示");
      assert(!!liveThinking && liveThinking.textContent.includes("正在定位故障"), "执行中 Thinking 内容实时追加");
      const liveThinkingContent = liveThinking?.querySelector(".thinking-content");
      if (liveThinkingContent) {
        Object.defineProperty(liveThinkingContent, "scrollHeight", { configurable: true, value: 320 });
        liveThinkingContent.scrollTop = 0;
        liveEs.emit("thinking-content", { character: "YYF", messageId: "rt-err-1", text: "继续分析", delta: false });
        await sleep(50);
        assert(liveThinkingContent.scrollTop === 320, "实时 Thinking 追加时只跟随内层内容滚动");
      }
      liveEs.emit("permission", { requestId: "req-rt-err", character: "YYF", toolName: "Bash", input: { command: "boom" }, messageId: "rt-err-1" });
    await sleep(50);
    liveEs.emit("error", { character: "YYF", messageId: "rt-err-1", error: "实时故障" });
    await sleep(100);
    const liveErr = [...document.querySelectorAll(".error-msg")].find((el) => (el.textContent || "").includes("实时故障"));
    assert(!!liveErr, "实时错误气泡已渲染");
    const liveEmbed = liveErr && liveErr.querySelector(":scope > .bubble-wrapper > .thinking-embed");
    assert(!!liveEmbed, "实时错误气泡内嵌执行记录");
      if (liveEmbed) {
        assert(liveEmbed.querySelectorAll(".perm-card").length === 1, "实时错误嵌入块含 1 张卡片");
        const archivedThinking = liveEmbed.querySelector(".thinking-process");
        assert(!!archivedThinking && !archivedThinking.open, "结束后 Thinking 内容折叠");
        assert(!!archivedThinking && archivedThinking.textContent.includes("正在定位故障"), "结束后 Thinking 内容保留");
      const t = liveEmbed.querySelector(".msg-time");
      assert(t && t.textContent.includes("执行中断"), `实时错误嵌入摘要保持"执行中断": ${t && t.textContent}`);
    }
    // reply/error 已经归档后，CLI 仍可能补发最后一条过程 message；
    // 必须追加到现有嵌入块，不能再创建第二条独立 Thinking 标签。
    liveEs.emit("thinking-content", {
      character: "YYF",
      messageId: "rt-err-1",
      text: "补充最终判断",
      delta: false,
    });
    await sleep(50);
    assert(!document.getElementById("thinking-YYF-rt-err-1"), "归档后迟到 thinking 不创建新的 live 记录");
    assert(liveEmbed.querySelector(".thinking-content").textContent.includes("补充最终判断"), "归档后迟到 thinking 合并到原折叠");
    const sameKeyThinking = document.querySelectorAll('[id^="thinking-archive-YYF-rt-err-1-"]');
    assert(sameKeyThinking.length === 1, "同一轮只保留一个 Thinking 过程标签");

    const liveStandalone = [...document.querySelectorAll("#messages > *")].some((el) => el.id.startsWith("thinking-archive-YYF-rt-err-1-"));
    assert(!liveStandalone, "实时错误场景无独立过程记录行");

    // ── 历史：permission.messageId 与 error.replyTo 对应，重放后执行记录嵌入错误气泡 ──
    esInstances.length = 0;
    dom.window.eval('switchSession("sess-4")');
    await waitFor(() => !![...document.querySelectorAll(".error-msg")].find((el) => (el.textContent || "").includes("历史故障")));
    const histErr = [...document.querySelectorAll(".error-msg")].find((el) => (el.textContent || "").includes("历史故障"));
    assert(!!histErr, "历史错误气泡已渲染");
    const histEmbed = histErr && histErr.querySelector(":scope > .bubble-wrapper > .thinking-embed");
    assert(!!histEmbed, "历史错误气泡内嵌执行记录");
    if (histEmbed) {
      assert(histEmbed.querySelectorAll(".perm-card").length === 1, "历史错误嵌入块含 1 张卡片");
    }
    const histStandalone = [...document.querySelectorAll("#messages > *")].some((el) => el.id.startsWith("thinking-archive-晔晔-e1-"));
    assert(!histStandalone, "历史错误场景无独立过程记录行");

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
