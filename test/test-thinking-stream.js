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
const codexState = {};
const parseCodex = (event) => __test.parseCodexJsonEvent(
  event,
  (text) => codexText.push(text),
  (meta) => codexMeta.push(meta),
  (runtimeEvent) => codexRuntime.push(runtimeEvent),
  codexState
);

parseCodex({ type: "thread.started", thread_id: "thread-1" });
parseCodex({ type: "turn.started" });
parseCodex({
  type: "item.completed",
  item: { id: "item-0", type: "agent_message", text: "我会先检查调用链。" },
});
assert(codexRuntime.length === 0 && codexText.length === 0, "Codex 首条 agent_message 先暂存以判定是否为最终回复");

parseCodex({
  type: "item.started",
  item: { id: "item-1", type: "command_execution", command: "rg parseCodexJsonEvent" },
});
assert(codexRuntime.length === 1, "Codex 后续开始执行工具时，前一条 agent_message 转为过程信息");
assert(
  codexRuntime[0]?.type === "thinking"
    && codexRuntime[0]?.text === "我会先检查调用链。"
    && codexRuntime[0]?.delta === false,
  "Codex 过程信息保留 agent_message 完整文本"
);

parseCodex({
  type: "item.completed",
  item: { id: "item-2", type: "reasoning", text: "内部推理摘要" },
});
assert(codexRuntime.length === 1, "Codex reasoning item 不再作为 Thinking 过程展示");

parseCodex({
  type: "item.completed",
  item: { id: "item-3", type: "agent_message", text: "最终回复" },
});
parseCodex({
  type: "turn.completed",
  usage: { reasoning_output_tokens: 26 },
});

assert(codexMeta[0]?.sessionId === "thread-1", "Codex thread.started 仍提取 sessionId");
assert(codexText.join("") === "最终回复", "Codex 最后一条 agent_message 作为最终回复");
assert(codexRuntime.length === 1, "Codex 不再生成 reasoning token 占位记录");

const consecutiveText = [];
const consecutiveRuntime = [];
const consecutiveState = {};
const parseConsecutive = (event) => __test.parseCodexJsonEvent(
  event,
  (text) => consecutiveText.push(text),
  () => {},
  (runtimeEvent) => consecutiveRuntime.push(runtimeEvent),
  consecutiveState
);
parseConsecutive({ type: "turn.started" });
parseConsecutive({ type: "item.completed", item: { type: "agent_message", text: "先说明计划" } });
parseConsecutive({ type: "item.completed", item: { type: "agent_message", text: "最终结论" } });
parseConsecutive({ type: "turn.completed" });
assert(consecutiveRuntime[0]?.text === "先说明计划", "连续 agent_message 中前一条归入过程信息");
assert(consecutiveText.join("") === "最终结论", "连续 agent_message 中最后一条作为最终回复");

const singleText = [];
const singleRuntime = [];
const singleState = {};
__test.parseCodexJsonEvent({ type: "turn.started" }, (text) => singleText.push(text), () => {}, (event) => singleRuntime.push(event), singleState);
__test.parseCodexJsonEvent(
  { type: "item.completed", item: { type: "agent_message", text: "只有最终回复" } },
  (text) => singleText.push(text),
  () => {},
  (event) => singleRuntime.push(event),
  singleState
);
__test.parseCodexJsonEvent({ type: "turn.completed" }, (text) => singleText.push(text), () => {}, (event) => singleRuntime.push(event), singleState);
assert(singleRuntime.length === 0, "只有一条 agent_message 时不创建空的 Thinking 过程");
assert(singleText.join("") === "只有最终回复", "只有一条 agent_message 时仍返回最终回复");

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
