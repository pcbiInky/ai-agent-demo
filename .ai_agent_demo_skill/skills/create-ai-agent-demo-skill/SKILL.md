---
name: Create AI Agent Demo Skill
description: 指导如何创建新的 Skill，包含目录格式、文件规范、注册流程和校验规则
type: behavior
---

## 创建新 Skill 的完整流程

### 第一步：创建 Skill 目录和文件

在 `.ai_agent_demo_skill/skills/` 下新建以 `skill_id` 命名的目录：

```
.ai_agent_demo_skill/skills/<skill_id>/
├── SKILL.md      （必需）Skill 内容，含 frontmatter + 正文
└── meta.json     （可选）元信息：owner、model_support、max_chars
```

`skill_id` 规则：小写字母 + 数字 + 连字符，如 `code-review`、`mcp-file-ops`。

### 第二步：编写 SKILL.md

必须包含 YAML frontmatter（`---` 包裹），必填字段：

```markdown
---
name: 技能名称
description: 一句话描述技能用途
type: behavior | tooling | global_constraint
---

正文内容（Markdown 格式）
```

**type 说明：**
- `behavior`：行为规范类（审查规则、输出风格）→ 注入到 `buildContextPrompt()`
- `tooling`：工具使用类（MCP 工具用法）→ 注入到 `invoke()` 的 mcpHint 附近
- `global_constraint`：全局约束类（安全边界、输出格式）→ 注入到 systemPrompt

**正文约束：**
- 变量占位统一用 `{{var_name}}`
- 工具声明用 `Required MCP Tools: tool_a, tool_b`
- few-shot 格式用 `User:` / `Assistant:`
- 单个 Skill 内容上限 2000 字符

### 第三步：编写 meta.json（可选）

```json
{
  "owner": "system",
  "model_support": ["claude", "trae", "codex"],
  "max_chars": 2000
}
```

### 第四步：注册到配置文件

编辑 `.ai_agent_demo_skill/use_ai_agent_demo_skills.json`，将 `skill_id` 加入：

```json
{
  "global": ["code-review", "mcp-file-ops", "你的新skill_id"],
  "roles": {
    "角色名": ["角色专属skill_id"]
  },
  "loadOrder": "global-first"
}
```

- `global`：所有角色都会加载
- `roles`：按角色名（非 CLI 名）绑定专属 Skill
- 优先级：global → role（后加载覆盖前加载）

### 第五步：校验

运行 `node scripts/validate_skills.js` 确认无 Error。

## 校验规则

**Error（阻断服务启动）：**
- skill_id 重复
- 缺少 SKILL.md 文件
- frontmatter 缺少 name/description/type
- type 值不是 behavior/tooling/global_constraint
- tooling 类 Skill 引用了不存在的 MCP 工具
- 配置文件中引用了不存在的 skill_id

**Warning（允许启动，打日志）：**
- 缺少可选的 meta.json
- 内容超过 2000 字符（会被截断）

## 可用的 MCP 工具名

tooling 类 Skill 可引用的工具：Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, NotebookEdit

## 发布流程

修改 Skill → 提交 Git → PR → CI 校验通过 → 合并 → 重启服务生效
