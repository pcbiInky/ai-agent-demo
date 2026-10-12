#!/usr/bin/env node
// 消息内文件修改 Diff 展示的回归测试（jsdom 模拟实时 SSE + 历史重载）
// 覆盖：成功执行才计入、失败/无变化/存量无 execution 不计入、快照不连续拆段、
//       oversized 统计未知、reply 先于执行结果时补挂、路径裁剪边界、侧栏面板渲染
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
const styleCss = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");

const IDS = [
  "messages", "message-input", "send-btn", "chat-container", "jump-to-latest-btn",
  "session-id-display", "new-session-btn", "session-list", "mention-hints",
  "character-statuses", "chat-title-text", "chat-subtitle", "edit-session-meta-btn",
  "settings-btn", "settings-modal", "settings-form", "settings-error",
  "settings-save-btn", "settings-cancel-btn", "settings-title", "settings-subtitle",
  "settings-skills-panel", "thread-panel", "thread-messages", "thread-close-btn",
  "skill-trace-list", "skill-list",
  "diff-panel", "diff-panel-title", "diff-panel-sub", "diff-panel-content", "diff-close-btn",
];

let historyPayload = {
  sessionId: "sess-diff",
  createdAt: 0,
  messages: [{ id: "u1", role: "user", text: "干活", timestamp: 1 }],
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
      window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      window.sessionStorage.setItem("sessionId", "sess-diff");
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

const dirItems = () => [...document.querySelectorAll(".file-diff-item")];
const itemByPath = (p) => dirItems().find((el) => el.querySelector(".file-diff-path")?.textContent === p);

function emitEdit(es, { requestId, filePath, messageId = "u1", before, after, status = "success", oversized = false, changed, seq }) {
  es.emit("permission", {
    requestId, character: "YYF", toolName: oversized ? "Write" : "Edit",
    input: { file_path: filePath, old_string: "o", new_string: "n" },
    messageId, timestamp: 100,
  });
  es.emit("permission-resolved", { requestId, behavior: "allow", message: "已允许" });
  es.emit("permission-executed", {
    requestId,
    execution: {
      status,
      filePath,
      diffAvailable: status === "success" && !oversized,
      ...(oversized ? { oversized: true } : {}),
      ...(status === "success" && !oversized ? { before, after } : {}),
      ...(status === "error" ? { error: "未找到要替换的文本", changed: false } : {}),
      ...(changed !== undefined ? { changed } : {}),
      ...(seq !== undefined ? { seq } : {}),
      finishedAt: 101,
    },
  });
}

(async () => {
  try {
    await waitFor(() => esInstances.length >= 1);
    const es = esInstances[0];
    assert(!!es, "init 建立 SSE 连接");

    es.emit("thinking", { character: "YYF", messageId: "u1" });

    // 成功 Edit：/x/a.js "a\nline2" -> "b\nline2"
    emitEdit(es, { requestId: "rq1", filePath: "/x/a.js", before: "a\nline2", after: "b\nline2" });
    // 失败 Edit：不计入
    emitEdit(es, { requestId: "rq2", filePath: "/x/bad.js", status: "error" });
    // 成功但无变化：不计入
    emitEdit(es, { requestId: "rq3", filePath: "/x/noop.js", before: "same", after: "same" });
    // 同一文件两次修改，快照不连续（中间被范围外修改）：拆段
    emitEdit(es, { requestId: "rq4", filePath: "/x/seg.js", before: "v1", after: "v2" });
    emitEdit(es, { requestId: "rq5", filePath: "/x/seg.js", before: "EXTERNAL", after: "v3" });
    // oversized：统计未知
    emitEdit(es, { requestId: "rq6", filePath: "/x/big.js", oversized: true });

    es.emit("reply", { character: "YYF", messageId: "u1", replyId: "r1", text: "完成", timestamp: 200 });
    await waitFor(() => dirItems().length > 0);

    assert(!!document.querySelector(".file-diff-dir"), "回复末尾出现文件修改目录");
    assert(dirItems().length === 3, `目录仅含 3 个有效文件（实际 ${dirItems().length}）`);
    assert(!!itemByPath("a.js"), "工作目录前缀 /x/ 已裁剪为 a.js");
    assert(!itemByPath("bad.js"), "执行失败的 Edit 不计入目录");
    assert(!itemByPath("noop.js"), "before===after 的无变化操作不计入目录");

    const aStat = itemByPath("a.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(aStat.includes("+1") && aStat.includes("-1"), `a.js 净统计 +1/-1: ${aStat}`);
    const segItem = itemByPath("seg.js");
    assert(!!segItem && segItem.textContent.includes("分段"), "快照不连续的同文件修改标注分段");
    assert(!!segItem && segItem.textContent.includes("2 次"), "seg.js 修改次数为 2");
    const bigStat = itemByPath("big.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(bigStat.includes("增删未知"), `oversized 文件统计显示未知: ${bigStat}`);

    const wrapper = document.querySelector('[data-msg-id="r1"] .bubble-wrapper');
    assert(!!wrapper && wrapper.lastElementChild.classList.contains("file-diff-dir"), "目录位于消息最后（.msg-model 之后）");

    // reply 之后到达的执行结果：补挂目录（路径边界：/x2 不被 /x 裁剪）
    es.emit("permission", { requestId: "rq7", character: "YYF", toolName: "Write", input: { file_path: "/x2/new.js", content: "hello" }, messageId: "u1", timestamp: 300 });
    es.emit("permission-resolved", { requestId: "rq7", behavior: "allow", message: "已允许" });
    es.emit("permission-executed", { requestId: "rq7", execution: { status: "success", filePath: "/x2/new.js", before: null, after: "hello", diffAvailable: true, finishedAt: 301 } });
    await waitFor(() => dirItems().length === 4);
    assert(dirItems().length === 4, "reply 后到达的执行结果补挂目录");
    assert(!!itemByPath("/x2/new.js"), "路径边界：/x2/new.js 不被 wd=/x 误裁剪");

    // oversized 且 hash 判定无变化：不计入目录
    emitEdit(es, { requestId: "rq8", filePath: "/x/same-big.js", oversized: true, changed: false });
    await sleep(200);
    assert(dirItems().length === 4, `大文件无变化操作不计入目录（实际 ${dirItems().length}）`);
    assert(!itemByPath("same-big.js"), "changed=false 的 oversized 记录不展示");

    // oversized 且有变化：计入，统计未知
    emitEdit(es, { requestId: "rq9", filePath: "/x/real-big.js", oversized: true, changed: true });
    await waitFor(() => dirItems().length === 5);
    const realBigStat = itemByPath("real-big.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(realBigStat.includes("增删未知"), `有变化的 oversized 文件计入且统计未知: ${realBigStat}`);

    // 并发乱序：真实写入序 B(x→y, finishedAt 402) → A(y→z, finishedAt 403)，
    // 但 A 的回报先到（seq 1001 < 1002）——回报到达序与写入序相反
    es.emit("permission", { requestId: "rqA", character: "YYF", toolName: "Edit", input: { file_path: "/x/conc.js", old_string: "y", new_string: "z" }, messageId: "u1", timestamp: 400 });
    es.emit("permission", { requestId: "rqB", character: "YYF", toolName: "Edit", input: { file_path: "/x/conc.js", old_string: "x", new_string: "y" }, messageId: "u1", timestamp: 401 });
    es.emit("permission-resolved", { requestId: "rqA", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqA", execution: { status: "success", filePath: "/x/conc.js", before: "y", after: "z", diffAvailable: true, changed: true, seq: 1001, finishedAt: 403 } });
    es.emit("permission-resolved", { requestId: "rqB", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqB", execution: { status: "success", filePath: "/x/conc.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 1002, finishedAt: 402 } });
    await waitFor(() => itemByPath("conc.js"));
    const concItem = itemByPath("conc.js");
    assert(!!concItem && !concItem.textContent.includes("分段"), "实时：回报到达序与写入序相反时按快照链重建为单段净 Diff");
    const concStat = concItem?.querySelector(".file-diff-stat")?.textContent || "";
    assert(concStat.includes("+1") && concStat.includes("-1") && !concStat.includes("+2"), `实时 conc.js 净统计 +1/-1（x→z）: ${concStat}`);

    // 重复快照状态（before/after 完全相同的两次修改）：顺序不可判定 → 顺序未知，不出净 Diff
    es.emit("permission", { requestId: "rqD1", character: "YYF", toolName: "Edit", input: { file_path: "/x/dup.js", old_string: "x", new_string: "y" }, messageId: "u1", timestamp: 600 });
    es.emit("permission-resolved", { requestId: "rqD1", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqD1", execution: { status: "success", filePath: "/x/dup.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 1004, finishedAt: 601 } });
    es.emit("permission", { requestId: "rqD2", character: "YYF", toolName: "Edit", input: { file_path: "/x/dup.js", old_string: "x", new_string: "y" }, messageId: "u1", timestamp: 602 });
    es.emit("permission-resolved", { requestId: "rqD2", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqD2", execution: { status: "success", filePath: "/x/dup.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 1005, finishedAt: 602 } });
    await waitFor(() => itemByPath("dup.js"));
    const dupStat = itemByPath("dup.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(dupStat.includes("顺序未知"), `重复快照状态标为顺序未知，不给虚假合计: ${dupStat}`);

    // 同毫秒 + 回报倒序 + 混入无快照操作：真实写入 A(x→y)、B(y→z)、C(oversized)，
    // 三者 finishedAt 相同，C 的回报先到（seq 最小）→ 无快照记录位置不可证，净 Diff 必须降级
    const T = 900;
    es.emit("permission", { requestId: "rqC0", character: "YYF", toolName: "Write", input: { file_path: "/x/mix.js", content: "..." }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqC0", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqC0", execution: { status: "success", filePath: "/x/mix.js", oversized: true, diffAvailable: false, changed: true, seq: 2001, finishedAt: T } });
    es.emit("permission", { requestId: "rqA0", character: "YYF", toolName: "Edit", input: { file_path: "/x/mix.js", old_string: "x", new_string: "y" }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqA0", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqA0", execution: { status: "success", filePath: "/x/mix.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 2002, finishedAt: T } });
    es.emit("permission", { requestId: "rqB0", character: "YYF", toolName: "Edit", input: { file_path: "/x/mix.js", old_string: "y", new_string: "z" }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqB0", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqB0", execution: { status: "success", filePath: "/x/mix.js", before: "y", after: "z", diffAvailable: true, changed: true, seq: 2003, finishedAt: T } });
    await waitFor(() => itemByPath("mix.js"));
    const mixStat = itemByPath("mix.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(mixStat.includes("增删未知") && !mixStat.includes("分段"), `混入无快照记录时目录不给合计也不称分段: ${mixStat}`);
    itemByPath("mix.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const mixPanel = document.getElementById("diff-panel-content");
    const mixNetLabels = [...mixPanel.querySelectorAll(".diff-seg-label")].filter((el) => el.textContent.startsWith("净 Diff"));
    assert(mixNetLabels.length === 0, "无快照记录位置不可证时不出现「净 Diff」标签");
    assert(mixPanel.textContent.includes("局部快照片段"), "快照片段改标为「局部快照片段」");
    assert(mixPanel.textContent.includes("不代表文件最终净变化"), "明示片段不代表文件最终净变化");
    assert(mixPanel.textContent.includes("先后无法证明"), "明示无快照记录相对先后无法证明");
    assert(!mixPanel.textContent.includes("范围外修改"), "不把已记录的无快照操作误称范围外修改");
    assert(!mixPanel.textContent.includes("逐次操作明细"), "面板不再显示逐次操作明细");

    // 无快照记录恰好把快照链切成两段：目录不得标「分段」（分段只是基线排序推断）
    es.emit("permission", { requestId: "rqA1", character: "YYF", toolName: "Edit", input: { file_path: "/x/mix2.js", old_string: "x", new_string: "y" }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqA1", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqA1", execution: { status: "success", filePath: "/x/mix2.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 3001, finishedAt: T } });
    es.emit("permission", { requestId: "rqC1", character: "YYF", toolName: "Write", input: { file_path: "/x/mix2.js", content: "..." }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqC1", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqC1", execution: { status: "success", filePath: "/x/mix2.js", oversized: true, diffAvailable: false, changed: true, seq: 3002, finishedAt: T } });
    es.emit("permission", { requestId: "rqB1", character: "YYF", toolName: "Edit", input: { file_path: "/x/mix2.js", old_string: "y", new_string: "z" }, messageId: "u1", timestamp: T });
    es.emit("permission-resolved", { requestId: "rqB1", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqB1", execution: { status: "success", filePath: "/x/mix2.js", before: "y", after: "z", diffAvailable: true, changed: true, seq: 3003, finishedAt: T } });
    await waitFor(() => itemByPath("mix2.js"));
    const mix2Stat = itemByPath("mix2.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(mix2Stat.includes("增删未知"), `无快照打断链条时目录不给合计: ${mix2Stat}`);
    assert(!mix2Stat.includes("分段"), `位置不可证时目录不标「分段」: ${mix2Stat}`);
    itemByPath("mix2.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const mix2Panel = document.getElementById("diff-panel-content");
    const mix2SegLabels = [...mix2Panel.querySelectorAll(".diff-seg-label")].filter((el) => el.textContent.startsWith("局部快照片段"));
    assert(mix2SegLabels.length === 2, `面板仍按 2 个局部快照片段展示（实际 ${mix2SegLabels.length}）`);
    assert(mix2SegLabels.every((el) => el.textContent.includes("不代表文件最终净变化")), "每个片段都明示不代表最终净变化");
    assert(!mix2Panel.textContent.includes("净 Diff"), "无快照参与时面板不出现「净 Diff」字样");

    // snapshotError（文件不可读，changed 未知）：计入且统计未知
    es.emit("permission", { requestId: "rqC", character: "YYF", toolName: "Write", input: { file_path: "/x/wo.js", content: "..." }, messageId: "u1", timestamp: 500 });
    es.emit("permission-resolved", { requestId: "rqC", behavior: "allow" });
    es.emit("permission-executed", { requestId: "rqC", execution: { status: "success", filePath: "/x/wo.js", snapshotError: true, diffAvailable: false, seq: 1003, finishedAt: 501 } });
    await waitFor(() => itemByPath("wo.js"));
    const woStat = itemByPath("wo.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(woStat.includes("增删未知"), `snapshotError 计入且统计未知: ${woStat}`);

    // 点击打开侧栏面板：净 Diff 行级高亮
    itemByPath("a.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const panel = document.getElementById("diff-panel-content");
    const addLines = [...panel.querySelectorAll(".diff-line.add")].map((el) => el.textContent);
    const delLines = [...panel.querySelectorAll(".diff-line.del")].map((el) => el.textContent);
    assert(addLines.some((t) => t.includes("b")) && delLines.some((t) => t.includes("a")), "面板展示 +b/-a 行级 diff");
    assert(panel.textContent.includes("净 Diff"), "面板含净 Diff 标签");
    assert(!panel.textContent.includes("逐次操作明细"), "面板只展示净 Diff，不再有逐次操作明细");

    // ── v20：面板内容是唯一滚动轨道，居中 = 代码块偏移 + 行内偏移 ──
    const focusCode = panel.querySelector(".diff-code");
    const firstChange = panel.querySelector(".diff-line.add, .diff-line.del");
    assert(!!firstChange && firstChange.classList.contains("del"), `a.js 面板第一处修改是删除行（实际 ${firstChange?.className}）`);
    Object.defineProperty(panel, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(focusCode, "offsetTop", { value: 120, configurable: true });
    Object.defineProperty(firstChange, "offsetHeight", { value: 20, configurable: true });
    Object.defineProperty(firstChange, "offsetTop", { value: 1000, configurable: true });
    const focusRes = dom.window.centerDiffLine(panel, firstChange);
    assert(!!focusRes && focusRes.code === focusCode && focusRes.top === 1120, `居中基准是代码块偏移 + 行内偏移（top ${focusRes?.top}，期望 120+1000）`);
    assert(panel.scrollTop === 880, `目标行落在面板视口中心（scrollTop ${panel.scrollTop}，期望 1120-(500-20)/2=880）`);
    assert(dom.window.centerDiffLine(panel, null) === null, "没有目标行时不滚动");
    assert(dom.window.centerDiffLine(panel, document.createElement("div")) === null, "目标不在代码块内时不滚动");

    // ── 行号：由 CSS 计数器生成，不增加行节点 ──
    assert(panel.textContent.includes("行号：修改前 / 修改后"), "面板给出行号列图例");
    assert(firstChange.children.length === 0, "行号走 ::before，行内不新增节点（避免放大 DOM 预算）");
    assert(/\.diff-code \{[^}]*counter-reset: diff-old diff-new;/.test(styleCss), "每个代码块独立重置行号计数器");
    assert(/\.diff-line\.ctx \{ counter-increment: diff-old diff-new; \}/.test(styleCss)
      && /\.diff-line\.del \{ counter-increment: diff-old; \}/.test(styleCss)
      && /\.diff-line\.add \{ counter-increment: diff-new; \}/.test(styleCss), "行号计数器按 ctx/del/add 分别推进");
    assert(/\.diff-line\.ctx::before \{ content: counter\(diff-old\) " \/ " counter\(diff-new\); \}/.test(styleCss), "上下文行显示修改前/后两个行号");
    assert(/\.diff-line\.del::before \{ content: counter\(diff-old\) " \/ -"; \}/.test(styleCss)
      && /\.diff-line\.add::before \{ content: "- \/ " counter\(diff-new\); \}/.test(styleCss), "增/删行只在自己所属一侧显示行号");
    assert(/\.diff-line \{[^}]*display: flex;/.test(styleCss) && /\.diff-line::before \{[^}]*width: 12ch;/.test(styleCss), "行号是定宽 flex 列，正文换行不会挤到行号下方");
    assert(/\.diff-code \{[^}]*position: relative;/.test(styleCss) && /\.diff-panel-content \{[^}]*position: relative;/.test(styleCss), "offsetTop 以代码块/面板内容为基准，居中计算才有确定参照");

    // ── v20：修改处归组（跨片段顺序 + 连续增删合并 + meta 也算一处） ──
    const mkCode = (before, after, budget) => dom.window.buildDiffCodeBlock(dom.window.computeLineDiff(before, after), budget);
    const hunkBox = document.createElement("div");
    const hunkCodeA = mkCode("a\nb\nc", "a\nB\nc");
    const hunkCodeB = mkCode("x", "x\n");
    hunkBox.append(hunkCodeA, hunkCodeB);
    const hunkList = dom.window.collectDiffHunks(hunkBox);
    assert(hunkList.length === 2 && hunkList[0].kind === "del" && hunkList[1].kind === "meta", `连续增删聚为一处、跨片段按面板顺序收集（${hunkList.map((h) => h.kind).join(",")}）`);
    assert(hunkList[0].lines.length === 2 && hunkList[0].first.classList.contains("del") && hunkList[0].last.classList.contains("add"), "一处修改含 del+add 两行，首行决定刻度着色");
    assert(hunkList[0].code === hunkCodeA && hunkList[1].code === hunkCodeB, "每处修改记住所属代码块，跳转才能跨片段");
    assert(dom.window.collectDiffHunks(document.createElement("div")).length === 0, "空容器没有修改处");

    // ── v20：刻度节点数必须有上界（交替修改可产生上千处） ──
    const altHunks = Array.from({ length: 900 }, (_, i) => ({ kind: i % 2 ? "add" : "del" }));
    const altGroups = dom.window.groupHunksForRail(altHunks);
    assert(altGroups.length <= 400 && altGroups[0].start === 0 && altGroups[altGroups.length - 1].end === 899, `900 处修改合并为 ${altGroups.length} 个刻度且覆盖全部序号`);
    assert(altGroups.some((g) => g.kind === "mixed") && altGroups.every((g) => g.end >= g.start), `增删混合的组用中性/双色刻度（${altGroups.filter((g) => g.kind === "mixed").length} 组 mixed）`);
    const fewGroups = dom.window.groupHunksForRail([{ kind: "add" }, { kind: "del" }]);
    assert(fewGroups.length === 2 && fewGroups[1].start === 1 && fewGroups[1].end === 1, "未超上限时每处一个刻度、不合并");

    // ── v20：刻度轨 + 上一处/下一处（跨片段、meta、长行换行、预算截断） ──
    const rail = document.querySelector("#diff-panel .diff-rail");
    assert(!!rail, "面板内挂了独立的刻度轨 .diff-rail（不依赖原生滚动条着色）");
    const navBox = document.getElementById("diff-panel-content");
    dom.window.clearDiffNav();
    navBox.innerHTML = "";
    assert(rail.hidden === true, "未构建导航时刻度轨隐藏");

    // 布局 stub：长行换行后行高更大，后续行整体下移 —— 刻度必须按布局后的坐标算
    const stubLayout = (code, codeTop) => {
      Object.defineProperty(code, "offsetTop", { value: codeTop, configurable: true });
      let top = 0;
      for (const el of code.querySelectorAll(".diff-line")) {
        const h = el.textContent.length > 60 ? 60 : 20;
        Object.defineProperty(el, "offsetTop", { value: top, configurable: true });
        Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
        top += h;
      }
    };
    const before23 = Array.from({ length: 23 }, (_, k) => `c${k}`).join("\n");
    const after23 = Array.from({ length: 23 }, (_, k) => (k === 10 || k === 22 ? `x${k}` : `c${k}`)).join("\n");
    const longLine = "y".repeat(80);
    const navCodeA = mkCode(before23, after23);
    const navCodeB = mkCode("a", "a\n");
    const navCodeW = mkCode(`${longLine}\ntail`, `${longLine}\ntail2`);
    const navCodeC = mkCode("", "dead\nline\n", { left: 0 });
    navBox.append(navCodeA, navCodeB, navCodeW, navCodeC);
    stubLayout(navCodeA, 40);
    stubLayout(navCodeB, 600);
    stubLayout(navCodeW, 800);
    stubLayout(navCodeC, 1000);
    Object.defineProperty(navBox, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(navBox, "scrollHeight", { value: 1200, configurable: true });

    const nav = dom.window.buildDiffNav();
    assert(!!nav && nav.hunks.length === 4, `4 处修改：跨 3 个片段，预算耗尽的块不产生刻度（实际 ${nav?.hunks.length}）`);
    assert(nav.hunks.map((h) => h.kind).join(",") === "del,del,meta,del", `按每处首行类型归类（${nav.hunks.map((h) => h.kind).join(",")}）`);
    assert(nav.hunks[2].code === navCodeB && nav.hunks[3].code === navCodeW, "meta 片段与长行片段各自算一处可跳转的修改");
    assert(navCodeC.querySelectorAll(".diff-line").length === 0 && !navCodeC.classList.contains("has-lines"), "预算截断的块没有行也没有 has-lines，不会被画成刻度");
    const ticks = [...rail.querySelectorAll(".diff-rail-tick")];
    assert(ticks.length === 4, `每处修改一个刻度节点，不是每行一个（实际 ${ticks.length}）`);
    assert(rail.hidden === false && rail.style.height === "300px" && rail.style.top === "0px", `刻度轨铺满面板视口（height ${rail.style.height}，top ${rail.style.top}，hidden=${rail.hidden}）`);
    assert(ticks[0].style.top === "60px" && ticks[0].style.height === "10px", `第一处刻度按内容比例定位（top ${ticks[0].style.top}，height ${ticks[0].style.height}，期望 240×0.25 / 40×0.25）`);
    assert(ticks[1].style.top === "125px" && ticks[1].classList.contains("del"), `第二处刻度定位在 500×0.25=125px 并按删除着色（${ticks[1].style.top}，class=${ticks[1].className}）`);
    assert(ticks[2].style.top === "155px" && ticks[2].classList.contains("meta"), `meta 处刻度定位在 620×0.25=155px（${ticks[2].style.top}，class=${ticks[2].className}）`);
    assert(ticks[3].style.top === "215px", `长行换行占 60px 后，第四处刻度按布局坐标定位在 860×0.25=215px（实际 ${ticks[3].style.top}）`);
    assert(ticks[0].title.includes("第 1/4 处修改"), `刻度给出序号提示：「${ticks[0].title}」`);
    assert(!!rail.querySelector(".diff-rail-viewport"), "刻度轨内含当前视口指示器");

    const toolbar = navBox.querySelector(".diff-nav");
    assert(!!toolbar && navBox.firstElementChild === toolbar, "上一处/下一处工具条插在面板内容最前面（吸顶）");
    assert([...toolbar.querySelectorAll(".diff-nav-btn")].map((b) => b.textContent).join("/") === "上一处/下一处", "工具条给出上一处/下一处按钮");
    assert(nav.counter.textContent === "1/4", `打开即定位第一处并显示序号（${nav.counter.textContent}）`);
    assert(navBox.scrollTop === 100, `第一处修改居中（scrollTop ${navBox.scrollTop}，期望 240-(300-20)/2=100）`);
    const currentLines = [...navBox.querySelectorAll(".diff-line.diff-current")];
    assert(currentLines.length === 2 && currentLines[0] === nav.hunks[0].first, "当前处的 del+add 两行被高亮");
    assert(ticks[0].classList.contains("active") && !ticks[1].classList.contains("active"), "刻度轨同步标出当前处");

    nav.nextBtn.click();
    assert(nav.counter.textContent === "2/4", `下一处推进序号（${nav.counter.textContent}）`);
    assert(navBox.scrollTop === 360, `下一处同样居中（${navBox.scrollTop}，期望 500-140=360）`);
    assert(ticks[1].classList.contains("active") && !ticks[0].classList.contains("active"), "刻度高亮跟随当前处移动");
    assert([...navBox.querySelectorAll(".diff-line.diff-current")].length === 2, "高亮只保留在当前处");

    ticks[3].click();
    assert(nav.counter.textContent === "4/4" && nav.hunks[3].first.classList.contains("diff-current"), `点击刻度跨片段跳到长行片段（${nav.counter.textContent}）`);
    assert(navBox.scrollTop === 720, `刻度跳转后目标行居中（${navBox.scrollTop}，期望 860-140=720）`);
    nav.nextBtn.click();
    assert(nav.counter.textContent === "4/4", "末处再点下一处不越界");
    nav.prevBtn.click(); nav.prevBtn.click(); nav.prevBtn.click(); nav.prevBtn.click();
    assert(nav.counter.textContent === "1/4", "首处再点上一处不越界");
    ticks[2].click();
    assert(nav.hunks[2].first.classList.contains("meta") && nav.hunks[2].first.classList.contains("diff-current"), "仅末尾换行的 meta 处也能点刻度定位");
    assert(navBox.scrollTop === 480, `meta 处居中（${navBox.scrollTop}，期望 620-140=480）`);

    navBox.scrollTop = 700;
    navBox.dispatchEvent(new dom.window.Event("scroll"));
    await sleep(30);
    assert(nav.viewport.style.top === "175px" && nav.viewport.style.height === "75px", `滚动时视口指示器跟随（top ${nav.viewport.style.top}，height ${nav.viewport.style.height}，期望 700×0.25 / 300×0.25）`);
    assert(nav.counter.textContent === "3/4", `滚动后按视口中线同步当前序号（${nav.counter.textContent}，中线 850 越过第 3 处）`);

    // 面板尺寸变化 → 换行与总高度都变，刻度比例必须重算，但用户要留在原处
    document.getElementById("diff-panel").classList.add("open");
    Object.defineProperty(navBox, "clientHeight", { value: 600, configurable: true });
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await sleep(30);
    const ticks2 = [...rail.querySelectorAll(".diff-rail-tick")];
    assert(ticks2.length === 4 && ticks2[0].style.top === "120px", `resize 后按新比例重算刻度（top ${ticks2[0]?.style.top}，期望 240×0.5=120px）`);
    assert(rail.style.height === "600px", "刻度轨高度跟随面板视口");
    assert(navBox.scrollTop === 700, `重算刻度不把用户甩回顶部（scrollTop ${navBox.scrollTop}）`);
    assert(navBox.querySelectorAll(".diff-nav").length === 1 && navBox.querySelector(".diff-nav-count").textContent === "4/4", `重建后不残留多余工具条，并按当前滚动位置恢复序号（${navBox.querySelector(".diff-nav-count")?.textContent}）`);

    dom.window.clearDiffNav();
    assert(navBox.querySelector(".diff-nav") === null, "清理后移除工具条");
    assert(rail.hidden === true && rail.children.length === 0, "清理后刻度轨清空并隐藏");
    assert(navBox.querySelectorAll(".diff-line.diff-current").length === 0, "清理后撤掉当前处高亮");
    navBox.scrollTop = 10;
    navBox.dispatchEvent(new dom.window.Event("scroll"));
    await sleep(20);
    assert(rail.children.length === 0, "清理后 scroll 监听已移除，不再画出视口指示器");

    navBox.innerHTML = "";
    navBox.appendChild(mkCode("a", "a"));
    assert(dom.window.buildDiffNav() === null && rail.hidden === true, "无修改时不生成刻度轨");
    navBox.innerHTML = "";
    navBox.appendChild(mkCode("", "x\ny\n", { left: 0 }));
    assert(dom.window.buildDiffNav() === null && rail.hidden === true, "全部被预算截断时不画无法到达的刻度");

    const codeRuleV20 = styleCss.match(/\.diff-code \{[^}]*\}/)?.[0] || "";
    assert(!codeRuleV20.includes("max-height") && codeRuleV20.includes("overflow: hidden;"), `代码块不再自己滚，面板内容独占纵向滚动：${codeRuleV20.replace(/\s+/g, " ")}`);
    assert(!/\.diff-code-wrap|\.diff-ruler/.test(styleCss), "上一版的每块标尺样式已移除");
    assert(/\.diff-rail \{[^}]*position: absolute;/.test(styleCss) && /\.diff-rail\[hidden\] \{ display: none; \}/.test(styleCss), "刻度轨绝对定位在面板右侧，未构建时不占位");
    assert(/\.diff-rail-tick\.add \{ background: #2ea043; \}/.test(styleCss) && /\.diff-rail-tick\.del \{ background: #f85149; \}/.test(styleCss) && /\.diff-rail-tick\.mixed \{ background: linear-gradient/.test(styleCss), "刻度按新增绿/删除红/混合双色着色");
    assert(/\.diff-rail-viewport \{[^}]*pointer-events: none;/.test(styleCss), "视口指示器不拦截刻度点击");
    assert(/\.diff-nav \{[^}]*position: sticky;/.test(styleCss), "上一处/下一处工具条吸顶，长文档里始终可点");
    assert(/\.diff-line\.diff-current \{ box-shadow: inset 3px 0 0 #4a6cf7; \}/.test(styleCss), "当前修改处有左侧高亮条");
    assert(/\.diff-panel-content::-webkit-scrollbar \{ width: 12px; \}/.test(styleCss), "面板滚动条常显（macOS 悬浮滚动条看不出进度）");
    delete navBox.clientHeight;
    delete navBox.scrollHeight;

    // 拆段文件：两段净 Diff + 范围外修改标注
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("seg.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const segLabels = [...document.querySelectorAll("#diff-panel-content .diff-seg-label")].filter((el) => el.textContent.startsWith("净 Diff"));
    assert(segLabels.length === 2, `seg.js 拆为 2 段净 Diff（实际 ${segLabels.length}）`);
    assert(document.getElementById("diff-panel-content").textContent.includes("范围外修改"), "拆段处标注范围外修改");

    // 顺序未知文件：面板明示不可判定，不出净 Diff，也不出逐次明细
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("dup.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const dupPanel = document.getElementById("diff-panel-content");
    assert(dupPanel.textContent.includes("先后顺序无法确定"), "顺序未知时面板明示不可判定");
    assert([...dupPanel.querySelectorAll(".diff-seg-label")].filter((el) => el.textContent.startsWith("净 Diff")).length === 0, "顺序未知时不渲染净 Diff");
    assert(!dupPanel.textContent.includes("逐次操作明细"), "顺序未知时同样不渲染逐次操作明细");

    // ── 历史重载：带 execution 的记录聚合，存量无 execution 的不展示 ──
    historyPayload = {
      sessionId: "sess-diff",
      createdAt: 0,
      lastSeq: 9,
      activeThinking: [],
      messages: [
        { id: "u1", role: "user", text: "干活", timestamp: 1 },
        {
          id: "p1", role: "permission", requestId: "p1", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/h.js", old_string: "a", new_string: "b" },
          messageId: "u1", timestamp: 2, status: "allow",
          execution: { status: "success", filePath: "/x/h.js", before: "a", after: "b", diffAvailable: true, changed: true, seq: 500, finishedAt: 3 },
        },
        {
          id: "p2", role: "permission", requestId: "p2", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/legacy.js", old_string: "a", new_string: "b" },
          messageId: "u1", timestamp: 4, status: "allow",
        },
        {
          // 回报倒序落盘：A 写入更晚（finishedAt 8）但回报先到（seq 小）
          id: "pA", role: "permission", requestId: "pA", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/conc.js", old_string: "y", new_string: "z" },
          messageId: "u1", timestamp: 5, status: "allow",
          execution: { status: "success", filePath: "/x/conc.js", before: "y", after: "z", diffAvailable: true, changed: true, seq: 501, finishedAt: 8 },
        },
        {
          id: "pB", role: "permission", requestId: "pB", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/conc.js", old_string: "x", new_string: "y" },
          messageId: "u1", timestamp: 6, status: "allow",
          execution: { status: "success", filePath: "/x/conc.js", before: "x", after: "y", diffAvailable: true, changed: true, seq: 502, finishedAt: 7 },
        },
        { id: "r2", role: "assistant", character: "YYF", text: "历史回复", replyTo: "u1", timestamp: 9 },
      ],
    };
    dom.window.eval("loadHistory()");
    await waitFor(() => document.querySelector('[data-msg-id="r2"] .file-diff-dir'));
    const histItems = [...document.querySelectorAll('[data-msg-id="r2"] .file-diff-item')];
    const histByPath = (p) => histItems.find((el) => el.querySelector(".file-diff-path")?.textContent === p);
    assert(histItems.length === 2, `历史目录仅 2 个文件（实际 ${histItems.length}）`);
    assert(!!histByPath("h.js"), "历史目录含 h.js");
    assert(!document.querySelector('[data-msg-id="r2"] .file-diff-dir')?.textContent.includes("legacy.js"), "存量无 execution 记录不进目录");
    const histStat = histByPath("h.js")?.querySelector(".file-diff-stat")?.textContent || "";
    assert(histStat.includes("+1") && histStat.includes("-1"), `历史统计 +1/-1: ${histStat}`);
    const histConc = histByPath("conc.js");
    assert(!!histConc && !histConc.textContent.includes("分段"), "历史：回报倒序落盘按快照链重建为单段（与实时一致）");
    const histConcStat = histConc?.querySelector(".file-diff-stat")?.textContent || "";
    assert(histConcStat.includes("+1") && histConcStat.includes("-1"), `历史 conc.js 净统计 +1/-1（x→z）: ${histConcStat}`);

    // 历史重载后面板仍可打开
    histByPath("h.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    assert(document.getElementById("diff-panel-content").textContent.includes("净 Diff"), "历史目录可打开面板");

    // ── P1 回归：审批已入历史快照（无 execution），执行结果在刷新后到达 ──
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    historyPayload = {
      sessionId: "sess-diff",
      createdAt: 0,
      lastSeq: 4,
      activeThinking: [],
      messages: [
        { id: "u1", role: "user", text: "干活", timestamp: 1 },
        {
          id: "pLate", role: "permission", requestId: "late1", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/late.js", old_string: "a", new_string: "b" },
          messageId: "u1", timestamp: 2, status: "allow",
        },
        {
          id: "pPend", role: "permission", requestId: "pend1", character: "YYF", toolName: "Edit",
          input: { file_path: "/x/pend.js", old_string: "c", new_string: "d" },
          messageId: "u1", timestamp: 3, status: "pending",
        },
        { id: "r3", role: "assistant", character: "YYF", text: "完成", replyTo: "u1", timestamp: 4 },
      ],
    };
    dom.window.eval("loadHistory()");
    await waitFor(() => document.querySelector('[data-msg-id="r3"]'));
    assert(document.querySelectorAll('[data-msg-id="r3"] .file-diff-item').length === 0, "无 execution 的历史审批不预先计入目录");

    es.emit("permission-executed", { requestId: "late1", execution: { status: "success", filePath: "/x/late.js", before: "a", after: "b", diffAvailable: true, changed: true, seq: 700, finishedAt: 5 } });
    await waitFor(() => document.querySelector('[data-msg-id="r3"] .file-diff-item'));
    const lateItems = [...document.querySelectorAll('[data-msg-id="r3"] .file-diff-item')];
    assert(lateItems.length === 1, `刷新后到达的执行结果补挂到已渲染回复（实际 ${lateItems.length} 条）`);
    assert(!!lateItems[0] && lateItems[0].textContent.includes("late.js"), "补挂条目为 late.js");

    // 历史里仍是 pending：刷新后才批准并执行，同样不能丢
    es.emit("permission-resolved", { requestId: "pend1", behavior: "allow", message: "已允许" });
    es.emit("permission-executed", { requestId: "pend1", execution: { status: "success", filePath: "/x/pend.js", before: "c", after: "d", diffAvailable: true, changed: true, seq: 701, finishedAt: 6 } });
    await waitFor(() => document.querySelectorAll('[data-msg-id="r3"] .file-diff-item').length === 2);
    assert(document.querySelectorAll('[data-msg-id="r3"] .file-diff-item').length === 2, "刷新后批准并执行的 pending 记录同样计入");

    // ── computeLineDiff 边界：空文件与末尾换行 ──
    const cld = dom.window.computeLineDiff;
    const stat = (x) => dom.window.diffStatLines(x);
    let d = cld(null, "");
    assert(d.lines.length === 0 && stat(d).added === 0 && stat(d).removed === 0, '新空文件（null→""）：0 行，不产生虚假 +1');
    d = cld("", "");
    assert(d.lines.length === 0, "空→空：0 行");
    d = cld("a", "a\n");
    assert(stat(d).added === 0 && stat(d).removed === 0, '"a"→"a\\n"：仅末尾换行变化不计 +/-');
    assert(d.lines.some((l) => l.type === "meta" && l.text.includes("修改前文件末尾无换行")), '"a"→"a\\n"：出现修改前无换行 meta 行');
    d = cld("a\n", "a");
    assert(stat(d).added === 0 && stat(d).removed === 0 && d.lines.some((l) => l.type === "meta" && l.text.includes("修改后文件末尾无换行")), '"a\\n"→"a"：修改后无换行 meta 行且不计 +/-');
    d = cld("a\n", "a\nb\n");
    assert(stat(d).added === 1 && stat(d).removed === 0 && !d.lines.some((l) => l.type === "meta"), '"a\\n"→"a\\nb\\n"：+1/-0，无 meta');
    d = cld(null, "a\n");
    assert(stat(d).added === 1 && stat(d).removed === 0, 'null→"a\\n"：新文件 +1');
    d = cld("a\nb", "a\nb\n");
    assert(stat(d).added === 0 && stat(d).removed === 0, "内容相同仅补末尾换行：0 +/-");

    const largeLines = Array.from({ length: 2022 }, (_, i) => `line ${i}`);
    const largeBefore = largeLines.join("\n") + "\n";
    largeLines[1900] = "updated line 1900";
    const largeDiff = cld(largeBefore, largeLines.join("\n") + "\n");
    assert(!largeDiff.degraded && stat(largeDiff).added === 1 && stat(largeDiff).removed === 1,
      "约 2000 行文件在放宽后的 LCS 预算内计算增删统计");

    const metaBlock = dom.window.buildDiffCodeBlock(cld("a", "a\n"));
    const metaEl = metaBlock.querySelector(".diff-line.meta");
    assert(!!metaEl, "meta 行渲染为 .diff-line.meta");
    assert(metaEl && metaEl.textContent.startsWith("\\"), "meta 行不带 +/- 前缀");
    assert(!metaBlock.querySelector(".diff-line.add") && !metaBlock.querySelector(".diff-line.del"), "仅末尾换行变化时无 add/del 行");

    // ── 渲染预算：纯换行内容绕过 LCS 单元格上限 ──
    const nlAfter = "\n".repeat(40000);
    const nlDiff = cld("", nlAfter);
    assert(nlDiff.degraded === false && nlDiff.lines.length === 40000, `纯换行不触发单元格降级（degraded ${nlDiff.degraded}，行数 ${nlDiff.lines.length}）`);
    const nlBlock = dom.window.buildDiffCodeBlock(nlDiff);
    const nlNodes = nlBlock.querySelectorAll(".diff-line").length;
    const nlNote = nlBlock.querySelector(".diff-note")?.textContent || "";
    assert(nlNodes > 0 && nlNodes < nlDiff.lines.length, `单块渲染行数被截断（节点 ${nlNodes}/${nlDiff.lines.length}）`);
    assert(/^仅渲染前 \d+ 行（共 40000 行）/.test(nlNote), `截断给出明确提示：「${nlNote}」`);

    emitEdit(es, { requestId: "rqBig", filePath: "/x/nl.txt", before: "", after: nlAfter, seq: 900 });
    await waitFor(() => itemByPath("nl.txt"));
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("nl.txt").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const bigPanel = document.getElementById("diff-panel-content");
    assert(bigPanel.querySelectorAll(".diff-line").length === nlNodes, `面板行节点等于单块预算（${bigPanel.querySelectorAll(".diff-line").length}）`);
    assert(bigPanel.querySelectorAll(".diff-change-block").length === 0, "面板不再渲染逐次操作明细节点");

    // ── 面板级总预算：60 段互不连续的快照链 ──
    const segCount = 60;
    const segText = (tag, i) => Array.from({ length: 400 }, (_, k) => `${tag}${i}-${k}`).join("\n");
    for (let i = 0; i < segCount; i++) {
      emitEdit(es, { requestId: `rqM${i}`, filePath: "/x/many.js", before: segText("A", i), after: segText("B", i), seq: 1000 + i });
    }
    await waitFor(() => itemByPath("many.js"));
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("many.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const manyPanel = document.getElementById("diff-panel-content");
    const manyNodes = manyPanel.querySelectorAll(".diff-line").length;
    assert(manyNodes > 0 && manyNodes <= 20000, `多段面板行节点受总预算约束（${manyNodes}）`);
    const manyLabels = manyPanel.querySelectorAll(".diff-seg-label").length;
    assert(manyLabels === segCount, `${segCount} 段标签全部保留（实际 ${manyLabels}）`);
    const manyText = manyPanel.textContent;
    assert(manyText.includes("片段区已达到面板渲染总行数上限 20000"), "超预算时明示面板总上限");
    assert(/\d+\/60 个片段未完整显示/.test(manyText), `超预算时给出省略片段数量（${(manyText.match(/\d+\/60 个片段未完整显示/) || [])[0]}）`);
    assert(manyText.includes("未渲染该块"), "预算耗尽后的片段明示未渲染");
    assert(manyPanel.querySelectorAll(".diff-change-block").length === 0, "多段场景同样不渲染逐次操作明细");
    assert(!manyText.includes("逐次操作明细"), "多段场景不再提示可按需展开明细");

    // ── 占位样式：预算耗尽的空块不得撑出最小高度 ──
    const manyCodes = [...manyPanel.querySelectorAll(".diff-code")];
    const emptyCodes = manyCodes.filter((el) => el.querySelectorAll(".diff-line").length === 0);
    assert(manyCodes.length === segCount, `每段各有一个 diff 代码块（实际 ${manyCodes.length}）`);
    assert(emptyCodes.length === 35, `预算耗尽的空块 35 个（实际 ${emptyCodes.length}）`);
    assert(emptyCodes.every((el) => !el.classList.contains("has-lines")), "空块不带 has-lines，不会被刻度轨当成可跳转的修改处");
    assert(manyCodes.length - emptyCodes.length === 25 && manyCodes.filter((el) => el.querySelectorAll(".diff-line").length > 0).every((el) => el.classList.contains("has-lines")), "有行的块都带 has-lines");
    const baseCodeRule = styleCss.match(/\.diff-code \{[^}]*\}/)?.[0] || "";
    assert(!baseCodeRule.includes("min-height") && !/\.diff-code\.has-lines \{/.test(styleCss), `代码块随内容展开、不再撑最小高度（面板是唯一滚动轨道）：${baseCodeRule.replace(/\s+/g, " ")}`);
    assert(/querySelectorAll\("\.diff-code\.has-lines"\)/.test(appJs), "has-lines 仍是刻度轨挑选可跳转代码块的依据");
    const zeroBudgetBlock = dom.window.buildDiffCodeBlock(cld("", "a\nb\nc"), { left: 0 });
    assert(zeroBudgetBlock.renderedLines === 0 && !zeroBudgetBlock.classList.contains("has-lines"), "预算为 0 的块不渲染行也不带 has-lines");

    // ── 截断原因区分：单块 15000 行、面板总预算未耗尽 ──
    const twoK = Array.from({ length: 15000 }, (_, k) => `L${k}`).join("\n");
    const twoKBudget = { left: 20000 };
    const twoKBlock = dom.window.buildDiffCodeBlock(cld("", twoK), twoKBudget);
    assert(twoKBlock.renderedLines === 12000 && twoKBudget.left === 8000, `单块按 12000 行截断、面板预算剩 8000（rendered ${twoKBlock.renderedLines}，left ${twoKBudget.left}）`);
    assert(twoKBlock.truncatedBy === "block", "截断原因标记为单块上限而非面板预算");
    const twoKNote = twoKBlock.querySelector(".diff-note")?.textContent || "";
    assert(twoKNote.includes("单个 diff 块最多渲染 12000 行") && !twoKNote.includes("面板渲染总行数上限"), `单块截断不谎称面板预算耗尽：「${twoKNote}」`);

    emitEdit(es, { requestId: "rqTwoK", filePath: "/x/twok.txt", before: "", after: twoK, seq: 1200 });
    await waitFor(() => itemByPath("twok.txt"));
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("twok.txt").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const twoKPanel = document.getElementById("diff-panel-content");
    assert(twoKPanel.querySelectorAll(".diff-line").length === 12000, `单段 15000 行面板只渲染 12000（实际 ${twoKPanel.querySelectorAll(".diff-line").length}）`);
    const twoKText = twoKPanel.textContent;
    assert(/1\/1 个片段由单块渲染上限 12000 行截断/.test(twoKText), "面板汇总归因为单块上限");
    assert(!twoKText.includes("面板渲染总行数上限"), "面板总预算未耗尽时不出现总上限文案");
    assert(!twoKText.includes("逐次操作明细"), "单块截断提示不再引导去看逐次明细");

    // ── 混合原因：单块截断与面板预算耗尽同时出现，文案不得互相矛盾 ──
    const truncSeg = (i, n) => ({ before: `H${i}\n`, after: `H${i}\n${Array.from({ length: n }, (_, k) => `s${i}-${k}`).join("\n")}\n` });
    [12999, 2999, 2999, 2999, 2999].forEach((n, i) => {
      const seg = truncSeg(i, n);
      emitEdit(es, { requestId: `rqX${i}`, filePath: "/x/mixtrunc.js", before: seg.before, after: seg.after, seq: 1300 + i });
    });
    await waitFor(() => itemByPath("mixtrunc.js"));
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("mixtrunc.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const truncPanel = document.getElementById("diff-panel-content");
    const truncNotes = [...truncPanel.querySelectorAll(".diff-note")].map((el) => el.textContent);
    assert(truncPanel.querySelectorAll(".diff-line").length === 20000, `混合场景面板仍为 20000 行（实际 ${truncPanel.querySelectorAll(".diff-line").length}）`);
    assert(truncNotes.some((t) => t.startsWith("仅渲染前 12000 行（共 13000 行）：单个 diff 块最多渲染 12000 行")), `首块按单块上限截断：${truncNotes.find((t) => t.startsWith("仅渲染前 12000 行（共 13000 行）"))}`);
    assert(truncNotes.some((t) => t === "未渲染该块（共 3000 行）：已达到面板渲染总行数上限 20000"), "末块因面板预算耗尽未渲染");
    const truncText = truncPanel.textContent;
    assert(/片段区已达到面板渲染总行数上限 20000：2\/5 个片段未完整显示/.test(truncText), `面板预算汇总计数正确：${(truncText.match(/片段区已达到面板渲染总行数上限 20000：\d+\/\d+ 个片段未完整显示/) || [])[0]}`);
    assert(/1\/5 个片段由单块渲染上限 12000 行截断/.test(truncText), "单块截断汇总计数正确");
    assert(!truncText.includes("面板总预算未用尽"), "单块汇总不再断言面板预算状态（避免与总上限提示矛盾）");
    assert(!truncText.includes("逐次操作明细"), "混合截断文案不再提及逐次操作明细");
  } catch (err) {
    console.error("测试异常:", err);
    failed += 1;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
