# 跨设备访问的令牌门禁方案（v2，取消按来源地址放行）

日期：2026-10-10
作者：马哥（qodercn）
状态：v2 已实施，待 YYF 复审
变更记录：
- v1 默认监听回环；对外模式下按 socket 来源放行回环请求，本机 permission/MCP 链路依赖该豁免。
- v2 按 YYF 复审意见取消来源地址信任：对外模式下一律凭令牌，本机 permission/MCP 回报改走**受限的内部令牌**（只对 4 条内部路由有效），并补 `ALLOWED_HOSTS` 以缓解 DNS 重绑定。

背景：铲屎官要求保留跨设备访问。在此之前，服务默认 `app.listen(PORT)` 监听所有网卡，而 `/api/sessions`、`/api/history`、`/api/events` 均无鉴权；「消息内文件修改 Diff 展示」又把被改文件的完整 `before/after` 写入 `chat-logs` 的 `execution`，等于同网段任意设备可无凭证读取全部会话与文件内容。v12 先把默认监听收紧到 `127.0.0.1`（本机模式缓解），本方案在此基础上让跨设备模式可用且带访问控制。

## 0. v2 修复内容（YYF 复审：代理绕过）

**问题**：v1 的门禁第一条规则是"socket 来源为回环即放行"，且默认 `HOST=127.0.0.1` 时门禁完全不启用。于是同机 TLS 反向代理若对外发布、上游连 `127.0.0.1`，远端请求到 `/api/history` 在上游看来就是本机请求 → 直接放行；DNS 重绑定到回环也会触发同一种误信任。这与 v1 §3 推荐"用 TLS 反代"的用法直接冲突。

**修复**：
1. **不再用来源地址做信任判断**。对外模式（`HOST` 非回环）下，所有请求一律要凭证；`Host` 头与 `X-Forwarded-For` 都不作为放行依据（`ALLOWED_HOSTS` 只用于额外收紧，不用于放行）。
2. **内部令牌（受限且可验证）**：`PERMISSION_INTERNAL_TOKEN` 由 server 启动时生成（或取自环境变量），通过 `buildPermissionEnv` 传给 permission-server 子进程（Codex 走 `-c mcp_servers.permission.env.PERMISSION_INTERNAL_TOKEN`，ACP/Claude 走 env 条目），子进程在 `x-internal-token` 头上携带。它**只对 4 条内部路由有效**：`/api/permission-request`、`/api/permission-response`、`/api/tool-result`、`/api/mcp-send-message`；用它访问 `/api/history`、`/api/sessions`、`/api/events`、页面与静态资源仍然 401。`ACCESS_TOKEN` 也可用于这 4 条路由，便于人工排查。
3. **`ALLOWED_HOSTS`**（可选，逗号分隔，大小写不敏感，端口可省）：配置后 Host 头不在列表内直接 403，用于缓解 DNS 重绑定。
4. 默认本机模式（不设 `HOST`）完全不变：门禁不启用、内部令牌不要求，permission-server 与既有测试零成本。

**行为变化（需铲屎官知晓）**：对外模式下**本机浏览器也要令牌**——用启动日志里的 `http://<本机IP>:PORT/?token=…` 打开（会写入 HttpOnly Cookie），或 `http://127.0.0.1:PORT/?token=…`。这是取消来源豁免的必然代价。

**回归用例（YYF 要求）**：本机反向代理把请求转发到回环上游，无令牌访问 `/api/history`、`/api/sessions`、`/api/events`、`/index.html`、`/api/tool-result` 全部 401；带 `ACCESS_TOKEN` 200；带内部令牌只能过内部路由。


## 1. 目标与非目标

**目标**
1. 默认仅本机：不设 `HOST` 时监听 `127.0.0.1`，行为与令牌均不引入任何使用成本。
2. 跨设备可用：显式 `HOST=0.0.0.0`（或某个网卡地址）时，远程设备带令牌即可完整使用页面、接口与 SSE。
3. 一并保护，不只封一个接口：页面与静态资源、全部 `/api/*`（含 `/api/sessions`、`/api/history`、`/api/events`）走同一道门禁。
4. 令牌不外泄到日志：只在启动日志打印一次（本机控制台），不写入 `chat-logs`。

**非目标**
- 多用户/角色权限区分（一个令牌 = 全部会话可读）。
- HTTPS/传输加密、登录页、令牌轮换与吊销、请求速率限制。
- 按客户端自报信息（`Host`、`X-Forwarded-For`、`Forwarded`）还原真实来源并据此放行：自报字段可由客户端伪造，`ALLOWED_HOSTS` 只用于收紧。

## 2. 方案

### 2.1 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 或具体网卡地址即开启跨设备模式 |
| `PORT` | `3000` | 监听端口 |
| `ACCESS_TOKEN` | 未设置 | 跨设备模式的访问令牌；未设置时启动随机生成（`crypto.randomBytes(24).toString("base64url")`，32 字符），重启后变化 |
| `PERMISSION_INTERNAL_TOKEN` | 未设置（对外模式下自动生成） | 内部令牌，仅对 4 条内部路由有效；对外模式下由 server 生成并写回 `process.env` 再传给 permission-server 子进程，本机模式下为空即不发送该请求头 |
| `ALLOWED_HOSTS` | 未设置 | 可选 Host 白名单（逗号分隔，大小写不敏感，端口可省）；配置后 Host 不在列表内直接 403，用于缓解 DNS 重绑定。**只收紧，不放行** |

`resolveAccessToken({ host, envToken, envInternalToken, allowedHosts })` 返回 `{ enabled, token, generated, internalToken, allowedHosts }`：仅当 `host` 非回环时 `enabled` 为真；`envToken`/`envInternalToken` 去首尾空白后为空视同未配置（对外模式下未配置的内部令牌随机生成），空白 `envToken` 视同未配置（避免用空白令牌把门"锁成永远打不开"或"形同虚设"）。

### 2.2 门禁位置与判定顺序

`app.use(createAccessGate(access))` 位于 `express.json()` 与 `express.static()` **之前**（server.js:411），因此静态页面、资源、SSE 与所有接口一视同仁：

1. `enabled === false`（回环监听）→ 直接放行，本机使用方式与既有测试零成本。
2. 配置了 `ALLOWED_HOSTS` 且请求 Host 不在列表内 → 403（DNS 重绑定防护）。
3. `ACCESS_TOKEN` 匹配（`x-access-token` 头 → `?token=` 查询串 → `access_token` Cookie，`crypto.timingSafeEqual` 定长比较）→ 放行；若令牌来自查询串则写入 `access_token` Cookie（`HttpOnly; SameSite=Lax; Path=/`），后续静态资源、`fetch`（默认 same-origin 凭据）与 `EventSource` 自动带令牌，前端无需改动。
4. 否则若路径属于内部路由（`/api/permission-request`、`/api/permission-response`、`/api/tool-result`、`/api/mcp-send-message`）且 `x-internal-token` 匹配 → 放行。
5. 其余一律 401：`/api/*` 返回 JSON `{ error }`，页面与静态资源返回纯文本提示（提示在 URL 后附加 `?token=`），避免浏览器打开页面时看到裸 JSON。

**注意**：判定顺序里没有"来源地址是回环"这一条——本机反向代理转发过来的远端请求与真正的本机请求在 socket 层同形，按来源放行等于把接口敞开。

### 2.3 启动日志

```
AI Chat Arena 已启动: http://0.0.0.0:3000
[访问控制] 跨设备模式已开启，令牌取自 ACCESS_TOKEN 环境变量   （或：为本次启动随机生成（重启后变化））
[访问控制] 访问地址: http://<本机IP>:3000/?token=xxxx
[访问控制] 对外模式下一律凭令牌访问（含本机浏览器与经反向代理的请求）；permission-server 走内部令牌，仅限审批与回报路由
[访问控制] 令牌可读取全部会话历史与 chat-logs 中的完整文件快照，请勿外泄；如需防 DNS 重绑定可设置 ALLOWED_HOSTS
```

绑定 `0.0.0.0`/`::` 时用 `<本机IP>` 占位，不猜测具体网卡地址。

## 3. 取舍与已知限制

1. 明文 HTTP：令牌与文件快照在局域网内明文传输，同网段嗅探者可截获。要真正安全的远程访问应叠加 TLS（反向代理）或 VPN/SSH 隧道——本期不做，由部署方式决定。
2. 单令牌、无权限分级：持令牌者可读取所有会话历史与全部 `execution.before/after` 快照；无审计、无吊销，泄露后只能改 `ACCESS_TOKEN` 或重启（随机令牌模式）轮换。
3. 对外模式下本机浏览器同样需要令牌（取消来源豁免的代价）；默认回环模式门禁不启用，本机任意进程仍可读取接口与日志——这是保持既有使用方式（含 permission-server、MCP 注册、测试）零成本的必要取舍，代价是默认模式下不做任何鉴权。
4. 内部令牌的暴露面：`PERMISSION_INTERNAL_TOKEN` 通过环境变量传给子进程，同机可读 `/proc`（或 `ps eww`）的进程可取到它；它只能调用 4 条内部路由（发起审批、提交审批结果、回报工具结果、以角色身份发消息），读不到会话历史与文件快照。若不需要跨设备模式，保持默认回环监听即可完全不引入该变量。
5. `ALLOWED_HOSTS` 默认关闭：不配置时不校验 Host 头，DNS 重绑定仍可能把浏览器请求指向本机服务（此时页面与接口需令牌，风险由令牌承担）。
6. 随机令牌每次重启变化：远程设备需重新用启动日志里的链接；配置固定 `ACCESS_TOKEN` 可避免，但需自行保管。
7. 未做速率限制与暴力破解退避；32 字符 base64url 随机令牌的猜测成本足够高，但固定弱口令（如 `ACCESS_TOKEN=123`）不受保护。
8. `?token=` 会进入浏览器历史、代理日志与 Referer（页面内跳转）；已用 HttpOnly Cookie 承接后续请求以缩短令牌在 URL 中的存活时间，但首次链接本身仍有暴露面。
9. 不改变 SSE 语义：门禁只在建立连接时校验一次，长连接期间轮换令牌不会断开已建立的连接。
10. 不解析 `X-Forwarded-For`/`Forwarded`：真实客户端地址无法在应用层可信还原，因此不做基于来源 IP 的白名单；需要按来源限制时应由外层代理或防火墙完成。

## 4. 验收用例

1. 不设 `HOST`：监听 `127.0.0.1`，`accessConfig.enabled === false`，本机接口与页面 200（门禁不启用，permission-server 与既有测试无需令牌）。
2. `HOST=0.0.0.0` 且未设 `ACCESS_TOKEN`：启动日志给出随机令牌与访问地址；`generated === true`；`PERMISSION_INTERNAL_TOKEN` 被自动生成并写回 `process.env`。
3. `HOST=0.0.0.0 ACCESS_TOKEN=x`：启动日志显示"取自 ACCESS_TOKEN 环境变量"，`accessConfig.token === "x"`。
4. 对外模式、无令牌：`/api/sessions` 401 且返回 JSON 错误；`/index.html` 401 且返回文本提示（提示中带 `?token=`）。
5. 对外模式、错误令牌：401。
6. 对外模式、`x-access-token` 请求头：`/api/history` 200。
7. 对外模式、`?token=`：200 且响应含 `Set-Cookie: access_token=…; HttpOnly; SameSite=Lax; Path=/`。
8. 对外模式、仅带 Cookie：`/api/events` 200（SSE 与静态资源同路径生效）。
9. **回环来源不再免令牌**：门禁开启时来自 `127.0.0.1` / `::ffff:127.0.0.1` 的无令牌请求 401。
10. **反向代理绕过（YYF 要求的回归）**：本机代理把请求转发到回环上游（`HOST=127.0.0.1` 的上游按门禁开启配置运行），无令牌访问 `/api/history`、`/api/sessions`、`/api/events`、`/index.html`、`/api/tool-result` 全部 401；带 `ACCESS_TOKEN` 全部 200；即便请求头伪造 `X-Forwarded-For: 10.0.0.5` 或 `Host: 其他域名` 也不影响判定。
11. **内部令牌受限**：`x-internal-token` 正确时 `/api/tool-result`、`/api/mcp-send-message` 等内部路由放行；用它访问 `/api/history`、`/api/sessions` 仍 401；错误的内部令牌 401。
12. `ALLOWED_HOSTS=example.com` 时，Host 为 `example.com`/`EXAMPLE.com:3000` 的请求按令牌判定，Host 为 `evil.test` 的请求 403（即使令牌正确）。
13. 令牌来源优先级：请求头 > 查询串 > Cookie。
14. 空白 `ACCESS_TOKEN`（如 `"   "`）视同未配置，生成随机令牌而非放行任意请求。
15. 既有链路无回归：permission-server 的审批与 `/api/tool-result` 回报（本机模式）正常，既有测试套件全过。

## 5. 实施进度

- [x] `lib/access-gate.js`（新增，v2 重写）：`isLoopbackAddress`（含 IPv4-mapped，仅用于决定是否启用门禁）、`resolveAccessToken`（访问令牌 + 内部令牌 + Host 白名单解析）、`parseAllowedHosts`/`isHostAllowed`、`extractToken`（请求头/查询串/Cookie 优先级）、`tokensEqual`（定长时间比较）、`INTERNAL_ROUTES`/`INTERNAL_HEADER`、`createAccessGate` 中间件与 401 形态区分、查询串放行后写 HttpOnly Cookie。**不再有任何按 socket 来源地址放行的分支。**
- [x] `server.js`：`HOST`/`ACCESS_TOKEN`/`ALLOWED_HOSTS` 解析；对外模式下生成 `PERMISSION_INTERNAL_TOKEN` 并写回 `process.env`（在 `require("./invoke.js")` 之前）；门禁中间件置于静态资源与路由之前；启动日志输出访问控制四行；`module.exports.accessConfig` 便于校验。
- [x] `invoke.js`：`buildPermissionEnv` 透传 `PERMISSION_INTERNAL_TOKEN`；`buildPerInvokePermissionOverrides` 增加 `-c mcp_servers.permission.env.PERMISSION_INTERNAL_TOKEN=…`（Codex 侧）。
- [x] `permission-server.js`：新增 `internalAuthHeaders()`，在 `/api/permission-request` 与 `/api/mcp-send-message` 两处请求带 `x-internal-token`（本机模式该变量为空，不发送头部）。
- [x] `lib/tool-result-reporter.js`：`/api/tool-result` 请求头带上内部令牌（同样为空则不发）。
- [x] `test/test-access-gate.js`（v2 重写，57 项）：回环判定、令牌与 Host 白名单解析、来源优先级、相等性判定；用改写 `socket.remoteAddress` 的真实 HTTP 请求覆盖放行/拒绝/Cookie 写入/门禁未启用；`listenUpstream` + `listenProxy` 起一个真实转发的本机反向代理，覆盖"远端 → 本机代理 → 回环上游"场景（无令牌 5 条路由全 401、带访问令牌 200、内部令牌仅限内部路由、错误内部令牌 401、Host 白名单 403）；并断言 `server.accessConfig.enabled === false` 且 `serverInstance.address().address === "127.0.0.1"`（默认本机模式）。
- [x] `test/test-sse-resume.js` 适配：显式传 `HOST` 后 `app.listen(PORT, HOST)` 走异步地址解析，`require` 返回时 `serverInstance.address()` 为 `null`，测试改为等待一次 `listening` 事件再取端口（未削弱产品行为）。
- [x] 冒烟：`HOST=0.0.0.0 ACCESS_TOKEN=…` 与 `HOST=0.0.0.0`（随机令牌）两种启动日志；无令牌访问本机回环 401、带 `?token=` 200。
- [x] 回归：test-access-gate 57、test-file-diff-display 90、test-thread-attribution 27、test-tool-result 38、test-tool-result-reporter 30、test-sse-resume 13、test-chain-caller 10、test-concurrent-parent-routing 12、test-invoke-queue-recycle 13、test-permission-context 51、test-permission-history 20、test-thinking-restore 56、test-tool-records-fold 26、test-metric-bar-label 9、test-send-message 10、test-safe-command 83、test-sessions 24、skill-* 8/11/9、test-robustness 7 全过；`node --check` 与 `git diff --check` 通过。既有失败与本次无关：test-cli-invocation 9 项（win32 平台分支）、test-memory 1 项（依赖真实 CLI），在 `9e54087` 版本上同样失败。
- [ ] 真实跨设备验证（需铲屎官用手机/另一台电脑访问 `http://<本机IP>:PORT/?token=…`）：我无法从本机模拟真实外部链路，浏览器与移动端行为待实测。
