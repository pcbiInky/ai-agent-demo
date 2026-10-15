#!/usr/bin/env node

/**
 * WebSearch 审批 / 内部路由 / 真实 MCP stdio 集成测试
 *
 * 离线运行：provider（lib/deepseek-web-search.js 的 searchDeepSeekWeb）被打桩，
 * 不连接付费 API。覆盖：
 * 1. /api/web-search：未批准、错误工具、query 不匹配、重放均不访问上游；有效批准只触发一次请求
 * 2. 上游失败按错误码映射 HTTP 状态与 {ok:false,error:{code,message}}
 * 3. 真实 MCP SDK client 启动 permission-server，tools/call WebSearch 走通
 *    成功与 isError:true（拒绝 / 上游失败）路径
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const TEST_SESSION = "web-search-test-session";
const TEST_LOG = path.join(projectRoot, "chat-logs", `${TEST_SESSION}.json`);

// 打桩 provider：必须发生在 require server.js 之前，且 server 通过模块对象调用
const webSearchLib = require("../lib/deepseek-web-search");
const { WebSearchError } = webSearchLib;
const upstreamCalls = [];
let upstreamBehavior = async (query) => ({
  provider: "deepseek",
  query,
  model: "deepseek-v4-flash",
  sources: [{ title: "示例", url: "https://example.com/doc" }],
  truncated: false,
  elapsedMs: 3,
  usage: { inputTokens: 10, outputTokens: 5, webSearchRequests: 1 },
});
webSearchLib.searchDeepSeekWeb = async (query) => {
  upstreamCalls.push(query);
  return upstreamBehavior(query);
};

// 让默认凭据回落行为在 require server.js 时确定可见（保存现场，退出前恢复）
const savedApiKey = process.env.DEEPSEEK_API_KEY;
const savedCredFile = process.env.DEEPSEEK_SEARCH_CREDENTIALS_FILE;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_SEARCH_CREDENTIALS_FILE;

const server = require("../server");

// 默认搜索凭据回落：两者都未显式配置时指向 ~/.dsh/.credentials.yaml（仅文件存在时生效）
const DEFAULT_DSH_CREDENTIALS_FILE = path.join(os.homedir(), ".dsh", ".credentials.yaml");
const defaultCredApplied = process.env.DEEPSEEK_SEARCH_CREDENTIALS_FILE === DEFAULT_DSH_CREDENTIALS_FILE;
if (savedApiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedApiKey;
if (savedCredFile === undefined) {
  if (!defaultCredApplied) delete process.env.DEEPSEEK_SEARCH_CREDENTIALS_FILE;
} else {
  process.env.DEEPSEEK_SEARCH_CREDENTIALS_FILE = savedCredFile;
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}

let baseUrl = "";

function postJson(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function waitFor(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时: ${label}`);
}

// 走完整的 WebSearch 审批流（WebSearch 不自动放行，必然进入人工审批）
async function approveWebSearch(query, { behavior = "allow", requestId } = {}) {
  const rid = requestId || `perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pendingRequest = postJson("/api/permission-request", {
    toolName: "WebSearch",
    toolUseId: rid,
    input: { query },
    browserSessionId: TEST_SESSION,
    character: "测试员",
    timestamp: Date.now(),
  });
  await waitFor(() => server.__test.pendingPermissions.has(rid), `权限请求 ${rid} 进入 pending`);
  const decision = await postJson("/api/permission-response", { requestId: rid, behavior });
  const requestResult = await pendingRequest;
  return { rid, decision, requestResult };
}

async function testRoute() {
  console.log("\n=== /api/web-search 审批与执行路由 ===");

  // 默认凭据回落（在 require server.js 时判定）
  if (fs.existsSync(DEFAULT_DSH_CREDENTIALS_FILE)) {
    assert(defaultCredApplied, "未显式配置时默认回落到 ~/.dsh/.credentials.yaml");
  } else {
    assert(!defaultCredApplied, "dsh 凭据文件不存在时不设置默认回落");
  }

  upstreamCalls.length = 0;

  // 无效输入
  const invalid = await postJson("/api/web-search", { requestId: "", query: "q" });
  assert(invalid.status === 400 && invalid.body?.error?.code === "WEB_SEARCH_INVALID_INPUT", "缺 requestId 返回 400 INVALID_INPUT");
  const badQuery = await postJson("/api/web-search", { requestId: "r-x", query: "   " });
  assert(badQuery.status === 400 && badQuery.body?.error?.code === "WEB_SEARCH_INVALID_INPUT", "空 query 返回 400 INVALID_INPUT");

  // 未批准
  const noApproval = await postJson("/api/web-search", { requestId: "perm-nonexistent", query: "q" });
  assert(noApproval.status === 403 && noApproval.body?.error?.code === "WEB_SEARCH_APPROVAL_INVALID", "未批准的 requestId 返回 403 APPROVAL_INVALID");
  assert(upstreamCalls.length === 0, "未批准时不访问上游");

  // 错误工具的审批记录
  server.__test.storeApproval("perm-wrong-tool", TEST_SESSION, "测试员", "SendMessage", null);
  const wrongTool = await postJson("/api/web-search", { requestId: "perm-wrong-tool", query: "q" });
  assert(wrongTool.status === 403 && wrongTool.body?.error?.code === "WEB_SEARCH_APPROVAL_INVALID", "其他工具的审批记录被拒绝");
  assert(upstreamCalls.length === 0, "错误工具审批不访问上游");

  // 完整审批流 → 成功执行（trim 后的 query 与批准记录绑定）
  const approved = await approveWebSearch("  hello world  ");
  assert(approved.decision.status === 200, "审批响应 200");
  assert(approved.requestResult.body?.behavior === "allow", "permission-request 返回 allow");
  const okRes = await postJson("/api/web-search", { requestId: approved.rid, query: "hello world" });
  assert(okRes.status === 200 && okRes.body?.ok === true, "有效批准执行成功");
  assert(okRes.body?.result?.provider === "deepseek" && okRes.body.result.sources.length === 1, "返回结构化结果");
  assert(upstreamCalls.length === 1 && upstreamCalls[0] === "hello world", "上游只被调用一次且收到规范化 query");

  // 重放
  const replay = await postJson("/api/web-search", { requestId: approved.rid, query: "hello world" });
  assert(replay.status === 403 && replay.body?.error?.code === "WEB_SEARCH_APPROVAL_INVALID", "同一 requestId 重放被拒绝");
  assert(upstreamCalls.length === 1, "重放不触发新的上游请求");

  // query 不匹配：批准 A 实际搜 B
  const mismatchApproval = await approveWebSearch("query A");
  const mismatch = await postJson("/api/web-search", { requestId: mismatchApproval.rid, query: "query B" });
  assert(mismatch.status === 403 && mismatch.body?.error?.code === "WEB_SEARCH_APPROVAL_INVALID", "query 与批准记录不一致被拒绝");
  assert(upstreamCalls.length === 1, "query 不匹配不访问上游");
  const mismatchReplay = await postJson("/api/web-search", { requestId: mismatchApproval.rid, query: "query A" });
  assert(mismatchReplay.status === 403, "query 不匹配后原 requestId 也不允许重放");

  // 上游失败：错误码 → HTTP 状态映射
  const failApproval = await approveWebSearch("will timeout");
  upstreamBehavior = async () => { throw new WebSearchError("WEB_SEARCH_TIMEOUT", "搜索超时（60000ms）"); };
  const timeoutRes = await postJson("/api/web-search", { requestId: failApproval.rid, query: "will timeout" });
  assert(timeoutRes.status === 504 && timeoutRes.body?.error?.code === "WEB_SEARCH_TIMEOUT", "上游超时映射 504 + WEB_SEARCH_TIMEOUT");

  const missingCredApproval = await approveWebSearch("no credentials");
  upstreamBehavior = async () => { throw new WebSearchError("WEB_SEARCH_CREDENTIAL_MISSING", "未配置搜索凭据"); };
  const credRes = await postJson("/api/web-search", { requestId: missingCredApproval.rid, query: "no credentials" });
  assert(credRes.status === 500 && credRes.body?.error?.code === "WEB_SEARCH_CREDENTIAL_MISSING", "缺凭据映射 500 + CREDENTIAL_MISSING");

  const genericApproval = await approveWebSearch("generic failure");
  upstreamBehavior = async () => { throw new Error("unexpected"); };
  const genericRes = await postJson("/api/web-search", { requestId: genericApproval.rid, query: "generic failure" });
  assert(genericRes.status === 502 && genericRes.body?.error?.code === "WEB_SEARCH_UPSTREAM_ERROR", "未知异常归一为 502 + UPSTREAM_ERROR");
  upstreamBehavior = null;
}

// F1 回归：取消生命周期。provider 遵守 AbortSignal，不能用忽略 signal 的假实现
async function testDisconnectLifecycle() {
  console.log("\n=== 取消生命周期（正常请求不得误判断开 / 提前断开必须取消上游）===");

  // 正常 POST + 100ms 延迟、遵守 signal 的 provider：应返回 200 且不被取消
  let providerCancelled = false;
  webSearchLib.searchDeepSeekWeb = (query, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      providerCancelled = true;
      reject(new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", "调用方已取消本次搜索"));
    });
    setTimeout(() => resolve({
      provider: "deepseek",
      query,
      model: "deepseek-v4-flash",
      sources: [{ title: "延迟结果", url: "https://example.com/slow" }],
      truncated: false,
      elapsedMs: 100,
      usage: { webSearchRequests: 1 },
    }), 100);
  });

  const slowApproval = await approveWebSearch("slow query");
  const slowRes = await postJson("/api/web-search", { requestId: slowApproval.rid, query: "slow query" });
  assert(slowRes.status === 200 && slowRes.body?.ok === true && slowRes.body.result.sources[0].url === "https://example.com/slow", "正常 POST + 延迟 provider 返回 200");
  assert(providerCancelled === false, "正常等待响应期间不取消上游");

  // 客户端在上游等待期间提前断开：上游 signal 必须被取消
  const disconnectApproval = await approveWebSearch("disconnect query");
  let disconnectedCancelled = false;
  webSearchLib.searchDeepSeekWeb = (query, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      disconnectedCancelled = true;
      reject(new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", "调用方已取消本次搜索"));
    });
    // 永不主动完成，只能经由取消结束
  });

  await new Promise((resolve) => {
    const data = JSON.stringify({ requestId: disconnectApproval.rid, query: "disconnect query" });
    const req = http.request(`${baseUrl}/api/web-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, () => {});
    req.on("error", () => { /* 断开后客户端侧的 ECONNRESET 等忽略 */ });
    req.end(data);
    setTimeout(() => { req.destroy(); resolve(); }, 100);
  });
  try {
    await waitFor(() => disconnectedCancelled, "上游 signal 被取消", 5000);
  } catch { /* 落到下方断言 */ }
  assert(disconnectedCancelled === true, "客户端提前断开时上游 signal 确实被取消");
}

async function testMcpStdio() {
  console.log("\n=== 真实 MCP stdio: permission-server WebSearch ===");

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "permission-server.js")],
    env: {
      PERMISSION_SERVER_PORT: String(server.serverInstance.address().port),
      PERMISSION_SERVER_HOST: "127.0.0.1",
      PERMISSION_BROWSER_SESSION: TEST_SESSION,
      PERMISSION_CHARACTER: "测试员",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "web-search-test", version: "1.0.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "WebSearch"), "MCP 工具列表包含 WebSearch");

    // 成功路径：批准 + 打桩 provider 返回结构化结果
    webSearchLib.searchDeepSeekWeb = async (query) => {
      upstreamCalls.push(query);
      return {
        provider: "deepseek",
        query,
        model: "deepseek-v4-flash",
        sources: [{ title: "MCP 结果", url: "https://example.com/mcp" }],
        truncated: false,
        elapsedMs: 2,
        usage: { webSearchRequests: 1 },
      };
    };
    upstreamCalls.length = 0;

    const okCall = client.callTool({ name: "WebSearch", arguments: { query: " mcp 集成查询 " } });
    const okRid = await waitFor(() => {
      for (const [rid, pending] of server.__test.pendingPermissions) {
        if (pending.toolName === "WebSearch") return rid;
      }
      return null;
    }, "MCP WebSearch 权限请求");
    await postJson("/api/permission-response", { requestId: okRid, behavior: "allow" });
    const okResult = await okCall;
    assert(okResult.isError !== true, "MCP 成功路径不标记 isError");
    const okText = okResult.content?.[0]?.text || "";
    let parsed = null;
    try { parsed = JSON.parse(okText); } catch { /* ignore */ }
    assert(parsed && parsed.provider === "deepseek" && parsed.query === "mcp 集成查询", "MCP 成功路径返回结构化 JSON（query 已规范化）");
    assert(upstreamCalls.length === 1 && upstreamCalls[0] === "mcp 集成查询", "MCP 成功路径触发一次上游调用");

    // 拒绝路径
    const denyCall = client.callTool({ name: "WebSearch", arguments: { query: "deny me" } });
    const denyRid = await waitFor(() => {
      for (const [rid, pending] of server.__test.pendingPermissions) {
        if (pending.toolName === "WebSearch") return rid;
      }
      return null;
    }, "MCP WebSearch 第二次权限请求");
    await postJson("/api/permission-response", { requestId: denyRid, behavior: "deny" });
    const denyResult = await denyCall;
    assert(denyResult.isError === true, "拒绝路径返回 isError:true");
    assert(upstreamCalls.length === 1, "拒绝路径不访问上游");

    // 上游失败路径：批准后 provider 抛错 → isError:true 且错误码可见
    webSearchLib.searchDeepSeekWeb = async () => { throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", "上游服务不可用（HTTP 500）"); };
    const failCall = client.callTool({ name: "WebSearch", arguments: { query: "fail me" } });
    const failRid = await waitFor(() => {
      for (const [rid, pending] of server.__test.pendingPermissions) {
        if (pending.toolName === "WebSearch") return rid;
      }
      return null;
    }, "MCP WebSearch 第三次权限请求");
    await postJson("/api/permission-response", { requestId: failRid, behavior: "allow" });
    const failResult = await failCall;
    const failText = failResult.content?.[0]?.text || "";
    assert(failResult.isError === true && failText.includes("[WEB_SEARCH_UPSTREAM_ERROR]"), "上游失败路径 isError:true 且保留错误码");

    // 非法输入路径：不进入审批，直接 isError
    const invalidResult = await client.callTool({ name: "WebSearch", arguments: { query: "   " } });
    assert(invalidResult.isError === true && (invalidResult.content?.[0]?.text || "").includes("[WEB_SEARCH_INVALID_INPUT]"), "非法 query 直接返回 isError:true");
  } finally {
    await client.close();
  }
}

async function main() {
  // 绑定显式 HOST 时 listen 是异步的，等一次 listening 再取端口
  if (!server.serverInstance.address()) {
    await new Promise((resolve) => server.serverInstance.once("listening", resolve));
  }
  const address = server.serverInstance.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testRoute();
    await testDisconnectLifecycle();
    await testMcpStdio();
  } finally {
    try { fs.rmSync(TEST_LOG, { force: true }); } catch { /* ignore */ }
    try { server.__test.closeServer(); } catch { /* ignore */ }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  try { fs.rmSync(TEST_LOG, { force: true }); } catch { /* ignore */ }
  try { server.__test.closeServer(); } catch { /* ignore */ }
  process.exit(1);
});
