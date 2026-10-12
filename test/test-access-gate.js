#!/usr/bin/env node
// 跨设备访问令牌门禁的回归测试
// 覆盖：回环判定、令牌来源与生成、令牌模式与监听地址解耦、内部令牌的路由限制、
//       Host 允许列表、内部回报链路连接实际监听地址，
//       以及"远端 → 本机反向代理 → 回环上游"必须仍要凭证（不得按 socket 来源放行）
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const express = require("express");

process.env.PORT = "0";

const {
  ACCESS_COOKIE,
  INTERNAL_HEADER,
  INTERNAL_ROUTES,
  isLoopbackAddress,
  isWildcardAddress,
  resolveInternalHost,
  resolveAccessToken,
  parseAllowedHosts,
  isHostAllowed,
  extractToken,
  tokensEqual,
  createAccessGate,
} = require("../lib/access-gate");
const { reportToolResult } = require("../lib/tool-result-reporter");
const server = require("../server");

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }
  console.error(`FAIL ${label}`);
  failed += 1;
}

function skip(label, reason) {
  console.log(`SKIP ${label}（${reason}）`);
  skipped += 1;
}

function listen(app, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const instance = http.createServer(app);
    instance.once("error", reject);
    instance.listen(0, host, () => resolve({ instance, port: instance.address().port, host: instance.address().address }));
  });
}

// 上游服务：门禁 + 回显路由（真实部署里就是 server.js 本身）
function listenUpstream(access, host) {
  const app = express();
  app.use(createAccessGate(access));
  app.use(express.json());
  app.use((req, res) => res.json({ ok: true, path: req.path }));
  return listen(app, host);
}

// 本机反向代理：把远端请求原样转发到回环上游，
// 上游看到的 socket 来源就是 127.0.0.1 —— 这正是不能按来源放行的原因
function listenProxy(upstreamPort) {
  return listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: upstreamPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      upstream.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
}

// 绑定到指定地址的回声服务：验证内部回报链路必须连"实际监听的地址"
function listenOn(host, onRequest) {
  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (onRequest) onRequest(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    instance.once("error", reject);
    instance.listen(0, host, () => resolve({ instance, port: instance.address().port }));
  });
}

function formatHostForUrl(host) {
  return String(host).includes(":") ? `[${host}]` : host;
}

// fetch 会丢弃 host 覆盖（Fetch 规范里的 forbidden header），
// 需要伪造 Host 头时必须用 http.request，否则断言会因为默认 Host 而"碰巧"通过
async function requestTo(targetHost, port, path, { method = "GET", headers = {} } = {}) {
  const res = await fetch(`http://${formatHostForUrl(targetHost)}:${port}${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, text, setCookie: res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")] };
}

function requestRaw(connectHost, port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: connectHost, port, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text, setCookie: [res.headers["set-cookie"]].flat().filter(Boolean) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function request(port, path, options = {}) {
  return requestTo("127.0.0.1", port, path, options);
}

function mockReq(overrides) {
  return { url: "/", path: "/", headers: {}, query: {}, ...overrides };
}

async function main() {
  // ── 回环地址判定 ──
  for (const addr of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1", "localhost"]) {
    assert(isLoopbackAddress(addr) === true, `回环地址 ${addr} 判定为真`);
  }
  for (const addr of ["192.168.1.50", "10.0.0.7", "0.0.0.0", "::ffff:192.168.1.50", "", undefined]) {
    assert(isLoopbackAddress(addr) === false, `非回环地址 ${String(addr)} 判定为假`);
  }

  // ── 令牌解析 ──
  const local = resolveAccessToken({ host: "127.0.0.1", envToken: "" });
  assert(local.enabled === false && local.token === "" && local.internalToken === "", "回环监听不启用门禁也不生成令牌");
  const generated = resolveAccessToken({ host: "0.0.0.0", envToken: undefined });
  assert(generated.enabled === true && generated.generated === true && generated.token.length >= 32, `非回环且未配置时生成随机访问令牌（长度 ${generated.token.length}）`);
  assert(generated.internalToken.length >= 32 && generated.internalToken !== generated.token, "内部令牌独立生成且不等于访问令牌");
  const configured = resolveAccessToken({ host: "192.168.1.5", envToken: " secret ", envInternalToken: "int " });
  assert(configured.token === "secret" && configured.internalToken === "int" && configured.generated === false, "显式 ACCESS_TOKEN / PERMISSION_INTERNAL_TOKEN 被采用并去除首尾空白");
  const blank = resolveAccessToken({ host: "::", envToken: "   " });
  assert(blank.generated === true && blank.token.length >= 32, "空白 ACCESS_TOKEN 视同未配置，仍生成随机令牌");

  // ── 令牌模式与监听地址解耦（本机 TLS 反代场景） ──
  const loopbackWithToken = resolveAccessToken({ host: "127.0.0.1", envToken: "proxy-secret" });
  assert(loopbackWithToken.enabled === true, "只监听 127.0.0.1 但显式配置 ACCESS_TOKEN 时同样启用门禁");
  assert(loopbackWithToken.token === "proxy-secret" && loopbackWithToken.generated === false, "回环监听下沿用显式配置的 ACCESS_TOKEN");
  assert(loopbackWithToken.hostExposed === false, "hostExposed 标记为假，启动日志据此说明是反代场景而非跨设备监听");
  assert(loopbackWithToken.internalToken.length >= 32, "回环 + 令牌模式同样生成内部令牌供 permission-server 使用");
  const loopbackWithInternal = resolveAccessToken({ host: "::1", envToken: "t", envInternalToken: " given " });
  assert(loopbackWithInternal.internalToken === "given", "回环 + 令牌模式沿用显式 PERMISSION_INTERNAL_TOKEN 并去空白");
  const loopbackBlankToken = resolveAccessToken({ host: "127.0.0.1", envToken: "   " });
  assert(loopbackBlankToken.enabled === false && loopbackBlankToken.token === "", "回环监听 + 空白 ACCESS_TOKEN 仍保持默认免令牌体验");
  const exposedNoToken = resolveAccessToken({ host: "192.168.1.5" });
  assert(exposedNoToken.enabled === true && exposedNoToken.hostExposed === true && exposedNoToken.generated === true, "绑定具体网卡地址时未配置令牌也强制启用并随机生成");

  // ── 内部回报链路的目标地址解析 ──
  for (const host of ["0.0.0.0", "::", "::0", "", undefined, "  "]) {
    assert(resolveInternalHost(host) === "127.0.0.1", `通配监听 ${String(host)} 的内部回报地址回落为 127.0.0.1`);
  }
  assert(isWildcardAddress("0.0.0.0") === true && isWildcardAddress("::") === true && isWildcardAddress("") === true, "通配地址判定为真");
  assert(isWildcardAddress("127.0.0.1") === false && isWildcardAddress("192.168.1.5") === false, "具体地址不判定为通配");
  assert(resolveInternalHost("192.168.1.5") === "192.168.1.5", "绑定具体网卡地址时内部回报走该地址");
  assert(resolveInternalHost("::1") === "::1", "绑定 ::1 时内部回报走 ::1 而不是 127.0.0.1");
  assert(resolveInternalHost(" localhost ") === "localhost", "HOST=localhost 时内部回报沿用该主机名");

  // ── Host 允许列表（DNS 重绑定防护） ──
  assert(parseAllowedHosts("A.example.com, 192.168.1.5:3000").join(",") === "a.example.com,192.168.1.5:3000", "ALLOWED_HOSTS 解析为小写列表");
  assert(parseAllowedHosts("").length === 0 && parseAllowedHosts(undefined).length === 0, "未配置时允许列表为空（不启用校验）");
  assert(isHostAllowed(mockReq({ headers: { host: "evil.example" } }), []) === true, "未配置允许列表时不校验 Host");
  assert(isHostAllowed(mockReq({ headers: { host: "OK.example:3000" } }), ["ok.example"]) === true, "允许列表按主机名匹配（忽略端口与大小写）");
  assert(isHostAllowed(mockReq({ headers: { host: "evil.example" } }), ["ok.example"]) === false, "不在允许列表的 Host 被拒");

  // ── 令牌来源优先级 ──
  const req = mockReq({
    url: "/api/history?token=fromQuery",
    headers: { "x-access-token": "fromHeader", cookie: `${ACCESS_COOKIE}=fromCookie` },
    query: { token: "fromQuery" },
  });
  assert(extractToken(req).token === "fromHeader" && extractToken(req).source === "header", "请求头优先于查询串与 Cookie");
  assert(extractToken(mockReq({ url: "/?token=fromQuery", headers: {} })).source === "query", "无请求头时取查询串");
  assert(extractToken(mockReq({ url: "/", headers: { cookie: `${ACCESS_COOKIE}=fromCookie; other=1` } })).token === "fromCookie", "无请求头与查询串时取 Cookie");
  assert(extractToken(mockReq({ url: "/", headers: {} })).token === "", "三处都没有则令牌为空");
  assert(tokensEqual("abc", "abc") === true && tokensEqual("abc", "abd") === false, "令牌相等性判定");
  assert(tokensEqual("", "abc") === false && tokensEqual("abc", "") === false && tokensEqual("short", "muchlonger") === false, "空值与长度不一致均判定不等");
  assert(INTERNAL_ROUTES.has("/api/tool-result") && !INTERNAL_ROUTES.has("/api/history"), "内部令牌只对固定路由生效");

  // ── 门禁中间件（真实 HTTP 请求） ──
  const token = "test-token-123";
  const internalToken = "internal-token-456";
  const enabled = { enabled: true, token, internalToken, generated: false, allowedHosts: [] };

  const direct = await listenUpstream(enabled);
  const noToken = await request(direct.port, "/api/sessions");
  assert(noToken.status === 401 && noToken.text.includes("需要访问令牌"), `无令牌被拒（${noToken.status}）`);
  const wrongToken = await request(direct.port, "/api/sessions", { headers: { "x-access-token": "nope" } });
  assert(wrongToken.status === 401, `错误令牌被拒（${wrongToken.status}）`);
  const headerOk = await request(direct.port, "/api/history", { headers: { "x-access-token": token } });
  assert(headerOk.status === 200 && headerOk.text.includes('"ok":true'), "请求头携带访问令牌放行");
  const queryOk = await request(direct.port, "/?token=" + token);
  assert(queryOk.status === 200, "查询串携带访问令牌放行");
  const setCookie = (queryOk.setCookie || []).filter(Boolean).join(";");
  assert(setCookie.includes(`${ACCESS_COOKIE}=${token}`) && /HttpOnly/i.test(setCookie), `查询串放行后写入 HttpOnly Cookie（${setCookie || "无"}）`);
  const cookieOk = await request(direct.port, "/api/events", { headers: { cookie: `${ACCESS_COOKIE}=${token}` } });
  assert(cookieOk.status === 200, "Cookie 携带访问令牌放行（静态资源与 SSE 同路径生效）");
  const pageDenied = await request(direct.port, "/index.html");
  assert(pageDenied.status === 401 && !pageDenied.text.trim().startsWith("{"), "非 /api 路径返回文本提示而非 JSON");

  // 内部令牌：只在内部路由有效，且读不到会话内容
  const internalOnHistory = await request(direct.port, "/api/history", { headers: { [INTERNAL_HEADER]: internalToken } });
  assert(internalOnHistory.status === 401, `内部令牌不能访问 /api/history（${internalOnHistory.status}）`);
  const internalOnSessions = await request(direct.port, "/api/sessions", { headers: { [INTERNAL_HEADER]: internalToken } });
  assert(internalOnSessions.status === 401, `内部令牌不能访问 /api/sessions（${internalOnSessions.status}）`);
  for (const route of ["/api/permission-request", "/api/permission-response", "/api/tool-result", "/api/mcp-send-message"]) {
    const ok = await request(direct.port, route, { method: "POST", headers: { [INTERNAL_HEADER]: internalToken } });
    assert(ok.status === 200, `内部令牌放行 ${route}`);
    const denied = await request(direct.port, route, { method: "POST", headers: { [INTERNAL_HEADER]: "wrong" } });
    assert(denied.status === 401, `错误内部令牌被拒 ${route}（${denied.status}）`);
  }
  const accessOnInternal = await request(direct.port, "/api/tool-result", { method: "POST", headers: { "x-access-token": token } });
  assert(accessOnInternal.status === 200, "访问令牌同样可用于内部路由（便于人工排查）");

  // Host 允许列表（用 http.request 才能真正改写 Host，fetch 会丢弃该头）
  const strict = await listenUpstream({ ...enabled, allowedHosts: ["arena.local"] });
  const badHost = await requestRaw("127.0.0.1", strict.port, "/api/sessions", { headers: { "x-access-token": token, host: "evil.example" } });
  assert(badHost.status === 403, `Host 不在允许列表时 403（${badHost.status}）`);
  const goodHost = await requestRaw("127.0.0.1", strict.port, "/api/sessions", { headers: { "x-access-token": token, host: "ARENA.local:3000" } });
  assert(goodHost.status === 200, `Host 在允许列表内（忽略大小写与端口）且令牌正确时放行（${goodHost.status}）`);
  const goodHostNoToken = await requestRaw("127.0.0.1", strict.port, "/api/sessions", { headers: { host: "arena.local" } });
  assert(goodHostNoToken.status === 401, `Host 合法但无令牌仍 401（${goodHostNoToken.status}）`);
  await new Promise((resolve) => strict.instance.close(resolve));
  await new Promise((resolve) => direct.instance.close(resolve));

  // ── 远端 → 本机反向代理 → 回环上游 ──
  const upstream = await listenUpstream(enabled);
  const proxy = await listenProxy(upstream.port);
  const proxiedNoToken = await request(proxy.port, "/api/history?sessionId=x");
  assert(proxiedNoToken.status === 401, `经代理转发到回环上游、无令牌仍被拒（${proxiedNoToken.status}）`);
  const proxiedSessions = await request(proxy.port, "/api/sessions");
  assert(proxiedSessions.status === 401, `经代理访问 /api/sessions 无令牌被拒（${proxiedSessions.status}）`);
  const proxiedEvents = await request(proxy.port, "/api/events", { headers: { accept: "text/event-stream" } });
  assert(proxiedEvents.status === 401, `经代理访问 /api/events 无令牌被拒（${proxiedEvents.status}）`);
  const proxiedPage = await request(proxy.port, "/index.html");
  assert(proxiedPage.status === 401, `经代理访问页面与静态资源无令牌被拒（${proxiedPage.status}）`);
  const proxiedInternalNoToken = await request(proxy.port, "/api/tool-result", { method: "POST" });
  assert(proxiedInternalNoToken.status === 401, `经代理访问内部路由无令牌同样被拒（${proxiedInternalNoToken.status}）`);
  const proxiedWithToken = await request(proxy.port, "/api/history?sessionId=x", { headers: { "x-access-token": token } });
  assert(proxiedWithToken.status === 200, `经代理携带访问令牌放行（${proxiedWithToken.status}）`);
  const proxiedWithInternal = await request(proxy.port, "/api/tool-result", { method: "POST", headers: { [INTERNAL_HEADER]: internalToken } });
  assert(proxiedWithInternal.status === 200, "经代理携带内部令牌放行内部路由");
  await new Promise((resolve) => proxy.instance.close(resolve));
  await new Promise((resolve) => upstream.instance.close(resolve));

  // ── 默认本机模式：门禁不启用，既有链路零成本 ──
  const disabled = await listenUpstream(resolveAccessToken({ host: "127.0.0.1", envToken: "" }));
  const disabledOk = await request(disabled.port, "/api/sessions");
  assert(disabledOk.status === 200, "回环监听模式下门禁不启用，本机请求直接放行");
  const disabledInternal = await request(disabled.port, "/api/tool-result", { method: "POST" });
  assert(disabledInternal.status === 200, "回环监听模式下内部路由无需内部令牌");
  await new Promise((resolve) => disabled.instance.close(resolve));

  // ── P1 回归：HOST=127.0.0.1 + ACCESS_TOKEN + 对外 TLS 反代 ──
  // 常见部署是"公网 TLS 代理 → 本机 127.0.0.1:3000"，上游监听地址仍是回环，
  // 门禁必须由 ACCESS_TOKEN 启用，否则远端无令牌即可读取会话历史
  const loopbackAccess = resolveAccessToken({ host: "127.0.0.1", envToken: "proxy-secret" });
  const loopbackUpstream = await listenUpstream(loopbackAccess);
  const loopbackProxy = await listenProxy(loopbackUpstream.port);
  for (const route of ["/api/history?sessionId=x", "/api/sessions", "/api/events", "/index.html", "/api/tool-result"]) {
    const denied = await request(loopbackProxy.port, route, route === "/api/tool-result" ? { method: "POST" } : {});
    assert(denied.status === 401, `回环上游 + 公网代理：无令牌访问 ${route} 被拒（${denied.status}）`);
  }
  const loopbackProxiedOk = await request(loopbackProxy.port, "/api/history?sessionId=x", { headers: { "x-access-token": "proxy-secret" } });
  assert(loopbackProxiedOk.status === 200, `回环上游 + 公网代理：携带 ACCESS_TOKEN 放行（${loopbackProxiedOk.status}）`);
  const loopbackInternalOnHistory = await request(loopbackProxy.port, "/api/history?sessionId=x", { headers: { [INTERNAL_HEADER]: loopbackAccess.internalToken } });
  assert(loopbackInternalOnHistory.status === 401, "回环上游 + 公网代理：内部令牌读不到会话历史");
  const loopbackInternalOk = await request(loopbackProxy.port, "/api/tool-result", { method: "POST", headers: { [INTERNAL_HEADER]: loopbackAccess.internalToken } });
  assert(loopbackInternalOk.status === 200, "回环上游 + 公网代理：内部令牌只放行回报路由");
  const loopbackDirectNoToken = await request(loopbackUpstream.port, "/api/sessions");
  assert(loopbackDirectNoToken.status === 401, "回环上游 + 显式令牌：本机直接访问同样需要令牌");
  await new Promise((resolve) => loopbackProxy.instance.close(resolve));
  await new Promise((resolve) => loopbackUpstream.instance.close(resolve));

  // ── P1 回归：ALLOWED_HOSTS 不得挡死内部回报链路 ──
  // 文档推荐反代部署配 ALLOWED_HOSTS=arena.example.com，但 permission-server 发往
  // 127.0.0.1:PORT（或具体网卡地址）的请求 Host 就是那个地址，不在白名单里；
  // 若 Host 校验排在内部令牌之前，审批、SendMessage 与执行结果回报会全部 403
  const allowAccess = resolveAccessToken({
    host: "127.0.0.1",
    envToken: "public-token",
    envInternalToken: "internal-token",
    allowedHosts: "arena.example.com",
  });
  assert(allowAccess.enabled === true && allowAccess.allowedHosts.join(",") === "arena.example.com", "回环 + 令牌 + ALLOWED_HOSTS 组合被正确解析");

  const allowUpstream = await listenUpstream(allowAccess);
  const allowProxy = await listenProxy(allowUpstream.port);
  const INTERNAL_ROUTE_LIST = ["/api/permission-request", "/api/permission-response", "/api/tool-result", "/api/mcp-send-message"];
  for (const route of INTERNAL_ROUTE_LIST) {
    const directInternal = await request(allowUpstream.port, route, { method: "POST", headers: { [INTERNAL_HEADER]: "internal-token" } });
    assert(directInternal.status === 200, `ALLOWED_HOSTS 开启时内部令牌直连回环 Host 仍放行 ${route}（${directInternal.status}）`);
    const proxiedInternal = await request(allowProxy.port, route, { method: "POST", headers: { [INTERNAL_HEADER]: "internal-token" } });
    assert(proxiedInternal.status === 200, `ALLOWED_HOSTS 开启时经反代的内部路由仍放行 ${route}（${proxiedInternal.status}）`);
    const wrongInternal = await request(allowUpstream.port, route, { method: "POST", headers: { [INTERNAL_HEADER]: "nope" } });
    assert(wrongInternal.status === 403, `内部令牌错误时仍按 Host 白名单拒绝 ${route}（${wrongInternal.status}）`);
  }
  const allowInternalOnHistory = await request(allowUpstream.port, "/api/history", { headers: { [INTERNAL_HEADER]: "internal-token" } });
  assert(allowInternalOnHistory.status === 403, `内部令牌不能越过 Host 白名单读历史（${allowInternalOnHistory.status}）`);
  const allowHistoryNoToken = await request(allowUpstream.port, "/api/history");
  assert(allowHistoryNoToken.status === 403, `白名单外 Host 无令牌访问历史 403（${allowHistoryNoToken.status}）`);
  const allowedHostPage = await requestRaw("127.0.0.1", allowUpstream.port, "/api/history", { headers: { "x-access-token": "public-token", host: "arena.example.com" } });
  assert(allowedHostPage.status === 200, `白名单内 Host + 访问令牌放行（${allowedHostPage.status}）`);
  const allowedHostInternal = await requestRaw("127.0.0.1", allowUpstream.port, "/api/tool-result", { method: "POST", headers: { [INTERNAL_HEADER]: "internal-token", host: "arena.example.com" } });
  assert(allowedHostInternal.status === 200, "白名单内 Host + 内部令牌同样放行内部路由");
  const evilHostWithToken = await requestRaw("127.0.0.1", allowUpstream.port, "/api/history", { headers: { "x-access-token": "public-token", host: "evil.example" } });
  assert(evilHostWithToken.status === 403, `白名单外 Host 即使令牌正确也 403（${evilHostWithToken.status}）`);
  const evilHostWithInternal = await requestRaw("127.0.0.1", allowUpstream.port, "/api/history", { headers: { [INTERNAL_HEADER]: "internal-token", host: "evil.example" } });
  assert(evilHostWithInternal.status === 403, "内部令牌只在内部路由上豁免 Host 白名单，历史接口不豁免");
  await new Promise((resolve) => allowProxy.instance.close(resolve));
  await new Promise((resolve) => allowUpstream.instance.close(resolve));

  // 具体网卡地址绑定 + ALLOWED_HOSTS：内部回报的 Host 是 <网卡地址>:<port>
  const nicForGate = Object.values(os.networkInterfaces())
    .flat()
    .find((info) => info && info.family === "IPv4" && !info.internal)?.address;
  if (!nicForGate) {
    skip("具体网卡地址 + ALLOWED_HOSTS 的内部路由回归", "本机没有可用的非回环 IPv4 地址");
  } else {
    const nicAccess = resolveAccessToken({ host: nicForGate, envToken: "nic-token", envInternalToken: "nic-internal", allowedHosts: "arena.example.com" });
    const nicUpstream = await listenUpstream(nicAccess, nicForGate);
    assert(nicUpstream.host === nicForGate, `上游确实绑定在具体网卡地址 ${nicForGate}（实际 ${nicUpstream.host}）`);
    const nicInternal = await requestTo(nicForGate, nicUpstream.port, "/api/tool-result", { method: "POST", headers: { [INTERNAL_HEADER]: "nic-internal" } });
    assert(nicInternal.status === 200, `绑定具体网卡地址时内部令牌放行 /api/tool-result（Host=${nicForGate}:${nicUpstream.port}，status=${nicInternal.status}）`);
    const nicSend = await requestTo(nicForGate, nicUpstream.port, "/api/mcp-send-message", { method: "POST", headers: { [INTERNAL_HEADER]: "nic-internal" } });
    assert(nicSend.status === 200, `绑定具体网卡地址时内部令牌放行 /api/mcp-send-message（${nicSend.status}）`);
    const nicHistory = await requestTo(nicForGate, nicUpstream.port, "/api/history", { headers: { [INTERNAL_HEADER]: "nic-internal" } });
    assert(nicHistory.status === 403, `绑定具体网卡地址时内部令牌读不到历史（${nicHistory.status}）`);
    const nicNoToken = await requestTo(nicForGate, nicUpstream.port, "/api/sessions");
    assert(nicNoToken.status === 403, `绑定具体网卡地址、白名单外 Host 无令牌 403（${nicNoToken.status}）`);
    const nicWithToken = await requestRaw(nicForGate, nicUpstream.port, "/api/sessions", { headers: { "x-access-token": "nic-token", host: "arena.example.com" } });
    assert(nicWithToken.status === 200, `绑定具体网卡地址时白名单内 Host + 访问令牌放行（${nicWithToken.status}）`);
    await new Promise((resolve) => nicUpstream.instance.close(resolve));
  }

  // ── P2 回归：内部回报必须连实际监听地址 ──
  const savedReportHost = process.env.PERMISSION_SERVER_HOST;
  try {
    // ::1 绑定：127.0.0.1 连不上，PERMISSION_SERVER_HOST=::1 时可达
    const seen = [];
    let v6Server = null;
    try {
      v6Server = await listenOn("::1", (req) => seen.push(req.url));
    } catch (err) {
      skip("::1 绑定回归", `本机不可用 IPv6 回环：${err.code || err.message}`);
    }
    if (v6Server) {
      process.env.PERMISSION_SERVER_HOST = "::1";
      const okStatus = await reportToolResult({ toolName: "Bash", ok: true }, { port: v6Server.port });
      assert(okStatus === 200, `绑定 ::1 时按 PERMISSION_SERVER_HOST 回报成功（status=${okStatus}）`);
      assert(seen.length === 1 && seen[0] === "/api/tool-result", `回报命中实际监听地址的 /api/tool-result（${JSON.stringify(seen)}）`);
      delete process.env.PERMISSION_SERVER_HOST;
      const fallbackStatus = await reportToolResult({ toolName: "Bash", ok: true }, { port: v6Server.port });
      assert(fallbackStatus === 0 && seen.length === 1, `仍写死 127.0.0.1 时绑定 ::1 的服务回报失败（status=${fallbackStatus}），说明该环境变量是必需的`);
      await new Promise((resolve) => v6Server.instance.close(resolve));
    }

    // 具体网卡地址绑定：同样只能经该地址回报
    const nicAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((info) => info && info.family === "IPv4" && !info.internal)?.address;
    if (!nicAddress) {
      skip("具体网卡地址绑定回归", "本机没有可用的非回环 IPv4 地址");
    } else {
      const seenNic = [];
      const nicServer = await listenOn(nicAddress, (req) => seenNic.push(req.url));
      process.env.PERMISSION_SERVER_HOST = resolveInternalHost(nicAddress);
      const nicStatus = await reportToolResult({ toolName: "Edit", ok: true }, { port: nicServer.port });
      assert(nicStatus === 200 && seenNic.length === 1, `绑定具体网卡地址 ${nicAddress} 时按解析出的地址回报成功（status=${nicStatus}）`);
      delete process.env.PERMISSION_SERVER_HOST;
      const nicFallback = await reportToolResult({ toolName: "Edit", ok: true }, { port: nicServer.port });
      assert(nicFallback === 0 && seenNic.length === 1, `绑定具体网卡地址时写死 127.0.0.1 回报失败（status=${nicFallback}）`);
      await new Promise((resolve) => nicServer.instance.close(resolve));
    }
  } finally {
    if (savedReportHost === undefined) delete process.env.PERMISSION_SERVER_HOST;
    else process.env.PERMISSION_SERVER_HOST = savedReportHost;
  }

  // 内部客户端不得再写死回环地址
  const permissionServerSource = fs.readFileSync(path.join(__dirname, "..", "permission-server.js"), "utf-8");
  const serverHostUses = (permissionServerSource.match(/hostname: SERVER_HOST/g) || []).length;
  assert(serverHostUses === 2, `permission-server.js 的两处回报都使用 SERVER_HOST（实际 ${serverHostUses}）`);
  assert(!/hostname: "127\.0\.0\.1"/.test(permissionServerSource), "permission-server.js 不再写死 hostname 127.0.0.1");
  const reporterSource = fs.readFileSync(path.join(__dirname, "..", "lib", "tool-result-reporter.js"), "utf-8");
  assert(/hostname: process\.env\.PERMISSION_SERVER_HOST \|\| "127\.0\.0\.1"/.test(reporterSource), "tool-result-reporter 按 PERMISSION_SERVER_HOST 回报，仅在未注入时回落回环");
  assert(process.env.PERMISSION_SERVER_HOST === resolveInternalHost(process.env.HOST ?? "127.0.0.1"), "server.js 启动时把实际监听地址写入 PERMISSION_SERVER_HOST 供子进程继承");

  // ── server.js 默认配置 ──
  assert(server.accessConfig?.enabled === false, "server.js 默认（HOST=127.0.0.1）不启用门禁");

  console.log(`\nResult: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  try {
    server.__test.closeServer();
  } catch {
    // ignore
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
