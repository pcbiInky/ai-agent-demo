# 消息内 Mermaid 渲染方案

## 目标与分工

用户要求：消息窗口支持 Mermaid 流程图；金渐层编码，YYF 验收。

本方案由 YYF 根据当前源码制定，状态为待实现、待验收。工作目录仅为 `/Users/inky/code/ai-agent-demo`。保留无关改动，特别是 chat-logs 子模块及 .worktrees/。

## 当前实现与选择

- `public/index.html:8-12` 引入 marked、marked-highlight、DOMPurify、highlight.js，没有 Mermaid。
- `public/app.js` 的 `renderMarkdown()` 同步执行 `marked.parse()` 与 DOMPurify 清洗；仅能生成代码块。
- 助手正文入口是 `appendAssistantMessage()`、主聊天中的 `appendThreadReply()` 和消息链的 `renderThreadPanel()` / `buildThreadMessage()`。
- `loadHistory()` 复用前两个入口，不需要修改消息协议或历史存储。
- 用户消息、Thinking、工具结果目前采用各自展示逻辑，首版只增强上述助手 Markdown 正文。

选择浏览器本地 Mermaid 渲染 SVG。相较外部图片服务，它无需把聊天内容发送出去；相较仅加 CDN 脚本，本地固定依赖可避免新增 CDN 可用性问题。首版不增加图片导出、缩放编辑器或后端图形生成服务。

## 实现要求

### 1. 固定依赖与静态资源

- 增加生产依赖 `mermaid`，使用精确版本并更新 package-lock.json。制定方案时 `npm view mermaid version engines --json` 返回 12.1.0、Node >=22.12.0，本机 Node v25.9.0。建议固定 12.1.0；若项目有更低 Node 支持要求，先核对兼容版本并明确记录选择。
- 在 `server.js` 增加 `/vendor/mermaid` 的 express.static 路由，目录仅指向 `node_modules/mermaid/dist`。路由必须位于现有 createAccessGate(access) 之后；不能公开整个 node_modules。
- 浏览器通过同源 `import('/vendor/mermaid/mermaid.esm.min.mjs')` 按需加载，使用单例 Promise。保留 dist 的相对路径，使内部 chunks 能加载。首次出现 Mermaid 时加载；普通聊天不等待加载。
- 本地资源失败时仍显示源码，不能影响正文或后续消息。

### 2. 保留 Markdown 管线，插入 DOM 后增强

- 保留同步 `renderMarkdown()` 和现有 HTML 清洗。
- marked-highlight 对语言为 mermaid 的代码块跳过 highlightAuto，返回正确转义的代码；不要直接返回未转义源码。普通语言维持当前高亮行为。
- 新增 `renderMermaidBlocks(root)` 或等价帮助函数，仅扫描指定消息/面板内 `.markdown-body` 的 Mermaid fenced code blocks，读取 code.textContent 得到源码。
- `appendAssistantMessage()`、`appendThreadReply()` 在消息插入 DOM 后调用。
- `renderThreadPanel()` 在本轮根消息和回复都 append 完成后调用。不要在未连接 DOM 的 buildThreadMessage() 内依赖尺寸测量。
- 历史刷新、会话切换及消息链实时重建因此自然复用，不依赖全局 MutationObserver 或周期扫描。

### 3. 异步渲染生命周期

- 每个图块有唯一渲染 ID，主聊天和消息链中展示同一源码也不能复用 SVG 内部 ID。
- 用 WeakMap、WeakSet 或受控状态记录 queued/rendering/done/error，重复调用不得为同一 DOM 图块重复排队。
- 使用可恢复的串行渲染队列。单图异常必须被捕获，后面的有效图继续渲染，不能出现未处理 Promise rejection。
- 使用所选版本的公开 mermaid.render API，接入前核对其 Promise 返回值。不要调用内部 mermaidAPI 或直接执行源码。
- await 返回后确认目标节点仍连接到当前页面、任务仍属于该节点/本次渲染；已切换会话或重建面板时丢弃旧结果。必要时记录会话或渲染代次。
- 使用独立、可清理的临时渲染容器，完成/失败都清理。不得留下 Mermaid 的报错 SVG、临时节点或影响页面布局的测量内容。
- 图形替换导致高度变化时，尊重当前滚动位置：替换前仍接近底部才继续跟随底部，用户已上翻则不强制拉回。避免异步完成再次累加未读数。

### 4. SVG 和失败回退

- 初始化一次：startOnLoad:false、securityLevel:'strict'、htmlLabels:false、suppressErrorRendering:true；设置有界 maxTextSize / maxEdges，例如 20000 字符、300 条边，同时在调用前检查源码长度。
- 保留 Mermaid 默认 secure 配置，防止图内 init/frontmatter 把 securityLevel、文本/边限制等改弱；额外锁定所需的 HTML 标签相关配置。按固定版本验证图内配置覆盖行为。
- SVG 插入前使用 DOMPurify 的 SVG profile 做第二次清洗，保留所需 SVG/滤镜标签与属性；禁止 foreignObject、脚本、事件属性及 javascript: 链接，不执行 bindFunctions。确保 htmlLabels:false 下中文标签和箭头仍正常显示。
- 每图独立布局：图形区域 + 原始代码折叠区。成功后显示图形，源码默认折叠；可展开查看原文。源码使用 textContent 或保留已清洗代码节点，不通过字符串拼接注入。
- 语法错误、依赖不可用或超限时显示简短提示并保留可读源码；错误内容使用 textContent，不能把 Mermaid 异常字符串当 HTML。
- `public/style.css` 添加局部样式，主聊天与消息链适用；SVG 不撑破气泡，宽图可横向滚动，窄屏可用；样式不要覆盖所有 svg 或 pre。

## 测试与 YYF 验收

金渐层增加有意义的回归测试，并交付运行命令和结果。jsdom 可用于调度与回退验证，但不能单独证明 Mermaid 真实布局正常。

1. 原测试消息（中文判断分支流程图）在主聊天显示 SVG、中文节点和箭头；主聊天中线程回复、右侧消息链也能显示。
2. 刷新历史仍显示；切换会话再返回仍显示；同一消息多图及不同消息同源码不串 ID，不重复渲染。
3. 真实 Mermaid 验证流程图，并附一个 sequenceDiagram 用例确认通用 Mermaid 接入。
4. 一张错误图后接一张有效图：错误提示及源码保留，有效图正常渲染；加载失败、超长图也有回退。
5. 故意延迟 render，在等待中切换会话/重建消息链：旧结果不写入新 DOM，没有悬挂报错节点。
6. 普通 JavaScript 代码块、行内代码、表格、链接与现有 HTML 清洗行为无回归；用户纯文本消息和 Thinking 不被误转换。
7. 恶意标签、事件属性、图内弱化安全配置、click 指令不导致脚本/回调执行；SVG 清洗后图仍可见。
8. 正常宽度、窄屏和消息链中不溢出气泡；展开源码正常。上翻历史时异步完成不抢滚动；底部阅读时图加载后仍能看到最新消息。
9. 静态资源仅开放指定 dist 目录；启用门禁后未认证请求不能读取新增资源；已认证页面能加载 ESM 主文件及 chunks。

建议测试交付：`node test/test-mermaid-rendering.js`（新增）、`node test/test-file-diff-display.js`、`node test/test-thread-attribution.js`、`node test/test-access-gate.js`、`node --check public/app.js`、`node --check server.js`、`git diff --check`。门禁测试补充新资源路由用例。真实浏览器测试使用实际 Mermaid 包，记录浏览器/命令，必要时用 Playwright 增加 devDependency 并给出安装浏览器步骤。截图及测试产物放在本项目目录内。

YYF 将独立审阅差异、复跑相关测试并核验真实浏览器结果。实现完成后金渐层通过 SendMessage 显式 @YYF，附修改文件、测试命令/结果、运行或重启要求及已知限制。编码完成不等于验收通过。

## 参考

- Mermaid 官方使用文档：https://mermaid.js.org/config/usage.html
- strict 安全级别：https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html
- secure 配置防覆盖：https://mermaid.js.org/config/schema-docs/config-properties-secure.html
