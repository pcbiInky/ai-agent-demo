---
name: MCP File Operations
description: MCP 文件操作工具的使用规范和最佳实践
type: tooling
---

## Required MCP Tools: Read, Write, Edit, Glob, Grep

## 使用规范

### 读取文件
- 优先使用 `Read` 而非 `Bash` 执行 cat/head/tail
- 大文件使用 `offset` 和 `limit` 参数分段读取，避免一次加载过多内容
- 读取前先用 `Glob` 确认文件存在

### 搜索文件
- 按文件名/路径搜索使用 `Glob`，而非 `Bash` 执行 find/ls
- 按文件内容搜索使用 `Grep`，而非 `Bash` 执行 grep/rg
- `Grep` 支持正则表达式，优先使用精确模式减少噪音

### 编辑文件
- 修改已有文件优先使用 `Edit`（指定 old_string/new_string），而非 `Write` 全量覆盖
- 创建新文件使用 `Write`
- `Edit` 的 old_string 必须与文件中的内容精确匹配（含缩进和换行）

### 操作顺序
1. 先 `Glob` 确认目标文件存在
2. 用 `Read` 了解现有内容
3. 用 `Edit` 或 `Write` 执行修改
4. 用 `Read` 验证修改结果

## Few-shot 示例

User: 帮我把 server.js 中的端口从 3000 改成 8080