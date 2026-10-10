# 跨设备访问的令牌门禁方案（v1）

日期：2026-10-10
作者：马哥（qodercn）
状态：v1 已实施，待 YYF 评审
背景：铲屎官要求保留跨设备访问。在此之前，服务默认 `app.listen(PORT)` 监听所有网卡，而 `/api/sessions`、`/api/history`、`/api/events` 均无鉴权；「消息内文件修改 Diff 展示」又把被改文件的完整 `before/after` 写入 `chat-logs` 的 `execution`，等于同网段任意设备可无凭证读取全部会话与文件内容。v12 先把默认监听收紧到 `127.0.0.1`（本机模式缓解），本方案在此基础上让跨设备模式可用且带访问控制。

## 1. 目标与非目标

**目标**
1. 默认仅本机：不设 `HOST` 时监听 `127.0.0.1`，行为与令牌均不引入任何使用成本。
2. 跨设备可用：显式 `HOST=0.0.0.0`（或某个网卡地址）时，远程设备带令牌即可完整使用页面、接口与 SSE。
3. 一并保护，不只封一个接口：页面与静态资源、全部 `/api/*`（含 `/api/sessions`、`/api/history`、`/api/events`）走同一道门禁。
4. 令牌不外泄到日志：只在启动日志打印一次（本机控制台），不写入 `chat-logs`。

**非目标**
- 多用户/角色权限区分（一个令牌 = 全部会话可读）。
- HTTPS/传输加密、登录页、令牌轮换与吊销、请求速率限制。
- 修改 permission-server 的回报链路（其请求来自本机回环，天然免令牌）。

## 2. 方案

### 2.1 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 或具体网卡地址即开启跨设备模式 |
| `PORT` | `3000` | 监听端口 |
| `ACCESS_TOKEN` | 未设置 | 跨设备模式的访问令牌；未设置时启动随机生成（`crypto.randomBytes(24).toString("base64url")`，32 字符），重启后变化 |

`resolveAccessToken({ host, envToken })` 返回 `{ enabled, token, generated }`：仅当 `host` 非回环时 `enabled` 为真；`envToken` 去首尾空白后为空视同未配置（避免用空白令牌把门"锁成永远打不开"或"形同虚设"）。

### 2.2 门禁位置与判定顺序

`app.use(createAccessGate(access))` 位于 `express.json()` 与 `express.static()` **之前**（server.js:411），因此静态页面、资源、SSE 与所有接口一视同仁：

1. `enabled === false`（回环监听）→ 直接放行。
2. 请求来源地址为回环（`127.0.0.0/8`、`::1`、`localhost`、IPv4-mapped `::ffff:127.*`）→ 放行，本机使用方式完全不变（含 permission-server 的 `/api/permission-response`、`/api/tool-result` 回报）。
3. 其余请求按优先级取令牌：`x-access-token` 请求头 → `?token=` 查询串 → `access_token` Cookie；用 `crypto.timingSafeEqual` 定长比较，不等则 401。
4. 通过查询串放行时写入 `access_token` Cookie（`HttpOnly; SameSite=Lax; Path=/`），使后续的静态资源、`fetch`（默认 `same-origin` 凭据）与 `EventSource` 自动带令牌，前端无需改动。

401 响应区分形态：`/api/*` 返回 JSON `{ error: "需要访问令牌…" }`，其余路径返回纯文本提示（提示在 URL 后附加 `?token=`），避免浏览器打开页面时看到裸 JSON。

### 2.3 启动日志

```
AI Chat Arena 已启动: http://0.0.0.0:3000
[访问控制] 跨设备模式已开启，令牌取自 ACCESS_TOKEN 环境变量   （或：为本次启动随机生成（重启后变化））
[访问控制] 远程访问地址: http://<本机IP>:3000/?token=xxxx
[访问控制] 本机回环访问无需令牌；令牌可读取全部会话历史与 chat-logs 中的完整文件快照，请勿外泄
```

绑定 `0.0.0.0`/`::` 时用 `<本机IP>` 占位，不猜测具体网卡地址。

## 3. 取舍与已知限制

1. 明文 HTTP：令牌与文件快照在局域网内明文传输，同网段嗅探者可截获。要真正安全的远程访问应叠加 TLS（反向代理）或 VPN/SSH 隧道——本期不做，由部署方式决定。
2. 单令牌、无权限分级：持令牌者可读取所有会话历史与全部 `execution.before/after` 快照；无审计、无吊销，泄露后只能改 `ACCESS_TOKEN` 或重启（随机令牌模式）轮换。
3. 回环免令牌：本机任意进程都能读取接口与日志。这是保持既有使用方式（含 permission-server、MCP 注册、测试）的必要取舍。
4. 随机令牌每次重启变化：远程设备需重新用启动日志里的链接；配置固定 `ACCESS_TOKEN` 可避免，但需自行保管。
5. 未做速率限制与暴力破解退避；32 字符 base64url 随机令牌的猜测成本足够高，但固定弱口令（如 `ACCESS_TOKEN=123`）不受保护。
6. `?token=` 会进入浏览器历史、代理日志与 Referer（页面内跳转）；已用 HttpOnly Cookie 承接后续请求以缩短令牌在 URL 中的存活时间，但首次链接本身仍有暴露面。
7. 不改变 SSE 语义：门禁只在建立连接时校验一次，长连接期间轮换令牌不会断开已建立的连接。

## 4. 验收用例

1. 不设 `HOST`：监听 `127.0.0.1`，`accessConfig.enabled === false`，本机接口与页面 200。
2. `HOST=0.0.0.0` 且未设 `ACCESS_TOKEN`：启动日志给出随机令牌与远程访问地址；`generated === true`。
3. `HOST=0.0.0.0 ACCESS_TOKEN=x`：启动日志显示"取自 ACCESS_TOKEN 环境变量"，`accessConfig.token === "x"`。
4. 跨设备来源、无令牌：`/api/sessions` 401 且返回 JSON 错误；`/index.html` 401 且返回文本提示。
5. 跨设备来源、错误令牌：401。
6. 跨设备来源、`x-access-token` 请求头：`/api/history` 200。
7. 跨设备来源、`?token=`：200 且响应含 `Set-Cookie: access_token=…; HttpOnly; SameSite=Lax; Path=/`。
8. 跨设备来源、仅带 Cookie：`/api/events` 200（SSE 与静态资源同路径生效）。
9. 回环来源（含 `::ffff:127.0.0.1`）在门禁开启时仍免令牌 200。
10. 令牌来源优先级：请求头 > 查询串 > Cookie。
11. 空白 `ACCESS_TOKEN`（如 `"   "`）视同未配置，生成随机令牌而非放行任意请求。
12. 既有链路无回归：permission-server 的审批与 `/api/tool-result` 回报（本机）正常，8 个既有测试套件全过。

## 5. 实施进度

- [x] `lib/access-gate.js`（新增）：`isLoopbackAddress`（含 IPv4-mapped）、`resolveAccessToken`、`extractToken`（请求头/查询串/Cookie 优先级）、`tokensEqual`（定长时间比较）、`createAccessGate` 中间件与 401 形态区分、查询串放行后写 HttpOnly Cookie。
- [x] `server.js`：`HOST`/`ACCESS_TOKEN` 解析、门禁中间件置于静态资源与路由之前、启动日志输出访问控制信息与远程访问地址、`module.exports.accessConfig` 便于校验。
- [x] `test/test-access-gate.js`（新增，32 项）：回环判定、令牌解析与生成、来源优先级、相等性判定，以及用改写 `socket.remoteAddress` 的真实 HTTP 请求覆盖放行/拒绝/Cookie 写入/回环免令牌/门禁未启用五种路径；并断言 `server.accessConfig.enabled === false`（默认本机模式）。
- [x] 冒烟：`HOST=0.0.0.0 ACCESS_TOKEN=…` 与 `HOST=0.0.0.0`（随机令牌）两种启动日志、本机 `/` 与 `/api/sessions` 均 200。
- [x] 全量回归：test-access-gate 32、test-file-diff-display 90、test-tool-result 38、test-tool-result-reporter 30、test-tool-records-fold 26、test-thinking-restore 56、test-metric-bar-label 9、test-permission-history 20、test-permission-context 51 全过；`node --check` 与 `git diff --check` 通过。
- [ ] 真实跨设备验证（需铲屎官用手机/另一台电脑访问 `http://<本机IP>:PORT/?token=…`）：我无法从本机模拟非回环来源以外的真实链路，浏览器与移动端行为待实测。
