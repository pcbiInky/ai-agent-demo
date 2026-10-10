#!/usr/bin/env node
// 跨设备访问令牌门禁的回归测试
// 覆盖：回环判定、令牌来源与生成、内部令牌的路由限制、Host 允许列表，
//       以及"远端 → 本机反向代理 → 回环上游"必须仍要凭证（不得按 socket 来源放行）
const http = require("http");
const express = require("express");

process.env.PORT = "0";

const {
  ACCESS_COOKIE,
  INTERNAL_HEADER,
  INTERNAL_ROUTES,
  isLoopbackAddress,
  resolveAccessToken,
  parseAllowedHosts,
  isHostAllowed,
  extractToken,
  tokensEqual,
  createAccessGate,
} = require("../lib/access-gate");
const server = require("../server");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }
  console.error(`FAIL ${label}`);
  failed += 1;
}

function listen(app) {
  return new Promise((resolve) => {
    const instance = http.createServer(app);
    instance.listen(0, "127.0.0.1", () => resolve({ instance, port: instance.address().port }));
  });
}

// 上游服务：门禁 + 回显路由（真实部署里就是 server.js 本身）
function listenUpstream(access) {
  const app = express();
  app.use(createAccessGate(access));
  app.use(express.json());
  app.use((req, res) => res.json({ ok: true, path: req.path }));
  return listen(app);
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

async function request(port, path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const text = await res.text();
  return { status: res.status, text, setCookie: res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")] };
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

  // Host 允许列表
  const strict = await listenUpstream({ ...enabled, allowedHosts: ["arena.local"] });
  const badHost = await request(strict.port, "/api/sessions", { headers: { "x-access-token": token, host: "evil.example" } });
  assert(badHost.status === 403, `Host 不在允许列表时 403（${badHost.status}）`);
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

  // ── server.js 默认配置 ──
  assert(server.accessConfig?.enabled === false, "server.js 默认（HOST=127.0.0.1）不启用门禁");

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  try {
    server.__test.closeServer();
  } catch {
    // ignore
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
