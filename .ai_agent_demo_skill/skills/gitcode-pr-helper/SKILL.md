---
name: GitCode PR Helper
description: GitCode PR 或 Merge Request 相关任务的处理规范。用于用户给出 GitCode PR 链接、要求查看 PR diff、做代码检视、同步线上 PR 代码、或需要从 merge request ref 获取提交范围时。
type: behavior
---

## 处理原则

- 优先用 git 获取 PR 代码，不依赖 GitCode 网页 HTML diff。
- 如果本地 `origin` 是 fork，先识别源仓远端，再从源仓获取 merge request ref。
- 页面抓取只用于补充标题、描述等元信息；拿不到 diff 时不要硬解析前端渲染页面。

## 推荐流程

1. 从 PR 链接提取编号，如 `pull/27`。
2. 用 `git remote -v` 确认源仓远端；必要时检查默认分支和本地分支关系。
3. 用 `git ls-remote <remote> 'refs/merge-requests/*/head'` 或等价方式确认 PR head SHA。
4. 用 `git fetch <remote> refs/merge-requests/<id>/head` 拉到 `FETCH_HEAD`。
5. 用上游默认分支 head SHA 与 `FETCH_HEAD` 做 `git show` / `git diff` / `git log`。
6. 输出 review 时明确说明 base SHA、head SHA、审查依据；如果 ref 或 diff 无法获取，要明确说证据受限。

## 审查输出要求

- 先说明审查对象：PR 编号、head SHA、base SHA。
- 再给出 findings，不要把网页抓取失败当成代码问题。
- 如果只能拿到部分信息，明确标注“我不确定”或“审查依据受限”。
