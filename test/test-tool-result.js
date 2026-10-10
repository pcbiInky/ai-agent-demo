#!/usr/bin/env node
// /api/tool-result 执行结果回报的回归测试
// 覆盖：关联校验（未注册/工具名不匹配/一次性消费）、execution 写回日志、
//       失败结果、oversized 结果、非编辑类工具不建立关联
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

process.env.PORT = "0";

const server = require("../server");

const projectRoot = path.join(__dirname, "..");
const logsDir = path.join(projectRoot, "chat-logs");

let baseUrl = "";
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

function logPath(sessionId) {
  return path.join(logsDir, `${sessionId}.json`);
}

function cleanupLog(sessionId) {
  fs.rmSync(logPath(sessionId), { force: true });
}

function readLog(sessionId) {
  return JSON.parse(fs.readFileSync(logPath(sessionId), "utf-8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function postJson(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function createTestServer() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const address = tempServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return tempServer;
}

// 发起权限请求并批准，返回批准后的 requestId
async function approveEditRequest(sessionId, { toolName = "Edit", input = { file_path: "/tmp/a.txt", old_string: "a", new_string: "b" } } = {}) {
  const requestId = `perm-${crypto.randomUUID()}`;
  const permissionRequestPromise = postJson("/api/permission-request", {
    toolName,
    toolUseId: requestId,
    input,
    browserSessionId: sessionId,
    character: "YYF",
    timestamp: Date.now(),
  });
  await waitFor(() => {
    try {
      const log = readLog(sessionId);
      return log.messages.find((msg) => msg.role === "permission" && msg.requestId === requestId);
    } catch {
      return null;
    }
  }, "permission entry persisted");
  const allow = await postJson("/api/permission-response", { requestId, behavior: "allow" });
  assert(allow.ok, `${toolName} 权限批准成功`);
  await permissionRequestPromise;
  return requestId;
}

function readExecution(sessionId, requestId) {
  const log = readLog(sessionId);
  const entry = log.messages.find((msg) => msg.role === "permission" && msg.requestId === requestId);
  return entry?.execution || null;
}

async function testSuccessResult() {
  const sessionId = `tool-result-${crypto.randomUUID()}`;
  cleanupLog(sessionId);
  try {
    const requestId = await approveEditRequest(sessionId);

    const unknown = await postJson("/api/tool-result", { requestId: "perm-not-exists", toolName: "Edit", ok: true });
    assert(unknown.status === 404, "未注册 requestId 回报返回 404");

    const mismatch = await postJson("/api/tool-result", { requestId, toolName: "Write", ok: true, filePath: "/tmp/a.txt", before: "a", after: "b" });
    assert(mismatch.status === 400, "工具名不匹配返回 400");
    assert(readExecution(sessionId, requestId) === null, "工具名不匹配时不写 execution");

    const noTool = await postJson("/api/tool-result", { requestId, ok: true, filePath: "/tmp/a.txt", before: "a", after: "b" });
    assert(noTool.status === 400, "缺少 toolName 返回 400");

    const badOk = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: "yes", filePath: "/tmp/a.txt" });
    assert(badOk.status === 400, "ok 非布尔值返回 400");

    const noSnapshot = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: true, filePath: "/tmp/a.txt" });
    assert(noSnapshot.status === 400, "成功结果缺快照字段返回 400");
    assert(readExecution(sessionId, requestId) === null, "校验失败时不消费关联、不写 execution");

    const nullAfter = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: true, filePath: "/tmp/a.txt", before: "a", after: null });
    assert(nullAfter.status === 400, "成功结果 after 为 null（读取失败伪装空快照）返回 400");
    assert(readExecution(sessionId, requestId) === null, "after:null 校验失败时不消费关联");

    const okRes = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: true, filePath: "/tmp/a.txt", before: "a", after: "b", changed: true, finishedAt: 123 });
    assert(okRes.ok, "成功结果回报返回 200");

    await waitFor(() => readExecution(sessionId, requestId), "execution written to log");
    const exec = readExecution(sessionId, requestId);
    assert(exec.status === "success" && exec.diffAvailable === true, "execution.status=success 且 diffAvailable");
    assert(exec.before === "a" && exec.after === "b", "before/after 快照写入日志");
    assert(exec.changed === true, "changed 标记写入日志");
    assert(typeof exec.seq === "number" && exec.seq > 0, "execution.seq 服务端单调序号写入");

    const dup = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: true, filePath: "/tmp/a.txt", before: "x", after: "y" });
    assert(dup.status === 404, "重复回报返回 404（一次性消费）");
    assert(readExecution(sessionId, requestId).before === "a", "重复回报不覆盖已写 execution");
  } finally {
    cleanupLog(sessionId);
  }
}

async function testDeniedRequestCannotReportSuccess() {
  const sessionId = `tool-result-${crypto.randomUUID()}`;
  cleanupLog(sessionId);
  try {
    const requestId = `perm-${crypto.randomUUID()}`;
    const permissionRequestPromise = postJson("/api/permission-request", {
      toolName: "Edit",
      toolUseId: requestId,
      input: { file_path: "/tmp/deny.txt", old_string: "a", new_string: "b" },
      browserSessionId: sessionId,
      character: "YYF",
      timestamp: Date.now(),
    });
    await waitFor(() => {
      try {
        const log = readLog(sessionId);
        return log.messages.find((msg) => msg.role === "permission" && msg.requestId === requestId);
      } catch {
        return null;
      }
    }, "permission entry persisted");

    await postJson("/api/permission-response", { requestId, behavior: "deny" });
    const denied = await permissionRequestPromise;
    assert(denied.body?.behavior === "deny", "权限被拒绝");

    const res = await postJson("/api/tool-result", { requestId, toolName: "Edit", ok: true, filePath: "/tmp/deny.txt", before: "a", after: "b", changed: true });
    assert(res.status === 404, "被拒绝的请求无法回报成功结果（关联仅在批准时注册）");
    assert(readExecution(sessionId, requestId) === null, "被拒绝的请求日志不写入 execution");
  } finally {
    cleanupLog(sessionId);
  }
}

async function testErrorAndOversizedResults() {
  const sessionId = `tool-result-${crypto.randomUUID()}`;
  cleanupLog(sessionId);
  try {
    const errRequestId = await approveEditRequest(sessionId, { input: { file_path: "/tmp/bad.txt", old_string: "x", new_string: "y" } });
    const errRes = await postJson("/api/tool-result", { requestId: errRequestId, toolName: "Edit", ok: false, error: "未找到要替换的文本", filePath: "/tmp/bad.txt", changed: false });
    assert(errRes.ok, "失败结果回报返回 200");
    await waitFor(() => readExecution(sessionId, errRequestId), "error execution written");
    const errExec = readExecution(sessionId, errRequestId);
    assert(errExec.status === "error" && errExec.error === "未找到要替换的文本", "execution.status=error 含错误信息");
    assert(errExec.diffAvailable === false && errExec.before === undefined, "失败结果不含快照");
    assert(errExec.changed === false, "失败结果 changed=false");

    const bigRequestId = await approveEditRequest(sessionId, { toolName: "Write", input: { file_path: "/tmp/big.txt", content: "..." } });
    const bigRes = await postJson("/api/tool-result", { requestId: bigRequestId, toolName: "Write", ok: true, filePath: "/tmp/big.txt", oversized: true, changed: false });
    assert(bigRes.ok, "oversized 结果回报返回 200");
    await waitFor(() => readExecution(sessionId, bigRequestId), "oversized execution written");
    const bigExec = readExecution(sessionId, bigRequestId);
    assert(bigExec.status === "success" && bigExec.oversized === true && bigExec.diffAvailable === false, "oversized 标记且 diffAvailable=false");
    assert(bigExec.before === undefined && bigExec.after === undefined, "oversized 不存快照内容");
    assert(bigExec.changed === false, "oversized 无变化操作 changed=false（前端不计入目录）");
    assert(typeof bigExec.seq === "number" && bigExec.seq > readExecution(sessionId, errRequestId).seq, "seq 随执行完成顺序单调递增");

    // hash 不可得（如仅可写文件）：snapshotError 回报无快照内容也不带 changed，不得 400
    const woRequestId = await approveEditRequest(sessionId, { toolName: "Write", input: { file_path: "/tmp/wo.txt", content: "..." } });
    const woRes = await postJson("/api/tool-result", { requestId: woRequestId, toolName: "Write", ok: true, filePath: "/tmp/wo.txt", snapshotError: true });
    assert(woRes.ok, "snapshotError 结果（无 before/after/changed）返回 200 不被 400 拒绝");
    await waitFor(() => readExecution(sessionId, woRequestId), "snapshotError execution written");
    const woExec = readExecution(sessionId, woRequestId);
    assert(woExec.status === "success" && woExec.snapshotError === true && woExec.diffAvailable === false, "snapshotError 标记且 diffAvailable=false");
    assert(woExec.changed === undefined, "hash 不可得时 changed 为未知（不写入 false）");
  } finally {
    cleanupLog(sessionId);
  }
}

async function testNonEditToolHasNoCorrelation() {
  const sessionId = `tool-result-${crypto.randomUUID()}`;
  cleanupLog(sessionId);
  try {
    const requestId = `perm-${crypto.randomUUID()}`;
    // Bash 属于非编辑类工具，无论自动通过还是人工批准都不建立结果关联
    const req = await postJson("/api/permission-request", {
      toolName: "Bash",
      toolUseId: requestId,
      input: { command: "rm -rf /tmp/never-exists-dir" },
      browserSessionId: sessionId,
      character: "YYF",
      timestamp: Date.now(),
    });
    assert(req.body?.behavior === "allow", "Bash 请求已完成（自动通过）");
    const res = await postJson("/api/tool-result", { requestId, toolName: "Bash", ok: true });
    assert(res.status === 404, "非编辑类工具未建立关联，回报返回 404");
  } finally {
    cleanupLog(sessionId);
  }
}

function testDefaultListenIsLoopbackOnly() {
  const address = server.serverInstance?.address();
  assert(typeof address === "object" && address?.address === "127.0.0.1",
    `默认监听回环地址（实际 ${typeof address === "object" ? address?.address : address}）`);
}

async function main() {
  const tempServer = await createTestServer();
  try {
    testDefaultListenIsLoopbackOnly();
    await testSuccessResult();
    await testDeniedRequestCannotReportSuccess();
    await testErrorAndOversizedResults();
    await testNonEditToolHasNoCorrelation();
  } catch (err) {
    console.error(err.stack || err.message || String(err));
    failed += 1;
  } finally {
    await new Promise((resolve) => tempServer.close(resolve));
    try {
      server.__test.closeServer();
    } catch {
      // ignore
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
