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
  assert(session.titleCustomized === false, "新会话标题标记为未自定义");
  assert(session.workingDirectory === "", "新会话默认工作目录为空");
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "assistant", text: "先出现的角色消息" },
      { role: "user", text: "  @YYF   优化左侧栏\n并显示未读数  " },
    ]) === "@YYF 优化左侧栏 并显示未读数",
    "未设置标题时使用第一条用户聊天记录",
  );

  const updated = sessionStore.updateSessionMeta(sessionId, {
    title: "调试工作区",
    workingDirectory: "/Users/inky/code/ai-agent-demo",
  });
  assert(updated.title === "调试工作区", "更新标题成功");
  assert(updated.titleCustomized === true, "设置标题后标记为已自定义");
  assert(
    sessionStore.resolveDisplayTitle(updated, [{ role: "user", text: "第一条消息" }]) === "调试工作区",
    "自定义标题优先于第一条聊天记录",
  );
  assert(updated.workingDirectory === "/Users/inky/code/ai-agent-demo", "更新工作目录成功");

  const reread = sessionStore.readSession(sessionId);
  assert(reread.title === "调试工作区", "重读能拿到标题");
  assert(reread.titleCustomized === true, "重读能保留自定义标题标记");
  assert(reread.workingDirectory === "/Users/inky/code/ai-agent-demo", "重读能拿到工作目录");

  const cleared = sessionStore.updateSessionMeta(sessionId, { title: "" });
  assert(cleared.title === "新对话", "清空标题后恢复默认占位");
  assert(cleared.titleCustomized === false, "清空标题后恢复自动标题模式");
} finally {
  try {
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  } catch {
    // ignore cleanup failure in tests
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
