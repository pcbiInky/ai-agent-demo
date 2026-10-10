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
    assert(mixPanel.querySelectorAll(".diff-change-block").length === 3, `逐次明细保留 3 条（实际 ${mixPanel.querySelectorAll(".diff-change-block").length}）`);

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
    assert(panel.textContent.includes("逐次操作明细"), "面板含逐次操作明细");

    // 拆段文件：两段净 Diff + 范围外修改标注
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("seg.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const segLabels = [...document.querySelectorAll("#diff-panel-content .diff-seg-label")].filter((el) => el.textContent.startsWith("净 Diff"));
    assert(segLabels.length === 2, `seg.js 拆为 2 段净 Diff（实际 ${segLabels.length}）`);
    assert(document.getElementById("diff-panel-content").textContent.includes("范围外修改"), "拆段处标注范围外修改");

    // 顺序未知文件：面板明示不可判定，不出净 Diff，但保留逐次明细
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("dup.js").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const dupPanel = document.getElementById("diff-panel-content");
    assert(dupPanel.textContent.includes("先后顺序无法确定"), "顺序未知时面板明示不可判定");
    assert([...dupPanel.querySelectorAll(".diff-seg-label")].filter((el) => el.textContent.startsWith("净 Diff")).length === 0, "顺序未知时不渲染净 Diff");
    assert(dupPanel.querySelectorAll(".diff-change-block").length === 2, "顺序未知仍保留逐次操作明细");

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
    const bigBlocks = bigPanel.querySelectorAll(".diff-change-block");
    assert(bigBlocks.length === 1, `逐次明细 1 条（实际 ${bigBlocks.length}）`);
    assert(bigBlocks[0].querySelectorAll(".diff-line").length === 0, "折叠状态的明细不渲染 diff 行");
    assert(bigPanel.querySelectorAll(".diff-line").length <= nlNodes, `面板初始行节点有界（${bigPanel.querySelectorAll(".diff-line").length}）`);
    bigBlocks[0].open = true;
    bigBlocks[0].dispatchEvent(new dom.window.Event("toggle"));
    await waitFor(() => bigBlocks[0].querySelectorAll(".diff-line").length > 0);
    assert(bigBlocks[0].querySelectorAll(".diff-line").length <= nlNodes, "展开后的明细同样受渲染预算约束");

    // ── 面板级总预算：60 段互不连续的快照链 ──
    const segCount = 60;
    const segText = (tag, i) => Array.from({ length: 100 }, (_, k) => `${tag}${i}-${k}`).join("\n");
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
    assert(manyNodes > 0 && manyNodes <= 6000, `多段面板行节点受总预算约束（${manyNodes}）`);
    const manyLabels = manyPanel.querySelectorAll(".diff-seg-label").length;
    assert(manyLabels >= segCount, `${segCount} 段标签全部保留（实际 ${manyLabels}）`);
    const manyText = manyPanel.textContent;
    assert(manyText.includes("片段区已达到面板渲染总行数上限 6000"), "超预算时明示面板总上限");
    assert(/\d+\/60 个片段未完整显示/.test(manyText), `超预算时给出省略片段数量（${(manyText.match(/\d+\/60 个片段未完整显示/) || [])[0]}）`);
    assert(manyText.includes("未渲染该块"), "预算耗尽后的片段明示未渲染");
    const manyBlocks = manyPanel.querySelectorAll(".diff-change-block");
    assert(manyBlocks.length === segCount, `逐次明细 ${segCount} 条（实际 ${manyBlocks.length}）`);
    assert(manyPanel.querySelectorAll(".diff-change-block .diff-line").length === 0, "多段场景下折叠明细不渲染行");
    manyBlocks[0].open = true;
    manyBlocks[0].dispatchEvent(new dom.window.Event("toggle"));
    await waitFor(() => manyBlocks[0].querySelectorAll(".diff-line").length > 0);
    const afterOpen = manyPanel.querySelectorAll(".diff-line").length;
    assert(afterOpen <= 12000, `展开单条明细后总节点仍受双预算约束（${afterOpen}）`);

    // ── 截断原因区分：单块 2000 行、面板总预算未耗尽 ──
    const twoK = Array.from({ length: 2000 }, (_, k) => `L${k}`).join("\n");
    const twoKBudget = { left: 6000 };
    const twoKBlock = dom.window.buildDiffCodeBlock(cld("", twoK), twoKBudget);
    assert(twoKBlock.renderedLines === 1500 && twoKBudget.left === 4500, `单块按 1500 行截断、面板预算剩 4500（rendered ${twoKBlock.renderedLines}，left ${twoKBudget.left}）`);
    assert(twoKBlock.truncatedBy === "block", "截断原因标记为单块上限而非面板预算");
    const twoKNote = twoKBlock.querySelector(".diff-note")?.textContent || "";
    assert(twoKNote.includes("单个 diff 块最多渲染 1500 行") && !twoKNote.includes("面板渲染总行数上限"), `单块截断不谎称面板预算耗尽：「${twoKNote}」`);

    emitEdit(es, { requestId: "rqTwoK", filePath: "/x/twok.txt", before: "", after: twoK, seq: 1200 });
    await waitFor(() => itemByPath("twok.txt"));
    document.getElementById("diff-close-btn").click();
    await sleep(300);
    itemByPath("twok.txt").click();
    await waitFor(() => document.getElementById("diff-panel").classList.contains("visible"));
    const twoKPanel = document.getElementById("diff-panel-content");
    assert(twoKPanel.querySelectorAll(".diff-line").length === 1500, `单段 2000 行面板只渲染 1500（实际 ${twoKPanel.querySelectorAll(".diff-line").length}）`);
    const twoKText = twoKPanel.textContent;
    assert(/1\/1 个片段由单块渲染上限 1500 行截断/.test(twoKText), "面板汇总归因为单块上限");
    assert(!twoKText.includes("面板渲染总行数上限"), "面板总预算未耗尽时不出现总上限文案");
    assert(twoKText.includes("被截去的尾部在逐次操作明细中同样不会显示"), "不承诺明细能展示单块截去的尾部");

    // ── 混合原因：单块截断与面板预算耗尽同时出现，文案不得互相矛盾 ──
    const truncSeg = (i, n) => ({ before: `H${i}\n`, after: `H${i}\n${Array.from({ length: n }, (_, k) => `s${i}-${k}`).join("\n")}\n` });
    [1999, 1499, 1499, 1499, 1499].forEach((n, i) => {
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
    assert(truncPanel.querySelectorAll(".diff-line").length === 6000, `混合场景面板仍为 6000 行（实际 ${truncPanel.querySelectorAll(".diff-line").length}）`);
    assert(truncNotes.some((t) => t.startsWith("仅渲染前 1500 行（共 2000 行）：单个 diff 块最多渲染 1500 行")), `首块按单块上限截断：${truncNotes.find((t) => t.startsWith("仅渲染前 1500 行（共 2000 行）"))}`);
    assert(truncNotes.some((t) => t === "未渲染该块（共 1500 行）：已达到面板渲染总行数上限 6000"), "末块因面板预算耗尽未渲染");
    const truncText = truncPanel.textContent;
    assert(/片段区已达到面板渲染总行数上限 6000：1\/5 个片段未完整显示/.test(truncText), `面板预算汇总计数正确：${(truncText.match(/片段区已达到面板渲染总行数上限 6000：\d+\/\d+ 个片段未完整显示/) || [])[0]}`);
    assert(/1\/5 个片段由单块渲染上限 1500 行截断/.test(truncText), "单块截断汇总计数正确");
    assert(!truncText.includes("面板总预算未用尽"), "单块汇总不再断言面板预算状态（避免与总上限提示矛盾）");
  } catch (err) {
    console.error("测试异常:", err);
    failed += 1;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
