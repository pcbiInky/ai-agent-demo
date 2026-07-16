# WebFetch 公网自动审批设计

## 背景

当前 `permission-server.js` 会把所有 MCP 工具请求发送到 `/api/permission-request`。服务端通过 `safe-command.js` 的 `shouldAutoAllowPermission()` 判断是否自动放行。该策略没有覆盖 `WebFetch`，因此 WebFetch 仍进入人工审批。

## 目标

对公网 HTTP/HTTPS WebFetch 请求自动审批，同时保留以下请求的人工审批：

- 非 HTTP/HTTPS 协议；
- 无效 URL 或包含用户名/密码的 URL；
- `localhost`、`.localhost`、`.local`、`.internal` 和 `.home.arpa` 主机名；
- 解析到环回、私网、链路本地、组播、文档保留地址或其他非公网地址的 IPv4/IPv6 主机。

`SendMessage` 和其他工具的既有审批行为不变。

## 方案

在 `safe-command.js` 增加异步 WebFetch 判定：

1. 使用 `URL` 解析并限定为 `http:` 或 `https:`；
2. 拒绝带用户信息和明确的本地保留主机名；
3. 对 IP 字面量直接判断是否为公网地址；
4. 对域名使用 DNS 解析，只有全部 A/AAAA 结果均为公网地址时才自动通过；DNS 失败或没有结果时不自动通过；
5. 保留现有同步 `shouldAutoAllowPermission()`，新增异步入口供 HTTP 权限端点调用，避免破坏现有调用者。

`server.js` 的权限端点改为异步等待判定结果。自动审批仍写入权限历史并发送前端已通过事件，因此用户仍能看到 WebFetch 操作记录，只是不需要点击允许。

## 安全边界

本次只改变审批策略，不把 WebFetch 变成通用网络沙箱。初始 URL 必须解析到公网地址；重定向链仍沿用当前 WebFetch 实现。后续若需要严格抵御 DNS rebinding 或公网 URL 重定向到内网，应单独把 WebFetch 下载器改为逐跳校验并固定已验证地址。

## 测试

- 公网 HTTPS 域名解析到公网 IPv4/IPv6 时自动通过；
- 私网、环回、链路本地、IPv4-mapped IPv6 和本地主机名不自动通过；
- 非 HTTP/HTTPS、无效 URL、带凭据 URL 不自动通过；
- DNS 失败或混合返回公网与私网地址时不自动通过；
- Read、Glob、Grep、Bash、Edit、Write、SendMessage 的现有策略保持不变；
- 权限端点回归测试确认自动通过仍写入审批记录和前端事件。
