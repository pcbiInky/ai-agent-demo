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
assert(codexRuntime.length === 0, "Codex 工具事件不会把 agent_message 误判为最终回复");

parseCodex({
  type: "item.completed",
  item: { id: "item-2", type: "reasoning", text: "内部推理摘要" },
});
assert(codexRuntime.length === 0, "Codex reasoning item 不作为 Thinking 过程展示");

parseCodex({
  type: "item.completed",
  item: { id: "item-3", type: "agent_message", text: "最后一条过程说明" },
});
assert(
  codexRuntime.length === 1
    && codexRuntime[0]?.type === "thinking"
    && codexRuntime[0]?.text === "我会先检查调用链。"
    && codexRuntime[0]?.delta === false,
  "下一条 agent_message 到达时，前一条完整写入 Thinking"
);
parseCodex({
  type: "turn.completed",
  usage: { reasoning_output_tokens: 26 },
});

assert(codexMeta[0]?.sessionId === "thread-1", "Codex thread.started 仍提取 sessionId");
assert(codexText.join("") === "最后一条过程说明", "Codex 最后一条 agent_message 仅保留作协议违规诊断");
assert(codexRuntime.length === 2, "Codex 所有 agent_message 都写入 Thinking");
assert(
  codexRuntime[1]?.text === "────────────────\n最后一条过程说明",
  "Codex 最后一条 agent_message 前增加横线"
);

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
parseConsecutive({ type: "item.completed", item: { type: "agent_message", text: "最后一条说明" } });
parseConsecutive({ type: "turn.completed" });
assert(consecutiveRuntime[0]?.text === "先说明计划", "连续 agent_message 中前一条归入 Thinking");
assert(
  consecutiveRuntime[1]?.text === "────────────────\n最后一条说明",
  "连续 agent_message 中最后一条带横线归入 Thinking"
);
assert(consecutiveText.join("") === "最后一条说明", "最后一条文本只保留作协议违规诊断");

const singleText = [];
const singleRuntime = [];
const singleState = {};
__test.parseCodexJsonEvent({ type: "turn.started" }, (text) => singleText.push(text), () => {}, (event) => singleRuntime.push(event), singleState);
__test.parseCodexJsonEvent(
  { type: "item.completed", item: { type: "agent_message", text: "唯一一条过程说明" } },
  (text) => singleText.push(text),
  () => {},
  (event) => singleRuntime.push(event),
  singleState
);
__test.parseCodexJsonEvent({ type: "turn.completed" }, (text) => singleText.push(text), () => {}, (event) => singleRuntime.push(event), singleState);
assert(
  singleRuntime.length === 1
    && singleRuntime[0]?.text === "────────────────\n唯一一条过程说明",
  "只有一条 agent_message 时也创建带横线的 Thinking 过程"
);
assert(singleText.join("") === "唯一一条过程说明", "唯一一条文本保留作协议违规诊断");

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
