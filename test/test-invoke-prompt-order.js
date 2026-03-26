#!/usr/bin/env node

const { __test } = require("../invoke.js");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }

  console.log(`FAIL ${label}`);
  failed += 1;
}

function main() {
  const basePrompt = "【你的身份】\n你是 YYF";
  const mcpHint = __test.buildMcpHint();
  const globalConstraint = "【技能: Demo】\n这里是一个很长的技能说明";

  const nonSystemPrompt = __test.buildUserPromptForCli(basePrompt, {
    supportsSystemPrompt: false,
    mcpHint,
    globalConstraintContent: globalConstraint,
  });

  assert(
    nonSystemPrompt.startsWith("【最重要协议】"),
    "non-system CLI prompt starts with MCP protocol header"
  );
  assert(
    nonSystemPrompt.indexOf(basePrompt) > nonSystemPrompt.indexOf(globalConstraint),
    "non-system CLI keeps base prompt after protocol and global constraints"
  );

  const systemPrompt = __test.buildUserPromptForCli(basePrompt, {
    supportsSystemPrompt: true,
    mcpHint,
    globalConstraintContent: globalConstraint,
  });

  assert(
    systemPrompt === basePrompt,
    "system-prompt CLI leaves base prompt unchanged"
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
