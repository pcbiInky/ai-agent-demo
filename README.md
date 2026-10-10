# ai-agent-demo

## 启动

```bash
node server.js            # 默认 http://127.0.0.1:3000，仅本机可访问
PORT=8080 node server.js  # 换端口
```

## 跨设备访问

默认只监听回环地址，手机/其他电脑访问不到。需要跨设备时显式设置 `HOST`，此时页面、全部 `/api/*`（含会话列表、历史、SSE）与静态资源都由访问令牌保护，**对外模式下一律凭令牌访问，本机浏览器也不例外**（不再按来源地址放行，避免"远端 → 本机反向代理 → 回环上游"绕过门禁）：

```bash
HOST=0.0.0.0 ACCESS_TOKEN=你的令牌 node server.js
```

启动日志会打印访问地址 `http://<本机IP>:PORT/?token=…`，用该链接打开即写入 HttpOnly Cookie，后续 `fetch` 与 `EventSource` 自动带令牌（本机浏览器请用同一链接或 `http://127.0.0.1:PORT/?token=…`）。未设置 `ACCESS_TOKEN` 时每次启动随机生成一个（重启后变化，需重新复制链接）。permission-server / 工具结果回报走服务端自动生成的内部令牌 `PERMISSION_INTERNAL_TOKEN`，只对审批与回报这 4 条内部路由有效，读不到会话历史与文件快照；如需缓解 DNS 重绑定可设置 `ALLOWED_HOSTS`（逗号分隔的 Host 白名单，只收紧不放行）。

注意：服务是明文 HTTP，令牌持有者可读取全部会话历史与 `chat-logs` 中的完整文件快照（`execution.before/after`）。公网或不可信网络请叠加 TLS 反向代理，或改用 VPN/SSH 隧道。详见 `docs/plans/2026-10-10-cross-device-access-token.md`。

## 测试

```bash
node test/test-access-gate.js
node test/test-file-diff-display.js
```
