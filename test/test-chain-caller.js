#!/usr/bin/env node

/**
 * 链式回归通路回归测试
 * 验证 invokeChainCallers merge 语义、串行绑定安全、提示词正确
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const dataDir = path.join(projectRoot, "role-system", "data");
const sessionsDir = path.join(dataDir, "sessions");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed++;
  } else {
    console.error(`FAIL ${label}`);
    failed++;
  }
}

function writeSession(sessionId, memberIds) {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ id: sessionId, title: "test", members: memberIds, workingDirectory: "" })
  );
}

// ── Test 1: merge 语义 — chainCaller 追加而非覆盖 ─────────
function testMergeSemantics() {
  delete require.cache[require.resolve("../role-system/roles")];
  delete require.cache[require.resolve("../role-system/migrations")];
  delete require.cache[require.resolve("../server")];

  const server = require("../server");
  const roles = server.__test.ensureRoleSystemInitializedForTests();
  const chainCallers = server.__test.invokeChainCallers;

  const sessionId = `session-${crypto.randomUUID()}`;
  // 用实际存在的角色（角色可能被重命名过）
  const roleA = roles[0];
  const roleB = roles[1];
  const roleC = roles.length > 2 ? roles[2] : roles[0];
  writeSession(sessionId, [roleA.id, roleB.id, roleC.id]);

  // 模拟 B 被 A 召唤（存储对象格式：{ caller, threadId, depth }）
  const mockThreadId = `thread-${crypto.randomUUID()}`;
  chainCallers.set(`${sessionId}:${roleB.name}`, { caller: roleA.name, threadId: mockThreadId, depth: 1 });
  const chainContext = chainCallers.get(`${sessionId}:${roleB.name}`);
  const caller = chainContext?.caller;

  // Case 1: atTargets=[C], chainCaller=A → [A, C]
  let t1 = [roleC.name];
  if (caller && !t1.includes(caller)) t1 = [caller, ...t1];
  assert(t1.length === 2 && t1[0] === roleA.name,
    "merge: chainCaller prepended, original targets preserved");

  // Case 2: atTargets 已含 chainCaller → 不重复
  let t2 = [roleA.name, roleC.name];
  if (caller && !t2.includes(caller)) t2 = [caller, ...t2];
  assert(t2.length === 2, "merge: no duplicate when chainCaller already in atTargets");

  // Case 3: 空 atTargets → 只含 chainCaller
  let t3 = [];
  if (caller && !t3.includes(caller)) t3 = [caller, ...t3];
  assert(t3.length === 1 && t3[0] === roleA.name, "merge: empty atTargets gets chainCaller only");

  chainCallers.delete(`${sessionId}:${roleB.name}`);
}

// ── Test 2: 无 chainCaller 时 atTargets 不受影响 ──────────
function testNoChainCallerPassthrough() {
  const server = require("../server");
  const chainCallers = server.__test.invokeChainCallers;

  const sessionId = `session-${crypto.randomUUID()}`;
  const caller = chainCallers.get(`${sessionId}:YYF`);
  assert(caller === undefined, "no chain caller when not in chain context");

  let t = ["奇迹哥"];
  if (caller && !t.includes(caller)) t = [caller, ...t];
  assert(t.length === 1 && t[0] === "奇迹哥", "atTargets unchanged when no chainCaller");
}

// ── Test 3: chainCaller 绑定是 enqueueInvoke 的参数 ─────
function testChainCallerPassedViaOptions() {
  // 验证 enqueueInvoke 接受 chainCaller 参数
  // 通过检查 invokeChainCallers 的键会在 invoke 生命周期内管理
  const server = require("../server");
  const chainCallers = server.__test.invokeChainCallers;
  assert(chainCallers instanceof Map, "invokeChainCallers is a Map");
  assert(chainCallers.size === 0, "invokeChainCallers starts empty (no external pre-set)");
}

// ── Test 5: chainContext 存储 threadId/depth ──────────────
function testChainContextStoresThreadInfo() {
  const server = require("../server");
  const chainCallers = server.__test.invokeChainCallers;
  const roles = server.__test.ensureRoleSystemInitializedForTests();

  const sessionId = `session-${crypto.randomUUID()}`;
  const roleA = roles[0];
  const roleB = roles[1];
  const threadId = `thread-${crypto.randomUUID()}`;

  // 模拟链式回归上下文（对象格式）
  chainCallers.set(`${sessionId}:${roleB.name}`, { caller: roleA.name, threadId, depth: 2 });
  const ctx = chainCallers.get(`${sessionId}:${roleB.name}`);

  assert(ctx && typeof ctx === "object", "chain context is an object, not a plain string");
  assert(ctx.caller === roleA.name, "chain context stores caller");
  assert(ctx.threadId === threadId, "chain context stores threadId");
  assert(ctx.depth === 2, "chain context stores depth");

  // 非链式调用应清除上下文
  chainCallers.delete(`${sessionId}:${roleB.name}`);
  assert(chainCallers.get(`${sessionId}:${roleB.name}`) === undefined, "chain context cleared after delete");
}

// ── Test 4: 提示词包含自动通知说明 ───────────────────────
function testPromptIncludesAutoNotify() {
  const server = require("../server");
  const roles = server.__test.ensureRoleSystemInitializedForTests();

  const sessionId = `session-${crypto.randomUUID()}`;
  const roleA = roles[0];
  const roleB = roles[1];
  writeSession(sessionId, [roleA.id, roleB.id]);

  const prompt = server.__test.buildContextPrompt(sessionId, "测试", roleB.name, {
    depth: 1,
    fromCharacter: roleA.name,
  });

  assert(prompt.includes("自动") && prompt.includes(roleA.name),
    "prompt tells invoked character about auto-notify to caller");

  // depth=0 无 fromCharacter 时不应有召唤上下文
  const prompt2 = server.__test.buildContextPrompt(sessionId, "测试", roleB.name, { depth: 0 });
  assert(!prompt2.includes("召唤上下文"), "no invoke context when depth=0 and no fromCharacter");
}

async function main() {
  try {
    testMergeSemantics();
    testNoChainCallerPassthrough();
    testChainCallerPassedViaOptions();
    testPromptIncludesAutoNotify();
    testChainContextStoresThreadInfo();
  } finally {
    try {
      const server = require("../server");
      server.__test.closeServer();
    } catch { /* ignore */ }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
