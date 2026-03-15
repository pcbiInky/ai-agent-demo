#!/usr/bin/env node
/**
 * CI 校验脚本 - 校验 .ai_agent_demo_skill/ 目录中的 Skill 文件
 * 复用 skill-loader.js 的校验逻辑
 *
 * 用法: node scripts/validate_skills.js
 * 退出码: 0=通过, 1=有 Error 级别问题
 */
const path = require("path");

// 调整 __dirname 让 skill-loader 能正确定位 .ai_agent_demo_skill/
// skill-loader.js 使用自己的 __dirname 定位，所以直接 require 即可
const { loadSkills, printSkillStartupLog } = require(path.join(__dirname, "..", "skill-loader"));

// 已知 MCP 工具名列表（与 invoke.js 中的 MCP_TOOL_NAMES 保持一致）
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

console.log("🔍 Validating skills...\n");

const { errors, warnings } = loadSkills(MCP_TOOL_NAMES);
printSkillStartupLog();

if (errors.length > 0) {
  console.error(`\n❌ Validation FAILED: ${errors.length} error(s) found`);
  process.exit(1);
} else if (warnings.length > 0) {
  console.log(`\n⚠️  Validation PASSED with ${warnings.length} warning(s)`);
  process.exit(0);
} else {
  console.log("\n✅ Validation PASSED");
  process.exit(0);
}
