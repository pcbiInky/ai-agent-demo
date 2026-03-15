# Skill Schema V1

## 目录结构

```text
.ai_agent_demo_skill/
├── use_ai_agent_demo_skills.json
└── skills/
    └── <skill_id>/
        ├── SKILL.md
        └── meta.json
```

## use_ai_agent_demo_skills.json

```json
{
  "global": ["use-ai-agent-demo-skill"],
  "roles": {
    "YYF": ["some-role-skill"]
  },
  "scenes": {
    "code_review": ["code-review"],
    "skill_creation": ["create-ai-agent-demo-skill"],
    "file_ops": ["mcp-file-ops"]
  },
  "loadOrder": "global-first"
}
```

- `global`: 所有角色都会命中的基础 Skill。
- `roles`: 角色级附加 Skill。
- `scenes`: 场景到 Skill 的绑定表。
- `loadOrder`: `global-first` 或 `role-first`。

## SKILL.md frontmatter

```md
---
name: Code Review
description: 代码审查规范
type: behavior
---
```

- `name`: 必填。
- `description`: 必填。
- `type`: 必填，合法值为 `behavior | tooling | global_constraint`。

## meta.json

```json
{
  "owner": "system",
  "model_support": ["claude", "trae", "codex"],
  "priority": 90,
  "requireTools": ["Read", "Grep"],
  "defaultEnabled": true
}
```

- `owner`: 可选。
- `model_support`: 可选，默认全部模型。
- `priority`: 可选，数值越大越靠前。
- `requireTools`: `tooling` 类型可选，用于声明依赖的 MCP 工具。
- `defaultEnabled`: 可选，默认 `true`。

## 当前硬编码场景

- `code_review`
- `skill_creation`
- `file_ops`

当前 V1 的场景识别规则写在 `skill-router.js`，暂不做可配置 trigger。
