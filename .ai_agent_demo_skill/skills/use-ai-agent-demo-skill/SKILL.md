---
name: Use AI Agent Demo Skill
description: 告诉 AI 如何识别已生效的 Skill，并在回复中按需遵循
type: behavior
---

## Skill 使用规则

- 如果上下文中出现 `【技能: xxx】`，说明该 Skill 已经生效，无需手动加载。
- 当当前请求匹配某个 Skill 的场景时，主动遵循该 Skill 的规范和输出格式。
- 回复开头标注你采用的技能：`采用技能：<skill_name>`。
- 如果多个 Skill 同时适用，优先选择和当前任务最相关的 Skill。
- 若用户明确要求创建或修改 Skill，再参考对应的 Skill 创建指南；否则不要展开解释 Skill 机制、分类或创建流程。
