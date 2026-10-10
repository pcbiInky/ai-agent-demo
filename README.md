# ai-agent-demo

## 启动

```bash
node server.js            # 默认 http://127.0.0.1:3000，仅本机可访问
PORT=8080 node server.js  # 换端口
```

## 跨设备访问

默认只监听回环地址，手机/其他电脑访问不到，且不启用门禁。需要跨设备时显式设置 `HOST`（非回环地址会强制启用门禁）；也可以只设置 `ACCESS_TOKEN` 而保持回环监听，用于本机 TLS 反向代理对外发布的部署。门禁启用后页面、全部 `/api/*`（含会话列表、历史、SSE）与静态资源都需要令牌，**本机浏览器也不例外**（不按来源地址放行，避免"远端 → 本机反向代理 → 回环上游"绕过门禁）：

```bash
HOST=0.0.0.0 ACCESS_TOKEN=你的令牌 node server.js   # 局域网直连
ACCESS_TOKEN=你的令牌 node server.js                # 仍只听 127.0.0.1，由 nginx/Caddy 做 TLS 反代对外
```

启动日志会打印访问地址 `http://<本机IP>:PORT/?token=…`，用该链接打开即写入 HttpOnly Cookie，后续 `fetch` 与 `EventSource` 自动带令牌（本机浏览器请用同一链接或 `http://127.0.0.1:PORT/?token=…`）。绑定非回环地址却未设置 `ACCESS_TOKEN` 时，每次启动随机生成一个（重启后变化，需重新复制链接）。permission-server / 工具结果回报走服务端自动生成的内部令牌 `PERMISSION_INTERNAL_TOKEN`，只对审批与回报这 4 条内部路由有效，读不到会话历史与文件快照；它们连接的目标地址由服务端按实际监听地址注入 `PERMISSION_SERVER_HOST`（通配监听回落 `127.0.0.1`），因此绑定具体网卡地址或 `::1` 也能正常回报。如需缓解 DNS 重绑定可设置 `ALLOWED_HOSTS`（逗号分隔的 Host 白名单，只收紧不放行）。

反代部署要点：上游保持回环监听，代理侧关闭缓冲（`proxy_buffering off`）以支持 `/api/events` 的 SSE，并拉长 `proxy_read_timeout`；建议同时在代理层加一层认证，应用侧只有单令牌、无吊销手段。

注意：服务本身是明文 HTTP，令牌持有者可读取全部会话历史与 `chat-logs` 中的完整文件快照（`execution.before/after`）。公网或不可信网络请叠加 TLS 反向代理，或改用 VPN/SSH 隧道。详见 `docs/plans/2026-10-10-cross-device-access-token.md`。

## 测试

```bash
node test/test-access-gate.js
node test/test-file-diff-display.js
```
