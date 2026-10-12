#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

process.env.PORT = "0";

const server = require("../server");

const logsDir = path.join(__dirname, "..", "chat-logs");

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

function cleanupLog(sessionId) {
  fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await check();
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

async function getJson(route) {
  const res = await fetch(`${baseUrl}${route}`);
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function requestPermission(sessionId, requestId, character = "YYF") {
  return postJson("/api/permission-request", {
    toolName: "Write",
    toolUseId: requestId,
    input: { file_path: "/tmp/float-demo.txt", content: "hello" },
    browserSessionId: sessionId,
    character,
    timestamp: Date.now(),
  });
}

async function createTestServer() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${tempServer.address().port}`;
  return tempServer;
}

async function testPendingSnapshot() {
  const sessionId = `float-snapshot-${crypto.randomUUID()}`;
  const requestId = `perm-${crypto.randomUUID()}`;
  cleanupLog(sessionId);

  const pending = requestPermission(sessionId, requestId);
  try {
    const snapshot = await waitFor(async () => {
      const snap = await getJson(`/api/pending-permissions?sessionId=${sessionId}`);
      return snap.body?.pending?.some((p) => p.requestId === requestId) ? snap : null;
    }, "pending snapshot");
    const item = snapshot.body?.pending?.find((p) => p.requestId === requestId);
    assert(Boolean(item), "待审批快照包含手动审批请求");
    assert(item?.status === "pending", "快照项状态为 pending");
    assert(item?.toolName === "Write" && item?.input?.file_path === "/tmp/float-demo.txt", "快照携带工具与输入详情");

    const history = await getJson(`/api/history?sessionId=${sessionId}`);
    assert(
      Array.isArray(history.body?.pendingApprovals) &&
        history.body.pendingApprovals.some((p) => p.requestId === requestId),
      "/api/history 返回 pendingApprovals 快照"
    );

    await postJson("/api/permission-response", { requestId, behavior: "allow" });
    const after = await getJson(`/api/pending-permissions?sessionId=${sessionId}`);
    assert(
      !after.body?.pending?.some((p) => p.requestId === requestId),
      "审批后快照移除该请求"
    );
  } finally {
    await postJson("/api/permission-response", { requestId, behavior: "deny" }).catch(() => {});
    await Promise.race([pending, sleep(2000)]);
    cleanupLog(sessionId);
  }
}

async function testRegisteredBeforeSSE() {
  const sessionId = `float-order-${crypto.randomUUID()}`;
  const requestId = `perm-${crypto.randomUUID()}`;
  cleanupLog(sessionId);

  // 原始 HTTP 消费 SSE（afterSeq=0 走 journal 补发，避免建连晚于推送的时序问题）：
  // 收到 permission 事件后立即查快照，验证"登记 pending 先于 SSE 推送"，
  // 否则双入口会偶发 404
  let snapshotAtEvent = null;
  const seen = new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events?sessionId=${sessionId}&afterSeq=0`, (res) => {
      let buf = "";
      res.on("data", async (chunk) => {
        buf += chunk;
        if (!buf.includes(`"requestId":"${requestId}"`) || snapshotAtEvent !== null) return;
        snapshotAtEvent = await getJson(`/api/pending-permissions?sessionId=${sessionId}`);
        req.destroy();
        resolve();
      });
    });
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
  });

  const pending = requestPermission(sessionId, requestId);
  try {
    await Promise.race([seen, sleep(3000).then(() => { throw new Error("未收到 permission 事件"); })]);
    assert(
      snapshotAtEvent?.body?.pending?.some((p) => p.requestId === requestId),
      "SSE permission 事件到达时请求已登记进快照"
    );
  } finally {
    await postJson("/api/permission-response", { requestId, behavior: "deny" }).catch(() => {});
    await Promise.race([pending, sleep(2000)]);
    cleanupLog(sessionId);
  }
}

async function testBehaviorValidationAndDoubleResponse() {
  const sessionId = `float-double-${crypto.randomUUID()}`;
  const requestId = `perm-${crypto.randomUUID()}`;
  cleanupLog(sessionId);

  const pending = requestPermission(sessionId, requestId);
  try {
    await sleep(50);

    const invalid = await postJson("/api/permission-response", { requestId, behavior: "maybe" });
    assert(invalid.status === 400, "非法 behavior 返回 400");

    const first = await postJson("/api/permission-response", { requestId, behavior: "allow" });
    assert(first.ok, "首次审批成功");

    const second = await postJson("/api/permission-response", { requestId, behavior: "deny" });
    assert(second.status === 404, "重复审批返回 404");
    assert(
      second.body?.resolved?.behavior === "allow",
      "404 携带首次决策结果（前端据此收敛，不作为可重试待审批）"
    );
  } finally {
    await postJson("/api/permission-response", { requestId, behavior: "deny" }).catch(() => {});
    await Promise.race([pending, sleep(2000)]);
    cleanupLog(sessionId);
  }
}

async function main() {
  const tempServer = await createTestServer();
  try {
    await testPendingSnapshot();
    await testRegisteredBeforeSSE();
    await testBehaviorValidationAndDoubleResponse();
  } finally {
    tempServer.close();
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
