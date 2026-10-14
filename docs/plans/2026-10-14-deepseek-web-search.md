# DeepSeek 原生搜索接入统一 MCP WebSearch

日期：2026-10-14
作者／验收：YYF（Codex）
实现：金渐层（Kimi）
状态：已实现；YYF 于 2026-10-14 复验通过（离线回归＋完整 MCP 真实搜索）。证据见同目录 2026-10-14-deepseek-web-search-review.md。共享运行服务未重启。
代码基线：/Users/inky/code/ai-agent-demo，HEAD 9f2e355

## 1. 目标与证据

让各 CLI 通过已有的 mcp__permission__WebSearch 获得一致的联网搜索能力。搜索在 DeepSeek 云端执行，项目负责审批、发起请求、解析结构化结果和返回错误。

YYF 已实测：
- POST https://api.deepseek.com/anthropic/v1/messages，模型 deepseek-v4-flash。
- tools 声明 web_search_20250305，name 为 web_search，max_uses 为 1。
- 查询：Model Context Protocol latest specification site:modelcontextprotocol.io。
- HTTP 200，耗时 5884 ms；返回 server_tool_use(name=web_search) 和 web_search_tool_result，其中 10 条 web_search_result。
- usage.server_tool_use.web_search_requests 为 1；input_tokens 10453、output_tokens 832。
- 部分 title 为空，page_age 为 null。
- 凭据来自本机 dsh 的已保存 API Key，测试未输出密钥。

这些是一次真实调用的结果，不代表固定延迟、固定费用或长期可用性。

上游实现参考：
https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/web/web-search-deepseek/src/provider.ts

## 2. 当前代码与设计选择

当前 permission-server.js:363–375 已注册 WebSearch({query})，但返回不可用的占位提示。
withPermission 在批准后等待 executeFn；executeFn 抛错时已经返回 MCP isError: true，无需重构其他工具。
invoke.js 已把同名 MCP 工具提供给各 CLI；public/app.js 已展示 WebSearch 的 query。

采用主服务集中调用方案：

CLI → permission-server WebSearch → 原有权限审批
    → POST /api/web-search（已有主服务的内部执行路由）
    → lib/deepseek-web-search.js → DeepSeek Messages API
    → 结构化结果 JSON → MCP text content → CLI

由 server.js 保管搜索凭据。permission-server 只带内部令牌和批准 requestId 调用主服务，不持有或传递 DeepSeek 密钥。这样避免给不同 CLI 注入 API Key，尤其避免把密钥写进 Codex -c 参数、临时 MCP 配置和 ACP 配置。

本期支持一个 DeepSeek provider；保留 provider 模块边界方便以后替换。保留 WebSearch 的现有 query 入参和工具名。不增加搜索页面爬虫、其他供应商、结果专用 UI、计费界面或 CLI 原生搜索依赖。

## 3. 配置与凭据

配置只由主服务读取，调用者不能通过 query 参数指定 endpoint、模型或密钥。

| 配置 | 默认／规则 |
|---|---|
| DEEPSEEK_API_KEY | 优先凭据；去除首尾空白后必须非空 |
| DEEPSEEK_SEARCH_CREDENTIALS_FILE | 可选，显式配置时读取 dsh 格式 YAML 的 refs.DEEPSEEK_API_KEY 字符串；不自动扫描用户目录 |
| DEEPSEEK_SEARCH_BASE_URL | https://api.deepseek.com/anthropic/v1，追加 /messages |
| DEEPSEEK_SEARCH_MODEL | deepseek-v4-flash |
| DEEPSEEK_SEARCH_TIMEOUT_MS | 60000；有效整数，范围 1000–120000 |
| DEEPSEEK_SEARCH_MAX_RESULTS | 8；有效整数，范围 1–20 |

DEEPSEEK_SEARCH_BASE_URL 与聊天用的 DEEPSEEK_BASE_URL 独立；不读取后者。
base URL 必须为合法 HTTPS URL，不含 username/password、query、fragment；统一处理尾部斜杠。拒绝 HTTP 重定向，避免带密钥跳到其他目标。
配置错误在搜索调用时返回可理解的错误，不能因此阻止整个聊天服务启动。

凭据规则：
1. 有非空 DEEPSEEK_API_KEY 时使用它；即使服务端配置了不存在的凭据文件，也不读取该文件。
2. 否则，仅当显式指定 DEEPSEEK_SEARCH_CREDENTIALS_FILE 时读取 YAML。使用项目声明的 js-yaml 依赖安全解析，校验 refs 与目标值的类型；不得依赖全局 dsh 的 node_modules。
3. 文件不存在、不可读、内容不合法或没有非空目标 key，均返回缺失／配置错误，不输出文件内容或密钥。
4. 不复制凭据到仓库，不修改原文件，不把完整 YAML 解析对象写入日志；当前版本只实现 API Key，不实现 DeepSeek 账号 token 登录。
5. 每次调用解析凭据文件，允许 dsh 更新保存的 key 后下一次搜索生效。

本机可复用现有凭据的启动配置（路径仅在服务进程中使用）：

```bash
DEEPSEEK_SEARCH_CREDENTIALS_FILE=/Users/inky/.dsh/.credentials.yaml node server.js
```

配置环境变量不会自动改变已运行主服务。验收时使用独立进程／端口，不停止共享聊天服务。

## 4. API 请求与执行边界

provider 使用 Node 原生异步 fetch，不拼接 shell/curl，不通过 ctx.llm 或某个 CLI 发起搜索。建议导出可注入 fetch 的 searchDeepSeekWeb(query, options)，便于离线测试。

请求头：
- Content-Type: application/json
- anthropic-version: 2023-06-01
- x-api-key: <服务端解析的 key>
- Authorization: Bearer <同一个 key>

请求 JSON：

```json
{
  "model": "deepseek-v4-flash",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "Perform a web search for the query: <query>"
    }
  ],
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 1
    }
  ]
}
```

query 必须是字符串，trim 后非空且最多 4096 个字符。通过 JSON.stringify 编码，不做 shell 插值。一次 WebSearch 只发一次 Messages 请求，不自动重试或补发请求；模型未执行搜索时明确报错。

超时覆盖发送请求和读取响应体的全过程，AbortController/AbortSignal 必须真正取消 fetch。响应体设置 2 MiB 上限（流式累计字节并及时取消），超限返回明确错误。支持调用者断开时取消正在进行的上游请求。退出路径释放 timeout 和事件监听。

## 5. 返回结果与解析

成功内部响应：HTTP 200，{ok:true,result:<下面的对象>}。MCP 将 result 序列化为 JSON 字符串交给现有 withPermission，保持 text content 兼容性。

```json
{
  "provider": "deepseek",
  "query": "原查询（已 trim）",
  "model": "deepseek-v4-flash",
  "sources": [
    {
      "title": "标题，空值时用 URL",
      "url": "https://example.com/page",
      "snippet": "仅来自匹配引用的摘录；没有则省略",
      "publishedAt": "仅保留有效非空 page_age 字符串；没有则省略"
    }
  ],
  "truncated": false,
  "elapsedMs": 5884,
  "usage": {
    "inputTokens": 10453,
    "outputTokens": 832,
    "webSearchRequests": 1
  }
}
```

解析要求：
- 只取 web_search_tool_result 内 type=web_search_result 的结构化条目；支持多个结果块合并。
- URL 必须是有效 http/https URL。忽略损坏条目；有结果条目却全部损坏时返回协议错误。
- 按 URL 去重并保留首次出现顺序。超过 MAX_RESULTS 才截断；truncated 表示去重后的有效数量超过输出数量。
- title trim 后为空时使用 URL。page_age 的 null/空值不制造日期。
- snippet 从响应 text 块的 citations 中，按 URL 匹配 cited_text 并去重拼接；每条最多 500 字符。不解析模型答案文本作为来源或摘要。
- 不返回 thinking、完整模型答案、encrypted_content、请求头、账号 token 或原始响应。
- 缺少 web_search_tool_result 时返回错误，即使 text 中包含链接也不算搜索成功。
- 合法结果块中的空数组可成功返回 sources: []。结果块内的 web_search_tool_result_error 必须识别并返回错误，不能当作空搜索。
- usage 字段仅选取有效非负数；缺失则省略。禁止以该数据擅自修改现有各 CLI 的上下文指标／余额统计。

## 6. 审批、内部路由与 MCP 错误

permission-server 中 WebSearch：
1. 验证／规范化 query，然后调用现有 withPermission("WebSearch", {query}, async decision => ...)。
2. 只在 allow 后请求 /api/web-search，body 为 {requestId:decision.requestId,query}。
3. HTTP 客户端复用 SERVER_HOST、PORT 与 internalAuthHeaders()，兼容具体网卡地址和 ::1。
4. 客户端总超时略大于 provider 超时（例如 +5000ms）；主服务把解析后的非敏感 timeout 传给工具端或采用明确的统一上限，不能出现可配置上游 120s 而工具端固定 65s 的冲突。
5. 非 2xx、ok:false、非法 JSON、连接失败都抛错；withPermission 转为 isError:true。不能把“搜索失败”当普通成功字符串返回。

server.js 中 /api/web-search：
- 位于现有访问门禁之后。在 lib/access-gate.js 的 INTERNAL_ROUTES 增加这一个精确路径，保留已有内部令牌和 Host 白名单行为。
- 复用 consumeApproval(requestId,"WebSearch") 的一次性与 TTL 语义。缺失、过期、已消费、属于其他工具的 requestId 都拒绝，且不调用上游。
- 在自动批准和手动批准两条路径，为 WebSearch 的 storeApproval 记录增加规范化 query；执行路由必须检查 query 与批准记录一致。不要让用户批准 A 后实际搜索 B。
- 身份与会话日志归属取批准记录，不信任执行请求中的角色／会话字段。
- 在开始上游调用前一次性消费审批；失败后也不允许同一 requestId 重放付费请求。
- 访问令牌通过门禁仍不代表有工具审批；执行路由始终校验 requestId。
- 不改变现有 WebSearch 的审批策略，不新增每次调用的特殊确认弹窗。

错误内部响应为 {ok:false,error:{code,message}}，用适当 HTTP 状态。MCP 错误 text 保留 [CODE] 和简短说明，方便模型判断。
至少区分：
WEB_SEARCH_INVALID_INPUT、WEB_SEARCH_CONFIG_ERROR、WEB_SEARCH_CREDENTIAL_MISSING、
WEB_SEARCH_APPROVAL_INVALID、WEB_SEARCH_TIMEOUT、WEB_SEARCH_UPSTREAM_ERROR、WEB_SEARCH_PROTOCOL_ERROR。

上游 401/403 提示凭据或权限问题；429 提示额度／限流；5xx/网络失败提示服务不可用。保留状态码但不直接透传原始上游响应或底层含秘密的异常。
日志最多记录 provider、状态、耗时、结果数、usage 和已有关联 ID；stdio stdout 只能输出 MCP 协议。

## 7. 建议改动文件

| 文件 | 改动 |
|---|---|
| lib/deepseek-web-search.js（新增） | 配置、凭据、请求、超时、解析与标准化 |
| server.js | /api/web-search 路由、审批 query 绑定；复用既有流程 |
| lib/access-gate.js | 新路由加入精确内部路由集合 |
| permission-server.js | 替换占位实现，内部 HTTP 桥接 |
| package.json、package-lock.json | 项目依赖 js-yaml（若选用上述凭据文件能力） |
| README.md | 配置、启动、错误排查和测试命令；内部路由数量说明同步 |
| test/test-deepseek-web-search.js（新增） | provider 离线测试 |
| test/test-web-search.js（新增） | 审批／路由／真实 MCP stdio 集成测试 |
| scripts/deepseek-web-search-smoke.js（新增） | 显式启用的真实 API 冒烟，默认不自动付费调用 |

允许为可测性做小范围模块抽取；不重构整套工具和权限系统。invoke.js 原则上无需修改，若发现必要改动需说明理由。保留工作区原有 chat-logs、.worktrees 等其他人的改动。

## 8. 验收标准

离线测试使用注入的 fetch 或本地 mock，不连接付费 API。重点断言可观察行为：

1. 请求 endpoint、headers、工具 type/name、max_uses=1、JSON 编码正确；含引号/换行的 query 不改变请求结构。
2. 多块合并、去重、截断、空标题/null 日期、引用摘要，以及合法空结果按 §5 工作。
3. 文本答案含 URL 但无结果块、工具错误块、损坏 JSON、全部损坏来源均不能伪装成功。
4. 凭据优先级、显式 YAML 文件、无凭据、坏文件和无效配置；无凭据时上游调用数为 0。
5. 401、429、5xx、超时、超大响应和取消都正确失败；没有自动重试，密钥不会出现在日志／错误／MCP 返回中。
6. 未批准、拒绝、过期、错误工具、query 不匹配、重放均不访问上游；有效批准只触发一次请求。
7. 真实 MCP SDK client 启动 permission-server，调用 tools/call WebSearch，通过测试审批服务观察成功和 isError:true 两条路径；不能只测试 provider 函数或匹配源码字符串。
8. 门禁启用时新路由接受正确内部令牌（含 Host 白名单场景），错误令牌拒绝；内部令牌仍不能读取会话历史。合法访问令牌缺审批也不能执行搜索。
9. 旧工具、SendMessage、审批卡片和既有 permission 上下文保持可用。

最低回归命令（以实际新增文件为准）：

```bash
node test/test-deepseek-web-search.js
node test/test-web-search.js
node test/test-access-gate.js
node test/test-permission-context.js
node test/test-send-message.js
node test/test-safe-command.js
node test/test-webfetch-auto-approval.js
git diff --check
```

真实 API 验收由 YYF 执行一次，设置 max_uses=1。单独记录：
- provider 冒烟的 HTTP 状态、结构化来源数、耗时、webSearchRequests；不输出 key、thinking 或完整响应。
- 经过新主服务＋MCP 的端到端结果；provider 成功不等于 MCP 集成已经通过。
- 配置启用方式与运行进程；独立测试进程与端口，不能覆盖真实会话或停止共享服务。
- 如果访问受阻，明确说明原因，不能把离线通过写成在线通过。

冒烟脚本默认打印用法并退出，只有显式 --live 才调用真实 API。例如：

```bash
DEEPSEEK_SEARCH_CREDENTIALS_FILE=/Users/inky/.dsh/.credentials.yaml \
  node scripts/deepseek-web-search-smoke.js --live \
  --query "Model Context Protocol latest specification site:modelcontextprotocol.io"
```

## 9. 交付与验收流程

金渐层按此文档完成编码、离线测试和 README，交付改动文件、复现命令、测试结果及未完成项；不要声称 YYF 已验收。
完成后通过 SendMessage 的 atTargets:["YYF"] 显式召唤 YYF，附实现所在工作目录／分支（如使用独立工作树）。
YYF 再审查代码、跑必要回归、执行真实调用，给出通过或具体阻塞问题；若需修订，由金渐层修复后再次召唤验收。
