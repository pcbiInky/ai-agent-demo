# 跨设备访问的令牌门禁方案（v4，内部路由豁免 Host 白名单）

日期：2026-10-10
作者：马哥（qodercn）
状态：v4 已实施，待 YYF 复审
变更记录：
- v1 默认监听回环；对外模式下按 socket 来源放行回环请求，本机 permission/MCP 链路依赖该豁免。
- v2 按 YYF 复审意见取消来源地址信任：对外模式下一律凭令牌，本机 permission/MCP 回报改走**受限的内部令牌**（只对 4 条内部路由有效），并补 `ALLOWED_HOSTS` 以缓解 DNS 重绑定。
- v3 按 YYF 复审意见再修两处部署路径：① 门禁启用条件与监听地址**解耦**——显式配置 `ACCESS_TOKEN` 即启用，即使 `HOST=127.0.0.1`（本机 TLS 反代对外发布的常见配置）；② 内部回报链路连接**实际监听地址**（`PERMISSION_SERVER_HOST`），修复绑定具体网卡或 `::1` 时审批/SendMessage/执行结果回报连不上的问题。
- v4 修复 v2/v3 引入的配置组合冲突：`ALLOWED_HOSTS` 的 Host 校验排在内部令牌之前，会把 permission-server 发往 `127.0.0.1:PORT`（或具体网卡地址）的请求判成 403，导致按 §2.4 文档开启白名单后审批、SendMessage 与执行结果回报全部失效。改为**内部路由 + 正确内部令牌先放行**，其余请求仍按 Host 白名单与访问令牌判定；同时修正 §2.4 的令牌生成命令（`openssl rand -base64url` 在本机不存在）。

背景：铲屎官要求保留跨设备访问。在此之前，服务默认 `app.listen(PORT)` 监听所有网卡，而 `/api/sessions`、`/api/history`、`/api/events` 均无鉴权；「消息内文件修改 Diff 展示」又把被改文件的完整 `before/after` 写入 `chat-logs` 的 `execution`，等于同网段任意设备可无凭证读取全部会话与文件内容。v12 先把默认监听收紧到 `127.0.0.1`（本机模式缓解），本方案在此基础上让跨设备模式可用且带访问控制。

## 0. v2 修复内容（YYF 复审：代理绕过）

**问题**：v1 的门禁第一条规则是"socket 来源为回环即放行"，且默认 `HOST=127.0.0.1` 时门禁完全不启用。于是同机 TLS 反向代理若对外发布、上游连 `127.0.0.1`，远端请求到 `/api/history` 在上游看来就是本机请求 → 直接放行；DNS 重绑定到回环也会触发同一种误信任。这与 v1 §3 推荐"用 TLS 反代"的用法直接冲突。

**修复**：
1. **不再用来源地址做信任判断**。对外模式（`HOST` 非回环）下，所有请求一律要凭证；`Host` 头与 `X-Forwarded-For` 都不作为放行依据（`ALLOWED_HOSTS` 只用于额外收紧，不用于放行）。
2. **内部令牌（受限且可验证）**：`PERMISSION_INTERNAL_TOKEN` 由 server 启动时生成（或取自环境变量），通过 `buildPermissionEnv` 传给 permission-server 子进程（Codex 走 `-c mcp_servers.permission.env.PERMISSION_INTERNAL_TOKEN`，ACP/Claude 走 env 条目），子进程在 `x-internal-token` 头上携带。它**只对 4 条内部路由有效**：`/api/permission-request`、`/api/permission-response`、`/api/tool-result`、`/api/mcp-send-message`；用它访问 `/api/history`、`/api/sessions`、`/api/events`、页面与静态资源仍然 401。`ACCESS_TOKEN` 也可用于这 4 条路由，便于人工排查。
3. **`ALLOWED_HOSTS`**（可选，逗号分隔，大小写不敏感，端口可省）：配置后 Host 头不在列表内直接 403，用于缓解 DNS 重绑定。
4. 默认本机模式（不设 `HOST`、不设 `ACCESS_TOKEN`）完全不变：门禁不启用、内部令牌不要求，permission-server 与既有测试零成本。（v3 起，只设 `ACCESS_TOKEN` 也会在回环监听下启用门禁，见 §0.1。）

**行为变化（需铲屎官知晓）**：对外模式下**本机浏览器也要令牌**——用启动日志里的 `http://<本机IP>:PORT/?token=…` 打开（会写入 HttpOnly Cookie），或 `http://127.0.0.1:PORT/?token=…`。这是取消来源豁免的必然代价。

**回归用例（YYF 要求）**：本机反向代理把请求转发到回环上游，无令牌访问 `/api/history`、`/api/sessions`、`/api/events`、`/index.html`、`/api/tool-result` 全部 401；带 `ACCESS_TOKEN` 200；带内部令牌只能过内部路由。


## 0.1 v3 修复内容（YYF 复审：两处未覆盖的部署路径）

**[P1] 回环上游 + 公网 TLS 反代仍无鉴权**

v2 的 `resolveAccessToken` 只看监听地址：`enabled = !isLoopbackAddress(host)`。于是 `HOST=127.0.0.1 ACCESS_TOKEN=x` 仍然 `enabled === false`——**显式配置令牌完全无效**。而"公网 TLS 代理 → 本机 `127.0.0.1:3000`"恰是最常见的安全部署，v2 的代理回归只覆盖了上游 `enabled=true` 的情况，没覆盖这条路径，等于把 §3 推荐的用法留在无鉴权状态。

修复：启用条件与监听地址解耦。

```js
const configured = typeof envToken === "string" ? envToken.trim() : "";
const hostExposed = !isLoopbackAddress(host);
if (!hostExposed && !configured) return { enabled: false, hostExposed: false, … };   // 默认本机免令牌体验不变
return { enabled: true, hostExposed, token: configured || randomToken(), generated: !configured, … };
```

- 绑定非回环地址 → 强制启用（未配置令牌则随机生成），与 v2 一致。
- 绑定回环但**显式配置了 `ACCESS_TOKEN`** → 同样启用，覆盖反代部署。
- 两者都没有 → `enabled: false`，默认本机体验零成本不变（空白 `ACCESS_TOKEN` 视同未配置，不会因为写了空格就把本机锁死或放行所有人）。
- 新增 `hostExposed` 字段仅用于启动日志措辞：回环 + 令牌时打印"已开启令牌门禁（仍只监听回环地址，适用于本机 TLS 反向代理对外发布）"，不再误称"跨设备模式"。
- 回归：`test-access-gate.js` 用 `resolveAccessToken({ host: "127.0.0.1", envToken: … })` 起真实回环上游 + 真实转发代理，断言无令牌访问 `/api/history`、`/api/sessions`、`/api/events`、`/index.html`、`/api/tool-result` 全部 401，带 `ACCESS_TOKEN` 200，内部令牌读不到历史只过回报路由，本机直连无令牌也 401。

**[P2] 内部客户端写死 `127.0.0.1`，指定地址绑定下回报失败**

文档承诺 `HOST=具体网卡地址` 可用，但 `permission-server.js` 的两处 `http.request` 与 `lib/tool-result-reporter.js` 始终连 `127.0.0.1:PORT`；`HOST=::1` 同理。结果是绑定具体网卡或 IPv6 回环时，审批长轮询、SendMessage、执行结果回报全部连接失败（`HOST=0.0.0.0` 不受影响，因为通配监听包含回环）。

修复：新增 `PERMISSION_SERVER_HOST`，由 server 启动时按实际监听地址注入，子进程与回报模块一律使用它。

```js
// server.js：通配监听时回环可达，其余情况必须连绑定地址本身
process.env.PERMISSION_SERVER_HOST = process.env.PERMISSION_SERVER_HOST || resolveInternalHost(HOST);
// lib/access-gate.js
function resolveInternalHost(listenHost) {
  const value = typeof listenHost === "string" ? listenHost.trim() : "";
  if (!value || isWildcardAddress(value)) return "127.0.0.1";   // 0.0.0.0 / :: / ::0 / * / 空
  return value;
}
```

传递链路：`server.js` 写 `process.env` → `invoke.js buildPermissionEnv`（Trae/Claude/ACP 走 env 继承，Codex 走 `-c mcp_servers.permission.env.PERMISSION_SERVER_HOST=…`）→ `permission-server.js` 的 `SERVER_HOST`（`/api/permission-request`、`/api/mcp-send-message` 两处）与 `lib/tool-result-reporter.js`（`/api/tool-result`）。未注入时仍回落 `127.0.0.1`，既有本机链路与测试零改动。

回归：`resolveInternalHost` 通配/具体地址/`::1`/`localhost` 各分支；真实绑定 `::1` 与非回环 IPv4 网卡地址后用 `reportToolResult` 回报——注入地址时 200 且命中 `/api/tool-result`，不注入时失败（status 0），证明该变量是必需的而非装饰；源码级断言 `permission-server.js` 两处都用 `SERVER_HOST` 且不再有 `hostname: "127.0.0.1"`。


## 0.2 v4 修复内容（YYF 复审：ALLOWED_HOSTS 与内部路由冲突）

**[P1] 开启 Host 白名单后内部工具链全部 403**

v2/v3 的判定顺序是 `Host 白名单 → 访问令牌 → 内部令牌`。而 §2.4 恰恰建议反代部署配置 `ALLOWED_HOSTS=arena.example.com`；permission-server 子进程连的是 `PERMISSION_SERVER_HOST`（`127.0.0.1` 或具体网卡地址），其 `Host` 头就是 `127.0.0.1:PORT`，不在白名单里 → 即使 `x-internal-token` 正确也在第一关被 403。YYF 的最小实测：

```js
resolveAccessToken({ host: "127.0.0.1", envToken: "public", envInternalToken: "internal", allowedHosts: "arena.example.com" })
// 带正确内部令牌 POST /api/permission-request → 403（修复前）
```

结果是按文档开启白名单就会让审批、SendMessage 与执行结果回报同时失效——文档推荐配置直接踩坑。

修复：把"内部路由 + 正确内部令牌"提到 Host 校验之前（`lib/access-gate.js:130-160`）。

```js
if (!enabled) return next();
const isInternalRoute = INTERNAL_ROUTES.has(requestPath(req));
if (isInternalRoute && tokensEqual(req.headers?.[INTERNAL_HEADER], internalToken)) return next();  // 豁免 Host 白名单
if (!isHostAllowed(req, allowedHosts)) { res.status(403); … }                                      // 其余请求照旧
if (tokensEqual(extractToken(req).token, token)) { …写 Cookie…; return next(); }
return deny(…);
```

安全性说明：豁免只覆盖 4 条固定内部路由，且必须持有内部令牌（32 字符随机、只经环境变量传给子进程、不进 Cookie、不下发浏览器）。没有内部令牌的请求（含 DNS 重绑定后浏览器发出的跨源请求）仍先撞 Host 白名单 403，再撞 401，因此白名单对浏览器面的防护不变；内部令牌也依然读不到 `/api/history`、`/api/sessions`、`/api/events` 与页面。

**回归（真实请求，覆盖两种内部 Host）**
- 回环反代：上游按 `resolveAccessToken({ host: "127.0.0.1", envToken, envInternalToken, allowedHosts: "arena.example.com" })` 运行，直连（`Host: 127.0.0.1:PORT`）与经真实转发代理（代理把 Host 改写为 `127.0.0.1:PORT`）两种方式，4 条内部路由带正确内部令牌全部 200；内部令牌错误全部 403；`/api/history` 带内部令牌 403、无令牌 403。
- 具体网卡地址：上游真实绑定非回环 IPv4（本机 `7.249.233.43`），`Host: <网卡地址>:<port>` 下 `/api/tool-result`、`/api/mcp-send-message` 带内部令牌 200，`/api/history` 带内部令牌 403，无令牌 `/api/sessions` 403，白名单内 Host（`arena.example.com`）+ 访问令牌 200。
- 白名单本身没被削弱：白名单外 Host 即使访问令牌正确也 403；白名单内 Host 忽略大小写与端口；Host 合法但无令牌仍 401。

**[P2] 测试自身的缺陷（顺带修正）**：原先 Host 白名单用例用 `fetch(..., { headers: { host: "evil.example" } })` 伪造 Host，但 `host` 是 Fetch 规范的 forbidden header，undici 会**静默丢弃**——服务端看到的是 `127.0.0.1:PORT`，断言"碰巧"通过而没真正覆盖白名单命中路径。已改用 `http.request` 的 `requestRaw` 辅助函数（实测 `http.get` 的 Host 覆盖会生效），并补"白名单内 Host 放行"与"Host 合法但无令牌 401"两条正向用例。

**[P2] 文档命令错误**：§2.4 的 `openssl rand -base64url 24` 在本机报 `rand: Unknown option: -base64url`（LibreSSL 不支持该输出格式），已改为 `openssl rand -hex 24`。

## 1. 目标与非目标

**目标**
1. 默认仅本机：不设 `HOST`、不设 `ACCESS_TOKEN` 时监听 `127.0.0.1` 且门禁不启用，行为与令牌均不引入任何使用成本。
2. 跨设备可用：显式 `HOST=0.0.0.0`（或某个网卡地址）时强制启用门禁，远程设备带令牌即可完整使用页面、接口与 SSE；绑定具体网卡地址或 `::1` 时内部回报链路照样可用。
3. 反代部署可用：上游保持回环监听、由本机 TLS 代理对外发布时，显式配置 `ACCESS_TOKEN` 即启用门禁，不依赖监听地址判断。
4. 一并保护，不只封一个接口：页面与静态资源、全部 `/api/*`（含 `/api/sessions`、`/api/history`、`/api/events`）走同一道门禁。
5. 令牌不外泄到日志：只在启动日志打印一次（本机控制台），不写入 `chat-logs`。

**非目标**
- 多用户/角色权限区分（一个令牌 = 全部会话可读）。
- HTTPS/传输加密、登录页、令牌轮换与吊销、请求速率限制。
- 按客户端自报信息（`Host`、`X-Forwarded-For`、`Forwarded`）还原真实来源并据此放行：自报字段可由客户端伪造，`ALLOWED_HOSTS` 只用于收紧。

## 2. 方案

### 2.1 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 或具体网卡地址即对外暴露（强制启用门禁）；保持回环时用 `ACCESS_TOKEN` 单独启用门禁（反代部署） |
| `PORT` | `3000` | 监听端口 |
| `ACCESS_TOKEN` | 未设置 | 访问令牌。**一旦显式配置（去空白后非空）即启用门禁，与监听地址无关**；绑定非回环地址而未配置时启动随机生成（`crypto.randomBytes(24).toString("base64url")`，32 字符），重启后变化 |
| `PERMISSION_INTERNAL_TOKEN` | 未设置（门禁启用时自动生成） | 内部令牌，仅对 4 条内部路由有效；门禁启用时由 server 生成并写回 `process.env` 再传给 permission-server 子进程，未启用时为空即不发送该请求头 |
| `PERMISSION_SERVER_HOST` | 由 server 按 `HOST` 自动注入 | 内部回报链路（审批、SendMessage、工具结果回报）连接的主服务地址；通配监听（`0.0.0.0`/`::`）解析为 `127.0.0.1`，其余沿用 `HOST`。显式设置可覆盖（例如主服务与子进程不在同一网络命名空间） |
| `ALLOWED_HOSTS` | 未设置 | 可选 Host 白名单（逗号分隔，大小写不敏感，端口可省）；配置后 Host 不在列表内直接 403，用于缓解 DNS 重绑定。**只收紧，不放行** |

`resolveAccessToken({ host, envToken, envInternalToken, allowedHosts })` 返回 `{ enabled, hostExposed, token, generated, internalToken, allowedHosts }`：`enabled = 非回环监听 || 显式配置了 ACCESS_TOKEN`；`hostExposed` 只用于日志措辞。`envToken`/`envInternalToken` 去首尾空白后为空视同未配置（避免用空白令牌把门"锁成永远打不开"或"形同虚设"），门禁启用而未配置的内部令牌随机生成。
`resolveInternalHost(listenHost)` 返回内部回报地址：空值与通配地址（`0.0.0.0`、`::`、`::0`、`*`）→ `127.0.0.1`，其余原样返回（含 `::1`、`localhost`、具体网卡地址）。

### 2.2 门禁位置与判定顺序

`app.use(createAccessGate(access))` 位于 `express.json()` 与 `express.static()` **之前**（server.js:411），因此静态页面、资源、SSE 与所有接口一视同仁：

1. `enabled === false`（回环监听且未配置 `ACCESS_TOKEN`）→ 直接放行，本机使用方式与既有测试零成本。
2. 路径属于内部路由（`/api/permission-request`、`/api/permission-response`、`/api/tool-result`、`/api/mcp-send-message`）且 `x-internal-token` 匹配 → 放行，**并豁免下一步的 Host 白名单**（子进程连的是实际监听地址，其 Host 天然不在面向浏览器的 `ALLOWED_HOSTS` 里；v4 修复）。
3. 配置了 `ALLOWED_HOSTS` 且请求 Host 不在列表内 → 403（DNS 重绑定防护）。
4. `ACCESS_TOKEN` 匹配（`x-access-token` 头 → `?token=` 查询串 → `access_token` Cookie，`crypto.timingSafeEqual` 定长比较）→ 放行；若令牌来自查询串则写入 `access_token` Cookie（`HttpOnly; SameSite=Lax; Path=/`），后续静态资源、`fetch`（默认 same-origin 凭据）与 `EventSource` 自动带令牌，前端无需改动。
5. 其余一律 401：`/api/*` 返回 JSON `{ error }`，页面与静态资源返回纯文本提示（提示在 URL 后附加 `?token=`），避免浏览器打开页面时看到裸 JSON。

**注意 1**：判定顺序里没有"来源地址是回环"这一条——本机反向代理转发过来的远端请求与真正的本机请求在 socket 层同形，按来源放行等于把接口敞开。
**注意 2**：第 2 步的豁免只覆盖那 4 条内部路由且必须持内部令牌；没有内部令牌的请求（含重绑定后浏览器发出的跨源请求）仍先撞 Host 白名单 403、再撞 401，内部令牌也始终读不到 `/api/history`、`/api/sessions`、`/api/events` 与页面。

### 2.3 启动日志

跨设备模式（`HOST=0.0.0.0`）：

```
AI Chat Arena 已启动: http://0.0.0.0:3000
[访问控制] 跨设备模式已开启，令牌取自 ACCESS_TOKEN 环境变量   （或：为本次启动随机生成（重启后变化））
[访问控制] 访问地址: http://<本机IP>:3000/?token=xxxx
[访问控制] 内部回报地址: http://127.0.0.1:3000（permission-server / 工具结果回报，走内部令牌）
[访问控制] 门禁启用后一律凭令牌访问（含本机浏览器与经反向代理的请求）；内部令牌仅限审批与回报路由
[访问控制] 令牌可读取全部会话历史与 chat-logs 中的完整文件快照，请勿外泄；如需防 DNS 重绑定可设置 ALLOWED_HOSTS
```

回环监听 + 显式令牌（本机 TLS 反代部署，实测输出）：

```
AI Chat Arena 已启动: http://127.0.0.1:3987
[访问控制] 已开启令牌门禁（仍只监听回环地址，适用于本机 TLS 反向代理对外发布），令牌取自 ACCESS_TOKEN 环境变量
[访问控制] 访问地址: http://127.0.0.1:3987/?token=smoke-token
[访问控制] 内部回报地址: http://127.0.0.1:3987（permission-server / 工具结果回报，走内部令牌）
```

绑定 `0.0.0.0`/`::` 时访问地址用 `<本机IP>` 占位，不猜测具体网卡地址；内部回报地址始终打印解析后的真实目标，便于确认绑定具体网卡或 `::1` 时子进程连的是哪个地址。

### 2.4 部署：本机 TLS 反向代理对外发布

```bash
ACCESS_TOKEN=$(openssl rand -hex 24) node server.js     # HOST 保持默认 127.0.0.1
```

nginx 侧（示例，SSE 需要关掉缓冲）：

```nginx
server {
  listen 443 ssl;
  server_name arena.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_buffering off;          # /api/events 是 SSE
    proxy_read_timeout 3600s;
  }
}
```

要点：
- 上游只监听回环，公网入口只有代理；因为门禁**不看来源地址**，远端请求仍必须带 `ACCESS_TOKEN`（浏览器用 `https://arena.example.com/?token=…` 打开一次即可，Cookie 是 `SameSite=Lax` + `HttpOnly`，跨站不携带）。
- 代理不要改写或注入令牌；`ALLOWED_HOSTS=arena.example.com` 可以顺带挡住 DNS 重绑定与直接用 IP 访问的探测。白名单只作用于浏览器面：permission-server 的 4 条内部路由在持正确内部令牌时豁免 Host 校验（v4），因此开启白名单不会让审批与回报失效。
- 建议在代理层再加一层认证（如 mTLS / Basic Auth / OAuth proxy）：应用侧只有单令牌，泄露后没有吊销手段。
- permission-server 子进程走 `PERMISSION_SERVER_HOST`（此处即 `127.0.0.1`）+ 内部令牌，直连上游、不经过公网代理；代理无需为这 4 条内部路由做任何放行配置。
- 令牌生成用 `openssl rand -hex 24`（48 个十六进制字符）；注意 `openssl rand -base64url` 在 macOS 自带的 LibreSSL 上不可用（`rand: Unknown option`）。

## 3. 取舍与已知限制

1. 明文 HTTP：令牌与文件快照在局域网内明文传输，同网段嗅探者可截获。要真正安全的远程访问应叠加 TLS（反向代理）或 VPN/SSH 隧道——本期不做，由部署方式决定。
2. 单令牌、无权限分级：持令牌者可读取所有会话历史与全部 `execution.before/after` 快照；无审计、无吊销，泄露后只能改 `ACCESS_TOKEN` 或重启（随机令牌模式）轮换。
3. 门禁启用后本机浏览器同样需要令牌（取消来源豁免的代价）；未配置 `ACCESS_TOKEN` 且监听回环时门禁不启用，本机任意进程仍可读取接口与日志——这是保持既有使用方式（含 permission-server、MCP 注册、测试）零成本的必要取舍，代价是默认模式下不做任何鉴权。
4. 内部令牌的暴露面：`PERMISSION_INTERNAL_TOKEN` 通过环境变量传给子进程，同机可读 `/proc`（或 `ps eww`）的进程可取到它；它只能调用 4 条内部路由（发起审批、提交审批结果、回报工具结果、以角色身份发消息），读不到会话历史与文件快照。若不需要对外发布，保持默认（不设 `HOST`、不设 `ACCESS_TOKEN`）即可完全不引入该变量。
5. `PERMISSION_SERVER_HOST` 在 server 启动时一次性写入 `process.env`，之后修改 `HOST` 需重启；子进程若在 server 之外单独启动（例如手工 `node permission-server.js`），必须自行导出该变量与 `PERMISSION_INTERNAL_TOKEN`，否则回报会连到 `127.0.0.1` 且不带内部令牌。`HOST=localhost` 时按主机名回报，依赖系统解析到实际监听的那个地址族。
6. `ALLOWED_HOSTS` 默认关闭：不配置时不校验 Host 头，DNS 重绑定仍可能把浏览器请求指向本机服务（此时页面与接口需令牌，风险由令牌承担）。开启后 4 条内部路由在持正确内部令牌时豁免该校验（v4）——这是让白名单与内部回报链路共存的必要豁免，代价是：若内部令牌泄露，攻击者可以带任意 Host 调用这 4 条路由（仍读不到历史与文件快照，但能以角色身份发消息或提交审批结果）。因此内部令牌的保管要求与 `ACCESS_TOKEN` 同级。
7. 随机令牌每次重启变化：远程设备需重新用启动日志里的链接；配置固定 `ACCESS_TOKEN` 可避免，但需自行保管。
8. 未做速率限制与暴力破解退避；32 字符 base64url 随机令牌的猜测成本足够高，但固定弱口令（如 `ACCESS_TOKEN=123`）不受保护。
9. `?token=` 会进入浏览器历史、代理日志与 Referer（页面内跳转）；已用 HttpOnly Cookie 承接后续请求以缩短令牌在 URL 中的存活时间，但首次链接本身仍有暴露面。
10. 不改变 SSE 语义：门禁只在建立连接时校验一次，长连接期间轮换令牌不会断开已建立的连接。
11. 不解析 `X-Forwarded-For`/`Forwarded`：真实客户端地址无法在应用层可信还原，因此不做基于来源 IP 的白名单；需要按来源限制时应由外层代理或防火墙完成。
12. 反向代理需自行处理 SSE（`proxy_buffering off`、足够长的 `proxy_read_timeout`）与 WebSocket 升级（当前未使用）；应用侧不校验代理身份，因此代理必须部署在同一信任域内。

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
11. **内部令牌受限**：`x-internal-token` 正确时 `/api/tool-result`、`/api/mcp-send-message` 等内部路由放行；用它访问 `/api/history`、`/api/sessions` 在未配白名单时 401、配了白名单且 Host 不在列表内时 403；错误的内部令牌 401（无白名单）/403（有白名单且 Host 不匹配）。
12. `ALLOWED_HOSTS=example.com` 时，Host 为 `example.com`/`EXAMPLE.com:3000` 的请求按令牌判定（无令牌 401），Host 为 `evil.test` 的请求 403（即使访问令牌正确）。Host 覆盖必须用 `http.request` 构造（`fetch` 会丢弃 forbidden header `host`）。
13. 令牌来源优先级：请求头 > 查询串 > Cookie。
14. 空白 `ACCESS_TOKEN`（如 `"   "`）视同未配置：绑定非回环时生成随机令牌，绑定回环时门禁仍不启用（不会因为写了空格就把本机锁死或放行所有人）。
15. **回环监听 + 显式 `ACCESS_TOKEN`（v3）**：`resolveAccessToken({ host: "127.0.0.1", envToken: "x" })` → `enabled === true`、`hostExposed === false`、`token === "x"`、`generated === false`、`internalToken` 非空；`HOST=127.0.0.1 ACCESS_TOKEN=x` 启动后本机无令牌访问 `/api/sessions` 401、带 `x-access-token` 200、`?token=x` 200 且写 `Set-Cookie`。
16. **`HOST=127.0.0.1` + 公网代理 + 无令牌必须 401（YYF 要求的回归）**：上游按"回环监听 + 显式令牌"配置，经真实转发的本机代理访问 `/api/history`、`/api/sessions`、`/api/events`、`/index.html`、`/api/tool-result` 全部 401；带 `ACCESS_TOKEN` 200；带内部令牌时 `/api/history` 仍 401、`/api/tool-result` 200。
17. **内部回报地址（v3）**：`resolveInternalHost` 对 `0.0.0.0`/`::`/`::0`/`*`/空值返回 `127.0.0.1`，对 `192.168.1.5`/`::1`/`localhost` 原样返回；真实绑定 `::1` 与非回环 IPv4 网卡地址后，`PERMISSION_SERVER_HOST` 指向该地址时 `reportToolResult` 命中 `/api/tool-result` 返回 200，未注入时回报失败（status 0）。
18. **子进程环境透传（v3）**：`buildPermissionEnv` 输出含 `PERMISSION_SERVER_HOST`；Codex 的 per-invoke overrides 含 `mcp_servers.permission.env.PERMISSION_SERVER_HOST` 与 `…PERMISSION_INTERNAL_TOKEN`；`permission-server.js` 两处 `http.request` 都使用 `SERVER_HOST`，源码中不再有 `hostname: "127.0.0.1"`。
19. **`ALLOWED_HOSTS` + 内部路由（v4，YYF 要求）**：上游按 `resolveAccessToken({ host: "127.0.0.1", envToken: "public-token", envInternalToken: "internal-token", allowedHosts: "arena.example.com" })` 运行时，4 条内部路由带正确内部令牌在"直连回环 Host"与"经反代（Host 被改写为 `127.0.0.1:PORT`）"两种情况下均 200；内部令牌错误 403；`/api/history` 带内部令牌 403、无令牌 403；白名单内 Host + 访问令牌 200；白名单外 Host + 正确访问令牌 403。
20. **`ALLOWED_HOSTS` + 具体网卡地址（v4）**：上游真实绑定非回环 IPv4，`Host: <网卡地址>:<port>` 下 `/api/tool-result`、`/api/mcp-send-message` 带内部令牌 200，`/api/history` 带内部令牌 403，`/api/sessions` 无令牌 403，白名单内 Host + 访问令牌 200。
21. **令牌生成命令（v4）**：文档给出 `openssl rand -hex 24`；已在本机确认 `openssl rand -base64url 24` 报 `rand: Unknown option: -base64url`。
22. 既有链路无回归：permission-server 的审批与 `/api/tool-result` 回报（默认本机模式）正常，既有测试套件全过。

## 5. 实施进度

- [x] `lib/access-gate.js`（新增，v2 重写 + v3 解耦 + v4 顺序修正）：`isLoopbackAddress`（含 IPv4-mapped）、`isWildcardAddress`、`resolveInternalHost`（v3）、`resolveAccessToken`（v3：`enabled = 非回环监听 || 显式 ACCESS_TOKEN`，返回含 `hostExposed`）、`parseAllowedHosts`/`isHostAllowed`、`extractToken`（请求头/查询串/Cookie 优先级）、`tokensEqual`（定长时间比较）、`INTERNAL_ROUTES`/`INTERNAL_HEADER`、`createAccessGate`（v4：内部路由 + 正确内部令牌先放行并豁免 Host 白名单，其后才是白名单 403、访问令牌放行、401）、查询串放行后写 HttpOnly Cookie。**不再有任何按 socket 来源地址放行的分支。**
- [x] `server.js`：`HOST`/`ACCESS_TOKEN`/`ALLOWED_HOSTS` 解析；门禁启用时生成 `PERMISSION_INTERNAL_TOKEN` 并写回 `process.env`（在 `require("./invoke.js")` 之前）；v3 注入 `process.env.PERMISSION_SERVER_HOST = resolveInternalHost(HOST)`；门禁中间件置于静态资源与路由之前；启动日志按 `hostExposed` 区分措辞并打印内部回报地址；`module.exports.accessConfig` 便于校验；v3 更正了 §2 顶部"回环请求放行"的过期注释。
- [x] `invoke.js`：`buildPermissionEnv` 透传 `PERMISSION_INTERNAL_TOKEN` 与 `PERMISSION_SERVER_HOST`；`buildPerInvokePermissionOverrides` 增加两者对应的 `-c mcp_servers.permission.env.…`（Codex 侧）。
- [x] `permission-server.js`：新增 `internalAuthHeaders()`（两处请求带 `x-internal-token`，未启用门禁时为空即不发）与 `SERVER_HOST`（v3，两处 `http.request` 的 `hostname` 改为实际监听地址），文件头环境变量说明同步补充。
- [x] `lib/tool-result-reporter.js`：`/api/tool-result` 请求头带上内部令牌（为空则不发），`hostname` 改为 `process.env.PERMISSION_SERVER_HOST || "127.0.0.1"`（v3）。
- [x] `test/test-access-gate.js`（v4，120 项）：回环/通配地址判定、令牌与 Host 白名单解析、`resolveInternalHost` 各分支、令牌模式与监听地址解耦（回环 + 显式令牌启用、回环 + 空白令牌不启用、非回环未配置强制生成）、来源优先级、相等性判定；用改写 `socket.remoteAddress` 的真实 HTTP 请求覆盖放行/拒绝/Cookie 写入/门禁未启用；`listenUpstream` + `listenProxy` 起真实转发的本机反向代理，分别覆盖"上游门禁开启"、v3 的"`HOST=127.0.0.1` + `ACCESS_TOKEN` + 公网代理"与 v4 的"`ALLOWED_HOSTS` + 内部路由"（无令牌 5 条路由全 401、带访问令牌 200、内部令牌直连与经反代均放行 4 条内部路由、内部令牌错误 403、内部令牌读历史 403、Host 白名单 403）；`listen(app, host)` 支持绑定具体网卡地址，v4 在真实非回环 IPv4 上验证内部 Host 的放行与拒绝；`listenOn("::1")` 与真实网卡地址上验证 `reportToolResult` 必须走 `PERMISSION_SERVER_HOST`（注入时 200、未注入时 0）；源码级断言内部客户端不再写死回环；并断言 `server.accessConfig.enabled === false`（默认本机模式）。
- [x] `test/test-access-gate.js` 测试自身修正（v4）：Host 白名单用例原先用 `fetch(..., { headers: { host } })` 伪造 Host，但 `host` 是 Fetch 规范的 forbidden header、undici 静默丢弃，断言其实是被默认 Host"碰巧"满足的。新增 `requestRaw`（`http.request`，实测 Host 覆盖生效）并改用之，同时补"白名单内 Host（忽略大小写与端口）+ 令牌放行 200"与"Host 合法但无令牌 401"两条正向用例。
- [x] `test/test-permission-context.js`（+3 项，共 54）：Trae env 携带 `PERMISSION_SERVER_HOST`；Codex per-invoke overrides 携带 `PERMISSION_SERVER_HOST` 与 `PERMISSION_INTERNAL_TOKEN`（用例内保存/恢复环境变量）。
- [x] `test/test-sse-resume.js` 适配：显式传 `HOST` 后 `app.listen(PORT, HOST)` 走异步地址解析，`require` 返回时 `serverInstance.address()` 为 `null`，测试改为等待一次 `listening` 事件再取端口（未削弱产品行为）。
- [x] 冒烟：`HOST=127.0.0.1 ACCESS_TOKEN=smoke-token`（日志显示"已开启令牌门禁（仍只监听回环地址…）"，无令牌 `/api/sessions` 401、带头 200、`?token=` 200 且写 HttpOnly Cookie）；`HOST=0.0.0.0`（随机令牌 + 内部回报地址 `127.0.0.1`）；`HOST=::1`（回环且未配置令牌，门禁不启用）；v4 追加 `ALLOWED_HOSTS=arena.example.com` 组合实测——默认 Host + 访问令牌 403、`Host: arena.example.com` + 访问令牌 200、默认 Host + 内部令牌 POST `/api/tool-result` 通过门禁（返回 400 来自路由自身的参数校验，不再是 403）、错误内部令牌 403、`/api/history` 带内部令牌 403；并确认 `openssl rand -hex 24` 可用、`openssl rand -base64url 24` 报 `rand: Unknown option`。
- [x] 回归：test-access-gate 120、test-permission-context 54、test-file-diff-display 90、test-thread-attribution 27、test-tool-result 38、test-tool-result-reporter 30、test-sse-resume 13、test-chain-caller 10、test-concurrent-parent-routing 12、test-invoke-queue-recycle 13、test-permission-history 20、test-thinking-restore 56、test-tool-records-fold 26、test-metric-bar-label 9、test-send-message 10、test-safe-command 83、test-sessions 24、test-session-members 8、skill-* 8/11/9、test-robustness 7、各 metrics 套件（claude 39 / dsh 27 / kimi 54 / qodercn 63 / role 19 / usage 30）、test-office-mcp 35、test-webfetch-auto-approval 23、test-thinking-log 16、test-thinking-stream 18、test-role-regressions 7、test-invoke-prompt-order 5 全过；`node --check` 与 `git diff --check` 通过。既有失败与本次无关：test-cli-invocation 9 项（win32 平台分支）、test-memory 1 项（依赖真实 CLI），在 `9e54087` 版本上同样失败。
- [ ] 真实跨设备验证（需铲屎官用手机/另一台电脑访问 `http://<本机IP>:PORT/?token=…`）与真实 TLS 反代验证（nginx/Caddy + `ACCESS_TOKEN`，含 SSE 长连接）：我无法从本机模拟真实外部链路与公网证书，浏览器、移动端与代理侧行为待实测。
