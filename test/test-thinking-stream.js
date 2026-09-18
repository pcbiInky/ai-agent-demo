#!/usr/bin/env node

const { __test } = require("../invoke");

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

const codexText = [];
const codexMeta = [];
const codexRuntime = [];
__test.parseCodexJsonEvent(
  { type: "thread.started", thread_id: "thread-1" },
  (text) => codexText.push(text),
  (meta) => codexMeta.push(meta),
  (event) => codexRuntime.push(event)
);
__test.parseCodexJsonEvent(
  { type: "item.completed", item: { type: "reasoning", text: "检查调用链" } },
  (text) => codexText.push(text),
  (meta) => codexMeta.push(meta),
  (event) => codexRuntime.push(event)
);
__test.parseCodexJsonEvent(
  { type: "item.completed", item: { type: "agent_message", text: "最终回复" } },
  (text) => codexText.push(text),
  (meta) => codexMeta.push(meta),
  (event) => codexRuntime.push(event)
);

assert(codexMeta[0]?.sessionId === "thread-1", "Codex thread.started 仍提取 sessionId");
assert(codexRuntime.length === 1 && codexRuntime[0].type === "thinking", "Codex reasoning 转换为 thinking 运行时事件");
assert(codexRuntime[0]?.text === "检查调用链" && codexRuntime[0]?.delta === false, "Codex thinking 保留完整文本语义");
assert(codexText.join("") === "最终回复", "Codex agent_message 仍作为最终文本");

const claudeText = [];
const claudeRuntime = [];
__test.parseClaudeJsonEvent(
  {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "分析问题" },
        { type: "text", text: "最终答案" },
      ],
    },
  },
  (text) => claudeText.push(text),
  () => {},
  (event) => claudeRuntime.push(event)
);

assert(claudeRuntime.length === 1 && claudeRuntime[0].text === "分析问题", "Claude thinking block 转换为 thinking 运行时事件");
assert(claudeText.join("") === "最终答案", "Claude text block 仍作为最终文本");

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
