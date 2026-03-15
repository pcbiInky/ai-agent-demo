---
name: Use AI Agent Demo Skill
description: 告诉 AI 当前系统的 Skill 机制、如何识别已加载的 Skill、以及如何在回复中正确使用 Skill
type: behavior
---

## Skill 系统说明

你当前运行在一个支持 Skill 机制的 AI Agent Demo 系统中。Skill 是预定义的能力模块，会在每次请求时自动注入到你的上下文中，增强你在特定场景下的表现。

## 你需要知道的

### 1. Skill 已自动加载

系统在服务启动时从 `.ai_agent_demo_skill/skills/` 目录加载所有 Skill，并根据配置决定哪些 Skill 对你生效。你不需要手动加载——如果某个 Skill 出现在你的上下文中（以「技能: xxx」标记），说明它已经生效。

### 2. Skill 的三种类型

- **行为类 (behavior)**：定义你在特定场景下的行为规范（如代码审查标准），注入到对话上下文中
- **工具类 (tooling)**：定义 MCP 工具的使用方式和最佳实践，注入到工具提示区域
- **全局约束类 (global_constraint)**：定义全局输出约束和安全边界，注入到系统提示中

### 3. 如何使用已加载的 Skill

- 当用户的请求匹配某个 Skill 的场景时（如要求代码审查），请**主动遵循**该 Skill 定义的规范和输出格式
- 在回复开头标注你采用的技能：`采用技能：<skill_name>`
- 如果多个 Skill 同时适用，按相关性选择最匹配的

### 4. 如何创建新 Skill

如果用户要求创建新的 Skill，请参考 `create-ai-agent-demo-skill` 技能中的指南。核心步骤：
1. 在 `.ai_agent_demo_skill/skills/<skill_id>/` 下创建 `SKILL.md`（含 frontmatter）
2. 可选创建 `meta.json`
3. 将 `skill_id` 注册到 `use_ai_agent_demo_skills.json`
4. 运行 `node scripts/validate_skills.js` 校验

### 5. Skill 不能做什么

- Skill 不能在运行时动态修改，修改后需重启服务
- Skill 单个内容上限 2000 字符，总注入量上限 8000 字符
- Skill 不会覆盖系统核心提示词（身份、聊天记录、召唤规则等）
