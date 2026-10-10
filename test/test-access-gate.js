#!/usr/bin/env node
// 跨设备访问令牌门禁的回归测试
// 覆盖：回环判定、令牌来源与生成、门禁中间件在真实 HTTP 请求下的放行/拒绝
const http = require("http");
const express = require("express");

process.env.PORT = "0";

const {
  ACCESS_COOKIE,
  isLoopbackAddress,
  resolveAccessToken,
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

function listenWithGate(access, remoteAddress) {
  const app = express();
  app.use(createAccessGate(access));
  app.use((req, res) => {
    res.json({ ok: true, path: req.path });
  });
  return new Promise((resolve) => {
    const instance = http.createServer((req, res) => {
      // 真实 socket 一定来自回环，这里改写来源地址以模拟跨设备请求
      if (remoteAddress) {
        Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress, configurable: true });
      }
      app(req, res);
    });
    instance.listen(0, "127.0.0.1", () => resolve({ instance, port: instance.address().port }));
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
  assert(local.enabled === false && local.token === "", "回环监听不启用门禁");
  const generated = resolveAccessToken({ host: "0.0.0.0", envToken: undefined });
  assert(generated.enabled === true && generated.generated === true && generated.token.length >= 32, `非回环且未配置时生成随机令牌（长度 ${generated.token.length}）`);
  const configured = resolveAccessToken({ host: "192.168.1.5", envToken: " secret " });
  assert(configured.enabled === true && configured.generated === false && configured.token === "secret", "显式 ACCESS_TOKEN 被采用并去除首尾空白");
  const blank = resolveAccessToken({ host: "::", envToken: "   " });
  assert(blank.generated === true && blank.token.length >= 32, "空白 ACCESS_TOKEN 视同未配置，仍生成随机令牌");

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

  // ── 门禁中间件（真实 HTTP 请求） ──
  const token = "test-token-123";
  const enabled = { enabled: true, token, generated: false };

  const remote = await listenWithGate(enabled, "192.168.1.50");
  const noToken = await request(remote.port, "/api/sessions");
  assert(noToken.status === 401 && noToken.text.includes("需要访问令牌"), `跨设备无令牌被拒（${noToken.status}）`);
  const wrongToken = await request(remote.port, "/api/sessions", { headers: { "x-access-token": "nope" } });
  assert(wrongToken.status === 401, `错误令牌被拒（${wrongToken.status}）`);
  const headerOk = await request(remote.port, "/api/history", { headers: { "x-access-token": token } });
  assert(headerOk.status === 200 && headerOk.text.includes('"ok":true'), "请求头携带令牌放行");
  const queryOk = await request(remote.port, "/?token=" + token);
  assert(queryOk.status === 200, "查询串携带令牌放行");
  const setCookie = (queryOk.setCookie || []).filter(Boolean).join(";");
  assert(setCookie.includes(`${ACCESS_COOKIE}=${token}`) && /HttpOnly/i.test(setCookie), `查询串放行后写入 HttpOnly Cookie（${setCookie || "无"}）`);
  const cookieOk = await request(remote.port, "/api/events", { headers: { cookie: `${ACCESS_COOKIE}=${token}` } });
  assert(cookieOk.status === 200, "Cookie 携带令牌放行（静态资源与 SSE 同路径生效）");
  const pageDenied = await request(remote.port, "/index.html");
  assert(pageDenied.status === 401 && !pageDenied.text.trim().startsWith("{"), "非 /api 路径返回文本提示而非 JSON");
  await new Promise((resolve) => remote.instance.close(resolve));

  const loopback = await listenWithGate(enabled, "127.0.0.1");
  const localOk = await request(loopback.port, "/api/sessions");
  assert(localOk.status === 200, "回环请求免令牌放行（本机使用方式不变）");
  await new Promise((resolve) => loopback.instance.close(resolve));

  const ipv6Local = await listenWithGate(enabled, "::ffff:127.0.0.1");
  const ipv6Ok = await request(ipv6Local.port, "/api/sessions");
  assert(ipv6Ok.status === 200, "IPv4-mapped 回环地址同样免令牌");
  await new Promise((resolve) => ipv6Local.instance.close(resolve));

  const disabled = await listenWithGate(resolveAccessToken({ host: "127.0.0.1", envToken: "" }), "192.168.1.50");
  const disabledOk = await request(disabled.port, "/api/sessions");
  assert(disabledOk.status === 200, "回环监听模式下门禁不启用");
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
