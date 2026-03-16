#!/usr/bin/env node

const roleStore = require("../role-system/roles");
const { loadSkills } = require("../skill-loader");
const { resolveRequestSkills, detectScenes } = require("../skill-router");

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

const { errors } = loadSkills({
  knownMcpTools: MCP_TOOL_NAMES,
  knownRoles: roleStore.listRoles({ includeArchived: true }).map((role) => role.name),
});

assert(errors.length === 0, "Skill 加载无 Error");
assert(detectScenes("请帮我做一次代码审查").includes("code_review"), "代码审查场景识别正常");
assert(detectScenes("帮我创建一个新的 skill").includes("skill_creation"), "Skill 创建场景识别正常");
assert(detectScenes("请读取这个文件并修改函数").includes("file_ops"), "文件操作场景识别正常");
assert(detectScenes("帮我看这个 GitCode PR 链接 https://gitcode.com/foo/bar/pull/27").includes("gitcode_pr"), "GitCode PR 场景识别正常");

const reviewDecision = resolveRequestSkills({
  prompt: "请帮我做一次代码审查",
  character: "YYF",
  supportsPermissionTool: true,
});
assert(reviewDecision.hitSkills.some((skill) => skill.id === "use-ai-agent-demo-skill"), "基础全局 Skill 会命中");
assert(reviewDecision.hitSkills.some((skill) => skill.id === "code-review"), "代码审查请求命中 code-review");
assert(!reviewDecision.hitSkills.some((skill) => skill.id === "create-ai-agent-demo-skill"), "代码审查请求不会误命中创建 Skill");

const creationDecision = resolveRequestSkills({
  prompt: "请帮我创建一个新的 skill 文件",
  character: "YYF",
  supportsPermissionTool: true,
});
assert(creationDecision.hitSkills.some((skill) => skill.id === "create-ai-agent-demo-skill"), "创建 Skill 请求命中 create-ai-agent-demo-skill");

const prDecision = resolveRequestSkills({
  prompt: "帮我看这个 GitCode PR 链接 https://gitcode.com/foo/bar/pull/27 做一轮代码检视",
  character: "YYF",
  supportsPermissionTool: true,
});
assert(prDecision.hitSkills.some((skill) => skill.id === "gitcode-pr-helper"), "GitCode PR 请求命中 gitcode-pr-helper");

const genericDecision = resolveRequestSkills({
  prompt: "你好，简单介绍一下你自己",
  character: "YYF",
  supportsPermissionTool: true,
});
assert(genericDecision.hitSkills.length === 1 && genericDecision.hitSkills[0].id === "use-ai-agent-demo-skill", "普通聊天只命中基础 Skill");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
