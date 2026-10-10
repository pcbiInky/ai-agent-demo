# ai-agent-demo

## 启动

```bash
node server.js            # 默认 http://127.0.0.1:3000，仅本机可访问
PORT=8080 node server.js  # 换端口
```

## 跨设备访问

默认只监听回环地址，手机/其他电脑访问不到。需要跨设备时显式设置 `HOST`，此时页面、全部 `/api/*`（含会话列表、历史、SSE）与静态资源都由访问令牌保护，本机回环请求免令牌：

```bash
HOST=0.0.0.0 ACCESS_TOKEN=你的令牌 node server.js
```

启动日志会打印远程访问地址 `http://<本机IP>:PORT/?token=…`，用该链接打开即写入 Cookie，后续请求自动带令牌。未设置 `ACCESS_TOKEN` 时每次启动随机生成一个（重启后变化，需重新复制链接）。

注意：服务是明文 HTTP，令牌持有者可读取全部会话历史与 `chat-logs` 中的完整文件快照（`execution.before/after`）。公网或不可信网络请叠加 TLS 反向代理，或改用 VPN/SSH 隧道。详见 `docs/plans/2026-10-10-cross-device-access-token.md`。

## 测试

```bash
node test/test-access-gate.js
node test/test-file-diff-display.js
```
