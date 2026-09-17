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
    ]) === "优化左侧栏 并显示未读数",
    "未设置标题时使用第一条用户聊天记录，并去掉 @角色",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "@YYF @晔晔 一起看下这个改动", mentions: ["YYF", "晔晔"] },
    ]) === "一起看下这个改动",
    "按 mentions 精确去掉多个 @角色",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "@YYF 看下 @YY 这个", mentions: ["YY", "YYF"] },
    ]) === "看下 这个",
    "角色名互为前缀时长名优先，不残留半个名字",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "联系 foo@bar.com 看下 @YYF" },
    ]) === "联系 foo@bar.com 看下",
    "旧记录无 mentions 时保守去 @角色，不误伤邮箱",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "联系 foo@YYF.com，稍后 @YYF 处理", mentions: ["YYF"] },
    ]) === "联系 foo@YYF.com，稍后 处理",
    "携带 mentions 时保留邮箱，只删真正的 @角色 token",
  );
  assert(
    sessionStore.resolveDisplayTitle(
      session,
      [{ role: "user", text: "@YYF帮我检查修改" }],
      ["YYF"],
    ) === "帮我检查修改",
    "旧记录无空格时按角色名边界清理，不吞正文",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "@YYF：帮我检查修改", mentions: ["YYF"] },
    ]) === "帮我检查修改",
    "清理 mention 后紧邻的中文冒号",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "你好@YYF", mentions: ["YYF"] },
    ]) === "你好@YYF",
    "任意语言字母紧邻 @ 前时保留原文（Unicode 边界）",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "用户@YYF.com 请联系 @YYF", mentions: ["YYF"] },
    ]) === "用户@YYF.com 请联系",
    "中文邮箱/标识符中的 @角色 不被误删，只删真正的召唤",
  );
  assert(
    sessionStore.resolveDisplayTitle(
      session,
      [{ role: "user", text: "用户@YYF.com 请联系 @YYF" }],
      ["YYF"],
    ) === "用户@YYF.com 请联系",
    "旧记录按角色名清理时同样遵守 Unicode 边界",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "@YYF", mentions: ["YYF"] },
      { role: "user", text: "真正的第一条内容" },
    ]) === "真正的第一条内容",
    "第一条只有 @角色时顺延到下一条用户消息",
  );
  assert(
    sessionStore.resolveDisplayTitle(session, [
      { role: "user", text: "@YYF", mentions: ["YYF"] },
    ]) === "新对话",
    "用户消息都只有 @角色时回退默认标题",
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
