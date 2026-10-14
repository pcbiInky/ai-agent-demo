# DeepSeek WebSearch 首轮验收结果

日期：2026-10-14
验收：YYF（Codex）
实现：金渐层（Kimi）
工作区：/Users/inky/code/ai-agent-demo
首轮结论：暂未通过。真实 provider 可用；完整执行链路存在取消请求的问题，需修复后复验。
当前结论：F1–F3 已修复，YYF 于 2026-10-14 复验通过；完整 MCP 链路真实搜索成功，详见末尾复验证据。
本轮未修改实现代码，未停止共享聊天服务。

## 已完成验证

方案要求的 7 个测试文件均独立重跑通过：
- test-deepseek-web-search：75 passed
- test-web-search：27 passed
- test-access-gate：131 passed
- test-permission-context：54 passed
- test-send-message：10 passed
- test-safe-command：83 passed
- test-webfetch-auto-approval：23 passed

git diff --check 通过。上述通过不覆盖以下新增复现。

真实 provider 冒烟成功：
- 使用显式 DEEPSEEK_SEARCH_CREDENTIALS_FILE 指向 dsh 已保存凭据；不输出 key。
- deepseek-v4-flash，max_uses=1。
- 查询 Model Context Protocol latest specification site:modelcontextprotocol.io。
- elapsedMs=7642，sources=8，truncated=true。
- usage.inputTokens=10505，outputTokens=1216，webSearchRequests=1。
- 验证的是交付的 provider，不代表 MCP 端到端已经通过。

## F1 [P1] 正常请求被当作断开，异步搜索立即取消

位置：server.js /api/web-search 中 req.on("close", () => abort.abort())，当前约第 1877 行。

独立端口启动实际 server.js，正常 fetch POST 完整发送 JSON；用 100ms 延迟、遵守 signal 的假 provider 替换上游，仅绕过启动／退出时的全局 MCP 注册操作，不连接付费 API。
直接调用既有 storeApproval 为测试 query 建立批准记录，然后请求真实 /api/web-search 路由。

结果：
HTTP 502；错误 code=WEB_SEARCH_UPSTREAM_ERROR；fake provider 观察到 cancelled=true，elapsedMs=0。
客户端未断开，正在正常等待响应。

原因：IncomingMessage 的 close 也会在请求消息正常读取完成时触发，不能用它单独表示等待响应的客户端已断开。已有集成测试的假 provider 忽略 options.signal，并且立即返回，掩盖了该故障。

要求：
- 用响应侧 close 并检查 !res.writableEnded 判断提前断开，或其他经过验证的等价生命周期处理；必要时结合 req.aborted。
- 请求结束与响应结束都正常时不得取消上游。
- finally 中移除新增事件监听；取消后不要尝试向已断开的客户端写响应。
- 新测试必须包含正常 POST + 延迟、遵守 AbortSignal 的 provider，断言 200。
- 另加客户端提前断开，断言上游 signal 被取消；不能只断言抛错或匹配源码。
- 修复后 YYF 才进行完整 MCP + 主服务 + 真实 DeepSeek 验收。

## F2 [P2] 畸形搜索结果块被伪装成合法空结果

位置：lib/deepseek-web-search.js:178–191。

调用实际 parseUpstreamResponse，逐个传入：

```js
{content:[{type:"web_search_tool_result"}]}
{content:[{type:"web_search_tool_result",content:{}}]}
{content:[{type:"web_search_tool_result",content:[null,{type:"unexpected"}]}]}
```

三个输入都返回 sources: [] 成功，未报告协议异常。

要求：
- 结果块 content 缺失或既不是数组也不是已识别错误对象时抛 WEB_SEARCH_PROTOCOL_ERROR。
- 非空数组全部是不合法／未知条目时也不能当空结果成功。
- 合法 content: [] 继续成功；混合有效和损坏条目仍可保留有效来源。
- 添加以上三种畸形输入回归，不与合法空结果混淆。

## F3 [P2] 超大响应抛错后没有取消底层流

位置：lib/deepseek-web-search.js:239–259，以及 searchDeepSeekWeb 的资源收尾。

使用实际 searchDeepSeekWeb，注入返回 Response 的假 fetch。
响应为持续 pull、每次产生 1 MiB 的未关闭 ReadableStream，cancel 回调记录是否取消。

结果：
超过 2 MiB 后正确抛 WEB_SEARCH_UPSTREAM_ERROR，但 streamCancelled=false。
代码只是 reader.releaseLock()，未执行 reader.cancel()/body.cancel() 或中止上游请求，finally 又清除了超时。

要求：
- 在响应超限及其他提前放弃响应的路径上取消 reader/body 或实际 abort 上游；确保资源被释放。
- 非 2xx 和重定向提前拒绝时也处理尚未读取的响应体。
- 测试使用未预先关闭的流，断言 cancel 确实触发；现有大流测试在 start 内已经 close，只验证错误码，不能验证取消。
- 保留全过程 timeout 和调用者取消的正确错误分类。

## 复验交付

金渐层修复 F1–F3 并补行为回归后，重新运行上述测试，说明新增用例与结果，通过 SendMessage atTargets:["YYF"] 召唤复验。
不将本次 provider 真实调用写成端到端验收通过；不修改本报告的已观察事实。

## 第二轮复验通过（2026-10-14，YYF）

复查实际修复代码与行为测试：
- F1：响应侧 close＋!res.writableEnded 判断提前断开；正常延迟 POST 返回成功，提前断开会取消 provider，finally 移除监听。
- F2：缺失／无法识别的 content 与全未知条目报协议错误；合法空结果及混合有效来源保持支持。
- F3：读取失败／超限执行 reader.cancel；非 2xx 和重定向取消未读取的响应体；未关闭流的 cancel 行为已覆盖。

独立重跑全部最低回归：
- test-deepseek-web-search：83 passed, 0 failed
- test-web-search：30 passed, 0 failed
- test-access-gate：131 passed, 0 failed
- test-permission-context：54 passed, 0 failed
- test-send-message：10 passed, 0 failed
- test-safe-command：83 passed, 0 failed
- test-webfetch-auto-approval：23 passed, 0 failed
- git diff --check：通过。

### 完整 MCP 真实搜索

测试在独立 Node 进程中启动实际 server.js，PORT=0，临时端口 65332。
启用 ACCESS_TOKEN、PERMISSION_INTERNAL_TOKEN 和面向虚拟域名的 ALLOWED_HOSTS；内部请求实际连接 127.0.0.1，用内部令牌通过门禁。令牌仅为测试值。
仅跳过测试进程的全局 CLI MCP 注册／清理，避免影响共享服务；搜索 provider 未打桩（仅包裹计数），实际访问 DeepSeek 官方端点。

真实 MCP SDK Client 通过 stdio 启动 permission-server，调用 WebSearch；观察到审批 pending，再经实际 /api/permission-response 批准。随后经过实际 /api/web-search 调用真实 provider。

结果：
- 共享工具入参：Model Context Protocol latest specification site:modelcontextprotocol.io。
- 审批 HTTP 200；MCP isError=false；返回标准化 JSON。
- provider=deepseek，model=deepseek-v4-flash。
- sources=8，truncated=true，elapsedMs=5141。
- inputTokens=10493，outputTokens=817，webSearchRequests=1。
- provider 包裹计数 upstreamCalls=1，未重试。
- 同一 requestId 再调用实际执行路由：HTTP 403，WEB_SEARCH_APPROVAL_INVALID；上游调用数仍为 1。
- 证明链路：MCP stdio → 真实审批 → permission-server → 实际主服务路由 → 真实 DeepSeek 搜索。

测试使用唯一临时会话 ID，结束后删除对应临时日志并关闭测试 MCP 子进程／HTTP 服务。未停止或重启共享聊天服务，未输出 API Key、thinking 或完整上游响应。

### 验收边界与启用

本次通过的是当前工作区的实现、共有 MCP 执行链路和一次真实搜索；未逐个 CLI 发起完整聊天调用。
既有共享服务未重启，不能由本次结果断言该运行进程已加载新路由。
启用需要在主服务启动环境配置 DEEPSEEK_API_KEY，或显式配置 DEEPSEEK_SEARCH_CREDENTIALS_FILE；本机可复用 /Users/inky/.dsh/.credentials.yaml。按原启动方式重新加载服务后生效。

