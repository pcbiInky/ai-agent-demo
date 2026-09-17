#!/usr/bin/env node

/**
 * invokeQueues 生命周期回归测试
 * 覆盖三点：
 * 1. 队列空闲后 key 被回收（防慢性内存泄漏）
 * 2. 回收带身份校验：旧链完成时不得误删后来并发入队的新链
 * 3. rejected prev 不毒化后续链：rejected prev 在入队时被集中消化，
 *    随后立即入队的链照常执行、onResult 送达、无 unhandled rejection、key 回收
 *
 * 测试 1/2 通过 /api/chat（两次并发 @同一角色）在相同 key 上入队两条链，
 * 用可控 gate 挂起 stub invoke，精确观察回收时机。
 * 测试 3 直接驱动 __test.enqueueInvoke（需要向 invokeQueues 注入 rejected prev，
 * 经 /api/chat 无法构造这种历史毒化状态）。
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const dataDir = path.join(projectRoot, "role-system", "data");
const sessionsDir = path.join(dataDir, "sessions");
const logsDir = path.join(projectRoot, "chat-logs");

delete require.cache[require.resolve("../invoke")];
const invokeModule = require("../invoke");

let baseUrl = "";

// gate 队列：每个挂起的 stub invoke 占一个槽位，releaseNext() 放行最早的一条链
let gateQueue = [];
let gatingEnabled = false;

const originalInvoke = invokeModule.invoke;
invokeModule.invoke = async (_cli, _prompt, resumeSessionId, options = {}) => {
  if (gatingEnabled) {
    await new Promise((resolve) => gateQueue.push({ resolve, character: options.character }));
  }
  return {
    text: "",
    sessionId: resumeSessionId || `stub-${options.character || "unknown"}`,
  };
};

delete require.cache[require.resolve("../server")];
const server = require("../server");

// 全程监听 unhandledRejection：任何派生未处理 rejection 都会让断言失败
let unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

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

function writeSession(sessionId, memberIds) {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  const members = {};
  for (const roleId of memberIds) {
    members[roleId] = { providerSessionId: null };
  }
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, title: "test", members, workingDirectory: "" })
  );
}

function cleanupArtifacts(sessionId) {
  fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
  fs.rmSync(path.join(sessionsDir, `${sessionId}.json`), { force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
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

function queueHas(sessionId, roleName) {
  const roleId = server.__test.roleStore.getRoleByName(roleName)?.id || roleName;
  return server.__test.invokeQueues.has(`${sessionId}:${roleId}`);
}

function firstTwoRoles() {
  const list = server.__test.roleStore.listRoles();
  return { roleA: list[0], roleB: list[1] };
}

function resetGates() {
  gateQueue = [];
  gatingEnabled = false;
}

function releaseNextChain() {
  gateQueue.shift()?.resolve();
}

// ── 测试 1: 链空闲后 invokeQueues 回收 ──────────────────────
async function testQueueRecycledAfterIdle() {
  assert(typeof server.__test.invokeQueues?.has === "function", "server exposes invokeQueues for lifecycle tests");
  if (typeof server.__test.invokeQueues?.has !== "function") return;

  server.__test.ensureRoleSystemInitializedForTests();
  const { roleB } = firstTwoRoles();
  const sessionId = `recycle-${crypto.randomUUID()}`;

  writeSession(sessionId, [roleB.id]);

  gatingEnabled = true;
  const res = await postJson("/api/chat", { text: `@${roleB.name} 回收测试`, sessionId });
  assert(res.ok, "chat with mention is accepted");

  await waitFor(() => queueHas(sessionId, roleB.name), "chain enqueued");
  assert(queueHas(sessionId, roleB.name), "invokeQueues holds key while the chain runs");

  releaseNextChain();
  await waitFor(() => !queueHas(sessionId, roleB.name), "queue key recycled after idle");
  assert(!queueHas(sessionId, roleB.name), "invokeQueues key is deleted once the chain settles");

  resetGates();
  cleanupArtifacts(sessionId);
}

// ── 测试 2: 身份校验防止旧链误删新链 ──────────────────────
// 两条并发 /api/chat 在同一 key 上排队两条链；链 1 完成时，
// invokeQueues 必须仍保留该 key（新链在跑），链 2 完成后才回收。
async function testIdentityCheckKeepsNewerChain() {
  const { roleB } = firstTwoRoles();
  const sessionId = `identity-${crypto.randomUUID()}`;

  writeSession(sessionId, [roleB.id]);

  gatingEnabled = true;
  const res1 = await postJson("/api/chat", { text: `@${roleB.name} 身份校验：链 1`, sessionId });
  assert(res1.ok, "first chat accepted");

  await waitFor(() => queueHas(sessionId, roleB.name), "chain 1 enqueued");
  assert(queueHas(sessionId, roleB.name), "invokeQueues holds key while chain 1 runs");

  const res2 = await postJson("/api/chat", { text: `@${roleB.name} 身份校验：链 2`, sessionId });
  assert(res2.ok, "second chat accepted");

  // 等待链 1 真正挂到 gate（正在 invoke 中）；链 2 已在链 1 之后排队等待
  await waitFor(() => gateQueue.length >= 1, "chain 1 is gated inside invoke while chain 2 is queued");

  // 放行链 1：旧链的回收回调必须因身份校验跳过删除
  releaseNextChain();
  await sleep(150);
  assert(queueHas(sessionId, roleB.name), "older chain completion does not evict the queued newer chain");

  // 放行链 2：链真正空闲后回收
  releaseNextChain();
  await waitFor(() => !queueHas(sessionId, roleB.name), "queue key recycled after all chains settle");
  assert(!queueHas(sessionId, roleB.name), "key is recycled only after the newest chain completes");

  resetGates();
  cleanupArtifacts(sessionId);
}

// ── 测试 3: rejected prev 不毒化后续链 ──────────────────────
// 注入一条 rejected prev（模拟历史链意外拒绝遗留的毒化状态），
// 不等 key 回收、立即入队新链，验证：
// (a) 新链照常进入 invoke 并经 onResult 送达（不被 rejected prev 跳过）
// (b) 全程无派生 unhandled rejection
// (c) 链结束后队列 key 被正确回收
async function testRejectedPrevDoesNotPoisonNextChain() {
  const { roleB } = firstTwoRoles();
  const sessionId = `rejected-${crypto.randomUUID()}`;
  const key = `${sessionId}:${roleB.id}`;

  writeSession(sessionId, [roleB.id]);

  assert(typeof server.__test.enqueueInvoke === "function", "server exposes enqueueInvoke for rejected-prev tests");
  if (typeof server.__test.enqueueInvoke !== "function") return;

  unhandledRejections = [];

  // 注入 rejected prev；no-op catch 保证注入本身不产生 unhandled rejection
  const poisoned = Promise.reject(new Error("poisoned prev"));
  poisoned.catch(() => {});
  server.__test.invokeQueues.set(key, poisoned);

  // 不等 key 回收，立即入队新链：必须照常执行（prev 的 rejected 在入队时被集中消化）
  gatingEnabled = true;
  let healthyResult = null;
  let onErrorCalled = false;
  server.__test.enqueueInvoke(
    sessionId,
    "cli",
    "prompt",
    roleB.name,
    (result) => {
      healthyResult = result;
    },
    () => {
      onErrorCalled = true;
    },
    {}
  );

  await waitFor(() => gateQueue.length >= 1, "chain after rejected prev still reaches gated invoke");
  releaseNextChain();
  await waitFor(() => !server.__test.invokeQueues.has(key), "queue key recycled after chain settles");
  assert(!!healthyResult, "chain enqueued after a rejected prev still runs and delivers onResult");
  assert(!onErrorCalled, "chain after a rejected prev completes via onResult, not onError");

  // 留出事件循环时间，确认没有任何派生 rejection 未被处理
  await sleep(150);
  assert(unhandledRejections.length === 0, `no unhandled rejection around rejected prev handoff (got ${unhandledRejections.length})`);

  resetGates();
  cleanupArtifacts(sessionId);
}

async function main() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const address = tempServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testQueueRecycledAfterIdle();
    await testIdentityCheckKeepsNewerChain();
    await testRejectedPrevDoesNotPoisonNextChain();
  } finally {
    invokeModule.invoke = originalInvoke;
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
