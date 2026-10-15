#!/usr/bin/env node
// 消息内 Mermaid 渲染的回归测试（jsdom + 真实 marked/marked-highlight/hljs/DOMPurify + 可控假 Mermaid）
// 覆盖：主聊天/历史重放/消息链面板渲染、ID 唯一、去重、串行队列错误后继续、
//       超长与加载失败回退、异步期间切换会话丢弃旧结果、SVG 二次清洗、普通 Markdown 回归
const fs = require("fs");
const path = require("path");

let JSDOM = null;
try {
  JSDOM = require("jsdom").JSDOM;
} catch (err) {
  console.error(`❌ 无法加载 jsdom（请先 npm install）：${err.message}`);
  process.exit(1);
}
const { marked } = require("marked");
const markedHighlightPkg = require("marked-highlight");
const hljs = require("highlight.js");
const createDOMPurify = require("dompurify");

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
  "diff-panel", "diff-panel-title", "diff-panel-sub", "diff-panel-content", "diff-close-btn",
  "diff-nav", "diff-nav-prev", "diff-nav-count", "diff-nav-next", "diff-resize-handle",
];

// 可控的假 Mermaid：记录 render 调用，按源码内容决定行为
const mermaidMock = {
  calls: [],
  delayMs: 0,
  async render(id, source) {
    this.calls.push({ id, source });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (source.includes("INVALID")) throw new Error("Parse error on line 1: <bad>");
    if (source.includes("EVIL")) {
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}-svg" width="10" height="10">`
          + `<script>window.__pwned = 1</script>`
          + `<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><div>x</div></body></foreignObject>`
          + `<rect width="10" height="10" onclick="window.__pwned = 1"/>`
          + `<a href="javascript:window.__pwned = 1"><text>恶意链</text></a></svg>`,
      };
    }
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}-svg" width="80" height="40"><text>${source.includes("开始") ? "开始" : "节点"}</text></svg>` };
  },
};

const FLOW_A = 'flowchart TD\n  A["开始"] --> B{是否有效}\n  B -- 是 --> C["继续"]\n  B -- 否 --> D["结束"]';
const FLOW_B = "flowchart LR\n  X[甲] --> Y[乙]";
const FLOW_C = "sequenceDiagram\n  客户端->>服务端: 发起请求";
const md = (code) => "```mermaid\n" + code + "\n```";

const historyPayload = {
  sessionId: "sess-mermaid",
  createdAt: 0,
  messages: [
    { id: "u1", role: "user", text: "用户消息里提到 " + md(FLOW_A) + " 不应被转换", timestamp: 1 },
    { id: "h1", role: "assistant", character: "YYF", text: "历史里的图：\n" + md(FLOW_A), timestamp: 2 },
  ],
  lastSeq: 1,
  activeThinking: [],
};

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

function stubFetch(url) {
  const ok = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  if (url.includes("/api/history")) return ok(historyPayload);
  if (url.includes("/api/characters")) return ok({ characters: { "YYF": { cli: "codex", id: "r1" }, "马哥": { cli: "qodercn", id: "r2" } } });
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
      window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.sessionStorage.setItem("sessionId", "sess-mermaid");
      if (!window.crypto || !window.crypto.randomUUID) {
        window.crypto = { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) };
      }
      window.marked = marked;
      window.markedHighlight = markedHighlightPkg;
      window.hljs = hljs;
      window.DOMPurify = createDOMPurify(window);
      window.__mermaidModuleForTest = mermaidMock;
    },
  }
);

dom.window.eval(appJs);
const { document } = dom.window;
const window = dom.window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, n = 80) => {
  for (let i = 0; i < n; i++) { await sleep(50); try { if (fn()) return true; } catch { /* retry */ } }
  return false;
};

const blocks = () => [...document.querySelectorAll(".mermaid-block")];
const doneBlocks = () => blocks().filter((b) => b.dataset.mermaidState === "done");
const errorBlocks = () => blocks().filter((b) => b.dataset.mermaidState === "error");

(async () => {
  try {
    await waitFor(() => esInstances.length >= 1);
    const es = esInstances[0];
    assert(!!es, "init 建立 SSE 连接");

    // ── 1. 历史重放：assistant 历史消息里的 mermaid 被渲染 ──
    const historyRendered = await waitFor(() => doneBlocks().length >= 1);
    assert(historyRendered, "历史重放：assistant 历史消息的 Mermaid 渲染为 SVG");
    const histBlock = blocks()[0];
    assert(!!histBlock?.querySelector(".mermaid-figure svg"), "图形区包含 SVG");
    const histSource = histBlock?.querySelector(".mermaid-source pre code");
    assert(histSource?.textContent.includes('A["开始"]'), "折叠区保留转义前的原始源码（引号完整）");
    assert(histSource?.classList.contains("language-mermaid"), "源码节点保留 language-mermaid 类");
    assert(histSource?.querySelectorAll("span").length === 0, "Mermaid 源码不走 hljs 高亮（无 span 包裹）");
    assert(histBlock?.querySelector(".mermaid-source")?.open === false, "渲染成功时源码默认折叠");

    // ── 2. 用户消息不转换 ──
    const userMsg = document.querySelector(".message.user");
    assert(!!userMsg && !userMsg.querySelector(".mermaid-block") && !userMsg.querySelector("pre"), "用户纯文本消息不被转换为 Mermaid 图块");

    // ── 3. 实时回复：同图源码再次渲染，renderId 不复用 ──
    es.emit("thinking", { character: "YYF", messageId: "u1" });
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r1", text: "再看一次：\n" + md(FLOW_A), timestamp: 100 });
    await waitFor(() => doneBlocks().length >= 2);
    const ids1 = mermaidMock.calls.map((c) => c.id);
    assert(new Set(ids1).size === ids1.length && ids1.length === 2, `同源码两次渲染 ID 不串用（${ids1.join(", ")}）`);

    // ── 4. 单条消息多图 ──
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r2", text: "两张图：\n" + md(FLOW_B) + "\n以及：\n" + md(FLOW_C), timestamp: 101 });
    await waitFor(() => doneBlocks().length >= 4);
    const r2Msg = state_messageElements("r2");
    assert(r2Msg?.querySelectorAll(".mermaid-block").length === 2, "单条消息内的多个 Mermaid 代码块各自成图");

    // ── 5. 去重：对同一消息重复调用 renderMermaidBlocks 不重复排队 ──
    const callsBefore = mermaidMock.calls.length;
    window.renderMermaidBlocks(r2Msg);
    window.renderMermaidBlocks(document.getElementById("messages"));
    await sleep(200);
    assert(mermaidMock.calls.length === callsBefore, "重复扫描同一 DOM 不重复渲染（WeakSet 去重）");

    // ── 6. 单条消息内错误图后接有效图：错误回退 + 队列继续 ──
    es.emit("reply", {
      character: "YYF", messageId: "u1", replyId: "r3",
      text: "坏的：\n```mermaid\nINVALID {{{\n```\n好的：\n" + md(FLOW_B), timestamp: 102,
    });
    await waitFor(() => errorBlocks().length >= 1 && doneBlocks().length >= 5);
    const errBlock = errorBlocks()[0];
    assert(errBlock.querySelector(".mermaid-error")?.textContent.includes("Mermaid 渲染失败"), "语法错误显示简短提示");
    assert(!errBlock.querySelector(".mermaid-error")?.innerHTML.includes("<bad>"), "异常字符串不当 HTML 注入");
    assert(errBlock.querySelector(".mermaid-source")?.open === true, "失败时源码默认展开");
    assert(errBlock.querySelector(".mermaid-source pre")?.textContent.includes("INVALID"), "失败时保留可读源码");
    const r3Msg = state_messageElements("r3");
    assert(r3Msg?.querySelectorAll('.mermaid-block[data-mermaid-state="done"]').length === 1, "错误图之后的有效图仍正常渲染（串行队列可恢复）");

    // ── 7. 超长源码：直接回退，不调用 render ──
    const callsBefore7 = mermaidMock.calls.length;
    const bigSource = "flowchart TD\n  A[" + "长".repeat(21000) + "] --> B[x]";
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r4", text: md(bigSource), timestamp: 103 });
    await waitFor(() => errorBlocks().length >= 2);
    assert(errorBlocks()[1].querySelector(".mermaid-error")?.textContent.includes("上限"), "超长源码提示超过上限");
    assert(mermaidMock.calls.length === callsBefore7, "超长源码不进入 Mermaid 渲染");

    // ── 8. 组件加载失败：回退并可恢复 ──
    window.__mermaidModuleForTest = { then: (_ok, onErr) => onErr(new Error("网络错误")) };
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r5", text: md(FLOW_B), timestamp: 104 });
    await waitFor(() => errorBlocks().length >= 3);
    assert(errorBlocks()[2].querySelector(".mermaid-error")?.textContent.includes("加载失败"), "组件加载失败有回退提示");
    window.__mermaidModuleForTest = mermaidMock;
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r6", text: md(FLOW_B), timestamp: 105 });
    const recovered = await waitFor(() => state_messageElements("r6")?.dataset && doneBlocks().some((b) => state_messageElements("r6").contains(b)));
    assert(recovered, "加载失败恢复后后续图正常渲染");

    // ── 9. 恶意 SVG 二次清洗 ──
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r7", text: md("flowchart TD\n  EVIL --> Z"), timestamp: 106 });
    await waitFor(() => doneBlocks().some((b) => state_messageElements("r7")?.contains(b)));
    const evilFig = state_messageElements("r7").querySelector(".mermaid-figure");
    assert(!!evilFig.querySelector("svg"), "清洗后 SVG 仍保留");
    assert(!evilFig.querySelector("script") && !evilFig.querySelector("foreignObject"), "script / foreignObject 被清除");
    assert(!evilFig.querySelector("[onclick]"), "事件属性被清除");
    assert(![...evilFig.querySelectorAll("a")].some((a) => String(a.getAttribute("href") || "").startsWith("javascript:")), "javascript: 链接被清除");
    assert(window.__pwned === undefined, "注入的脚本未执行");

    // ── 10. 异步渲染期间切换会话：旧结果丢弃，不留悬挂节点 ──
    mermaidMock.delayMs = 300;
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r8", text: md(FLOW_C), timestamp: 107 });
    await waitFor(() => mermaidMock.calls.some((c) => c.source === FLOW_C));
    document.getElementById("messages").innerHTML = ""; // 模拟切换会话清空消息
    await sleep(600);
    mermaidMock.delayMs = 0;
    assert(!document.querySelector("#messages svg"), "切换会话后旧渲染结果不写入新 DOM");
    const stray = [...document.body.querySelectorAll("[id]")].filter((el) => /^d?mermaid-/.test(el.id));
    assert(stray.length === 0, `body 下无悬挂的 mermaid 临时节点（残留 ${stray.length} 个）`);

    // ── 11. 消息链（thread）面板渲染 ──
    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r10", text: "@马哥 看图", aiMentions: ["马哥"], timestamp: 110 });
    es.emit("reply", { character: "马哥", messageId: "r10", replyId: "r11", threadId: "r10", depth: 1, text: "链上的图：\n" + md(FLOW_A), timestamp: 111 });
    await waitFor(() => doneBlocks().some((b) => state_messageElements("r11")?.contains(b)));
    assert(doneBlocks().some((b) => state_messageElements("r11")?.contains(b)), "主聊天中的 thread 回复同样渲染 Mermaid");
    window.openThread("r10");
    const panelRendered = await waitFor(() => !!document.querySelector("#thread-messages .mermaid-block svg"));
    assert(panelRendered, "右侧消息链面板内渲染 Mermaid");
    const panelIds = mermaidMock.calls.map((c) => c.id);
    assert(new Set(panelIds).size === panelIds.length, "主聊天与消息链中同一源码不复用渲染 ID");

    // ── 12. 普通 Markdown 回归 ──
    es.emit("reply", {
      character: "YYF", messageId: "u1", replyId: "r12",
      text: "说明 `inline` 一下：\n```js\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[链接](https://example.com)", timestamp: 112,
    });
    await sleep(300);
    const r12 = state_messageElements("r12");
    const jsCode = r12?.querySelector("pre code.language-js");
    assert(!!jsCode && !r12.querySelector(".mermaid-block"), "普通 js 代码块不生成 Mermaid 图块");
    assert(!!jsCode?.querySelector("span"), "普通 js 代码块仍走 hljs 高亮");
    assert(!!r12?.querySelector("code")?.textContent.includes("inline"), "行内代码正常");
    assert(!!r12?.querySelector("table") && !!r12?.querySelector('a[href="https://example.com"]'), "表格与链接渲染无回归");

    // ── 13. 点击放大浮层与缩放 ──
    const zoomFigure = state_messageElements("r11")?.querySelector(".mermaid-figure");
    assert(zoomFigure?.title === "点击放大查看", "渲染成功的图形带点击放大提示");
    zoomFigure.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    let lightbox = document.querySelector(".mermaid-lightbox");
    assert(!!lightbox?.querySelector(".mermaid-lightbox-body svg"), "点击图形打开放大浮层并克隆 SVG");
    const zoomSvg = lightbox.querySelector("svg");
    assert(zoomSvg?.getAttribute("id")?.endsWith("-svg"), "浮层 SVG 内容与气泡内一致");
    assert(/^\d+px$/.test(zoomSvg.style.width) && zoomSvg.style.maxWidth === "none", "浮层 SVG 去掉 max-width 约束并按像素尺寸展示（不再比气泡里更小）");
    assert(lightbox.querySelector(".mermaid-zoom-label")?.textContent === "100%", "初始缩放 100%");

    // P2 回归：缩放保留正在看的位置。模拟真实布局：body 有 16px padding
    // （留白不参与缩放），SVG 位置 = padding − 滚动偏移，尺寸随 style 宽高变化；
    // 滚动写入按整数取整，模拟浏览器的滚动取整误差
    const lbBody = lightbox.querySelector(".mermaid-lightbox-body");
    let mockScrollLeft = 0;
    let mockScrollTop = 0;
    Object.defineProperty(lbBody, "scrollLeft", { get: () => mockScrollLeft, set: (v) => { mockScrollLeft = Math.round(v); }, configurable: true });
    Object.defineProperty(lbBody, "scrollTop", { get: () => mockScrollTop, set: (v) => { mockScrollTop = Math.round(v); }, configurable: true });
    Object.defineProperty(lbBody, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1000, height: 800 }), configurable: true });
    const lbSvg = lbBody.querySelector("svg");
    Object.defineProperty(lbSvg, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 16 - mockScrollLeft,
        top: 16 - mockScrollTop,
        width: parseFloat(lbSvg.style.width) || 800,
        height: parseFloat(lbSvg.style.height) || 40,
      }),
    });
    // 锚点 (500,100) 落在 SVG 内；与实现一致，钳制到图边缘（padding 区不缩放）
    const pinchAt = (x, y, dx = -120) => lightbox.dispatchEvent(new window.WheelEvent("wheel", { ctrlKey: true, deltaY: dx, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const pinch = (dx = -120) => pinchAt(500, 100, dx);
    const anchorRel = (ax, ay) => {
      const r = lbSvg.getBoundingClientRect();
      const clamp01 = (v) => Math.min(1, Math.max(0, v));
      return { x: clamp01((ax - r.left) / r.width), y: clamp01((ay - r.top) / r.height) };
    };
    for (let i = 0; i < 19; i++) pinch(); // 先放大到约 4 倍，让内容宽于视口
    // 用户平移到 scrollLeft=600：滚动变化必伴随滚轮/指针事件，锚点因此重置
    lightbox.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true }));
    mockScrollLeft = 600;
    mockScrollTop = 40;
    let maxDeviation = 0;
    for (let step = 0; step < 6; step++) {
      const before = anchorRel(500, 100);
      pinch();
      const after = anchorRel(500, 100);
      maxDeviation = Math.max(maxDeviation, Math.abs(after.x - before.x), Math.abs(after.y - before.y));
    }
    assert(maxDeviation < 0.01, `连续捏合缩放保留视点（滚动取整 + padding，最大偏差 ${(maxDeviation * 100).toFixed(3)}% 图宽）`);
    assert(mockScrollLeft !== 600, "捏合缩放时滚动位置随锚点补偿");

    // 平移（普通滚动）重置锚点：之后在新指针位置捏合，按新锚点保持
    lightbox.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true }));
    mockScrollLeft = 900;
    let panDeviation = 0;
    for (let step = 0; step < 3; step++) {
      const before = anchorRel(300, 60);
      pinchAt(300, 60);
      const after = anchorRel(300, 60);
      panDeviation = Math.max(panDeviation, Math.abs(after.x - before.x));
    }
    assert(panDeviation < 0.01, `平移后更换锚点重新保持视点（最大偏差 ${(panDeviation * 100).toFixed(3)}% 图宽）`);

    // P3 回归：无纵向增量的 Ctrl+滚轮（如横向滚动）不是缩放手势，不缩放也不拦截
    const zoomLabelBeforeP3 = lightbox.querySelector(".mermaid-zoom-label").textContent;
    const scrollLeftBeforeP3 = mockScrollLeft;
    const notPrevented = lightbox.dispatchEvent(new window.WheelEvent("wheel", { ctrlKey: true, deltaY: 0, deltaX: 60, bubbles: true, cancelable: true }));
    assert(notPrevented === true, "deltaY=0 的滚轮事件不被拦截（未 preventDefault，原生横向滚动保留）");
    assert(lightbox.querySelector(".mermaid-zoom-label")?.textContent === zoomLabelBeforeP3 && mockScrollLeft === scrollLeftBeforeP3, "deltaY=0 的滚轮事件不触发缩放");

    // 触控板捏合（ctrlKey+wheel）缩放；普通滚动不拦截
    lightbox.dispatchEvent(new window.WheelEvent("wheel", { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
    assert(lightbox.querySelector(".mermaid-zoom-label")?.textContent !== "100%", "捏合手势（ctrlKey+wheel）触发缩放");
    const zoomedWidth = parseInt(lightbox.querySelector("svg").style.width, 10);
    lightbox.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    assert(parseInt(lightbox.querySelector("svg").style.width, 10) === zoomedWidth, "普通双指滚动不触发缩放（留给原生平移）");
    // 按钮缩放与重置（先复位到 100%，前面 P2 连续捏合已触到 800% 上限）
    lightbox.querySelector(".mermaid-zoom-label").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const baseWidth = parseInt(lightbox.querySelector("svg").style.width, 10);
    const plusBtn = [...lightbox.querySelectorAll(".mermaid-lightbox-controls button")].find((b) => b.textContent === "+");
    plusBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const widthAfterPlus = parseInt(lightbox.querySelector("svg").style.width, 10);
    assert(widthAfterPlus > baseWidth, "＋ 按钮放大图形");
    lightbox.querySelector(".mermaid-zoom-label").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(lightbox.querySelector(".mermaid-zoom-label")?.textContent === "100%", "点击百分比重置为 100%");
    assert(!!document.querySelector(".mermaid-lightbox"), "点击缩放按钮不关闭浮层");

    // 点图形不关闭；Esc 关闭；点遮罩本体关闭
    lightbox.querySelector("svg").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(!!document.querySelector(".mermaid-lightbox"), "点击浮层内图形不关闭");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    assert(!document.querySelector(".mermaid-lightbox"), "Esc 关闭放大浮层");
    zoomFigure.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    lightbox = document.querySelector(".mermaid-lightbox");
    lightbox.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert(!document.querySelector(".mermaid-lightbox"), "点击遮罩本体关闭放大浮层");

  } catch (err) {
    console.error("测试异常:", err);
    failed += 1;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

// state.messageElements 在 eval 作用域内，通过 window 访问消息元素
function state_messageElements(replyId) {
  return document.querySelector(`.message[data-msg-id="${replyId}"]`);
}
