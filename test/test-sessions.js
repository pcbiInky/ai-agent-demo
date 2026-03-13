#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const sessionStore = require("../role-system/sessions");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed += 1;
  } else {
    console.log(`❌ ${label}`);
    failed += 1;
  }
}

const sessionId = `test-session-${Date.now()}`;
const sessionPath = path.join(__dirname, "..", "role-system", "data", "sessions", `${sessionId}.json`);

try {
  const session = sessionStore.getOrCreateSession(sessionId, ["role_a"]);
  assert(session.title === "新对话", "新会话默认标题为新对话");
  assert(session.workingDirectory === "", "新会话默认工作目录为空");

  const updated = sessionStore.updateSessionMeta(sessionId, {
    title: "调试工作区",
    workingDirectory: "/Users/inky/code/ai-agent-demo",
  });
  assert(updated.title === "调试工作区", "更新标题成功");
  assert(updated.workingDirectory === "/Users/inky/code/ai-agent-demo", "更新工作目录成功");

  const reread = sessionStore.readSession(sessionId);
  assert(reread.title === "调试工作区", "重读能拿到标题");
  assert(reread.workingDirectory === "/Users/inky/code/ai-agent-demo", "重读能拿到工作目录");
} finally {
  try {
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  } catch {
    // ignore cleanup failure in tests
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
