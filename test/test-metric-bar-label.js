#!/usr/bin/env node
// renderMetricBar 标签规则回归测试（jsdom）：
// 5h 短周期窗口（codex key=5h / claude key=primary+label=5h）居首位时标签显示重置时间；
// month 等长周期窗口即使居首位且有 resetsAt 也显示维度名（qodercn balance / kimi month），
// 重置时间保留在 tooltip。
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

const stubFetch = (url) => {
  const ok = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  if (url.includes("/api/history")) return ok({ sessionId: "sess-label", createdAt: 0, messages: [], lastSeq: 0, activeThinking: [] });
  if (url.includes("/api/characters")) return ok({ characters: {} });
  if (url.includes("skill-traces")) return ok({ traces: [] });
  if (url.includes("/api/skills")) return ok({ skills: [] });
  return ok(url.includes("/api/sessions") ? { sessions: [] } : {});
};

class MockEventSource {
  addEventListener() {}
  close() {}
}

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>${IDS.map((id) => `<div id="${id}"></div>`).join("")}</body></html>`,
  {
    runScripts: "outside-only",
    url: "http://localhost/",
    beforeParse(window) {
      window.fetch = stubFetch;
      window.EventSource = MockEventSource;
      window.sessionStorage.setItem("sessionId", "sess-label");
      if (!window.crypto || !window.crypto.randomUUID) {
        window.crypto = { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) };
      }
    },
  }
);

dom.window.eval(appJs);

const render = (win, index) => {
  const html = dom.window.eval(`renderMetricBar(${JSON.stringify(win)}, ${index})`);
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const labelEl = doc.querySelector(".metric-bar-label");
  return { label: labelEl?.textContent || "", title: labelEl?.getAttribute("title") || "", labelClass: labelEl?.className || "" };
};

const RESET_5H = Date.now() + 3 * 3600 * 1000;
const RESET_MONTH = 1794240000000;

// codex：5h 居首位显示时间
const codex5h = render({ key: "5h", label: "5h", usedPercent: 40, resetsAt: RESET_5H }, 0);
assert(codex5h.label !== "5h" && codex5h.label.includes(":"), `codex 首行 5h 显示时间: ${codex5h.label}`);
assert(codex5h.labelClass.includes("metric-time-label"), "codex 首行 5h 使用时间标签样式");

// claude：5h 窗口实际是 key=primary、label=5h，同样显示时间
const claude5h = render({ key: "primary", label: "5h", usedPercent: 40, resetsAt: RESET_5H }, 0);
assert(claude5h.label !== "5h" && claude5h.label.includes(":"), `claude 首行 5h(key=primary) 显示时间: ${claude5h.label}`);

// qodercn：balance(month) 居首位且有 resetsAt，仍显示 month
const qoderMonth = render({ key: "balance", label: "month", usedPercent: 99, resetsAt: RESET_MONTH, detail: "剩余 2281 / 总量 2283 credits" }, 0);
assert(qoderMonth.label === "month", `qodercn 首行显示 month: ${qoderMonth.label}`);
assert(!qoderMonth.labelClass.includes("metric-time-label"), "qodercn month 不用时间标签样式");
assert(qoderMonth.title.includes("重置"), "qodercn month 的重置时间保留在 tooltip");
assert(qoderMonth.title.includes("剩余 2281 / 总量 2283 credits"), "qodercn month 的明细保留在 tooltip");

// kimi：month 居次位显示 month（既有行为不回退）
const kimiMonth = render({ key: "month", label: "month", usedPercent: 95, resetsAt: RESET_MONTH }, 1);
assert(kimiMonth.label === "month", `kimi 次行显示 month: ${kimiMonth.label}`);

// codex week 居次位显示维度名（既有行为不回退）
const codexWeek = render({ key: "week", label: "week", usedPercent: 60, resetsAt: RESET_MONTH }, 1);
assert(codexWeek.label === "week", `codex 次行显示 week: ${codexWeek.label}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
