#!/usr/bin/env node

process.env.PORT = String(3210 + Math.floor(Math.random() * 200));
process.env.ENFORCE_MCP_SENDMESSAGE = "false";

const server = require("../server");

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

async function main() {
  try {
    const decision = server.__test.buildSkillDecision("session-skill-test", "请帮我做一次代码审查", "YYF");
    const prompt = server.__test.buildContextPrompt("session-skill-test", "请帮我做一次代码审查", "YYF", { skillDecision: decision });

    assert(decision.hitSkills.some((skill) => skill.id === "code-review"), "server 侧决策命中 code-review");
    assert(prompt.includes("【技能: Code Review】"), "buildContextPrompt 注入 code-review 内容");
    assert(server.__test.getSkillBindings("code-review").scenes.includes("code_review"), "Skill bindings 可返回场景绑定");

    const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/skills`);
    const data = await res.json();
    assert(res.ok, "/api/skills 可访问");
    assert(Array.isArray(data.skills) && data.skills.some((skill) => skill.id === "code-review"), "/api/skills 返回 skill 列表");

    const tracesRes = await fetch(`http://127.0.0.1:${process.env.PORT}/api/sessions/session-skill-test/skill-traces`);
    const tracesData = await tracesRes.json();
    assert(tracesRes.ok, "/api/sessions/:id/skill-traces 可访问");
    assert(Array.isArray(tracesData.traces), "skill trace API 返回数组");
  } finally {
    server.closeServer();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  try { server.closeServer(); } catch {}
  process.exit(1);
});
