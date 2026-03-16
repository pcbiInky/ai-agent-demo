---
name: GitCode PR Helper
description: GitCode PR 或 Merge Request 相关任务的处理规范。用于用户给出 GitCode PR 链接、要求查看 PR diff、做代码检视、同步线上 PR 代码、或需要从 merge request ref 获取提交范围时。
type: behavior
---

## 处理原则

- 优先用 git 获取 PR 代码，不依赖 GitCode 网页 HTML diff。
- 如果本地 `origin` 是 fork，先识别源仓远端，再从源仓获取 merge request ref。
- 页面抓取只用于补充标题、描述等元信息；拿不到 diff 时不要硬解析前端渲染页面。
- 做 PR 审查时，文件范围和提交范围默认基于 `merge-base` 计算，不直接拿当前主干与 PR head 做两点 diff。

## 推荐流程

1. 从 PR 链接提取编号，如 `pull/27`。
2. 用 `git remote -v` 确认源仓远端；必要时检查默认分支和本地分支关系。
3. 用 `git ls-remote <remote> 'refs/merge-requests/*/head'` 或等价方式确认 PR head SHA。
4. 用 `git fetch <remote> refs/merge-requests/<id>/head` 拉到 `FETCH_HEAD`。
5. 计算 `merge-base <upstream-branch> FETCH_HEAD`，并明确记录 merge-base SHA。
6. 审查 PR 自身改动时，优先用 `git diff <upstream-branch>...FETCH_HEAD`；只有明确要看“当前主干和 PR head 的直接差异”时，才使用两点 diff。
7. 用 `git show` / `git log <merge-base>..FETCH_HEAD` 辅助确认提交范围。
8. 输出 review 时明确说明 merge-base SHA、head SHA、审查依据；如果 ref 或 diff 无法获取，要明确说证据受限。

## 审查输出要求

- 先说明审查对象：PR 编号、merge-base SHA、head SHA。
- 再给出 findings，不要把网页抓取失败当成代码问题。
- 如果只能拿到部分信息，明确标注“我不确定”或“审查依据受限”。
