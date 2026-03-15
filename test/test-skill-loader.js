#!/usr/bin/env node

const roleStore = require("../role-system/roles");
const { loadSkills, getAllSkills, getSkillConfig } = require("../skill-loader");

const MCP_TOOL_NAMES = [
  "mcp__permission__Bash",
  "mcp__permission__Read",
  "mcp__permission__Edit",
  "mcp__permission__Write",
  "mcp__permission__Glob",
  "mcp__permission__Grep",
  "mcp__permission__WebFetch",
  "mcp__permission__WebSearch",
  "mcp__permission__NotebookEdit",
];

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

const result = loadSkills({
  knownMcpTools: MCP_TOOL_NAMES,
  knownRoles: roleStore.listRoles({ includeArchived: true }).map((role) => role.name),
});

assert(result.errors.length === 0, "loadSkills 无 Error");
assert(Array.isArray(result.warnings), "loadSkills 返回 warnings 数组");
assert(getAllSkills().length >= 4, "Skill registry 已加载示例 Skill");
assert(getSkillConfig().global.includes("use-ai-agent-demo-skill"), "global 配置已收缩为基础 Skill");
assert(getSkillConfig().scenes.code_review.includes("code-review"), "scene 绑定包含 code-review");
assert(getSkillConfig().scenes.skill_creation.includes("create-ai-agent-demo-skill"), "scene 绑定包含 create-ai-agent-demo-skill");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
