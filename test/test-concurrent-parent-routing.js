#!/usr/bin/env node

/**
 * 并发父节点路由回归测试
 * 场景：B -> C 与 A -> C 几乎同时发生，C 的两次回复都应各自绑定到正确父节点。
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const http = require("http");

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const dataDir = path.join(projectRoot, "role-system", "data");
const sessionsDir = path.join(dataDir, "sessions");
const logsDir = path.join(projectRoot, "chat-logs");

delete require.cache[require.resolve("../invoke")];
const invokeModule = require("../invoke");

let baseUrl = "";
let activeSessionId = "";
let activeNames = {};
let activeScenario = "";
let allowFirstCReply = false;
let cInvokeCount = 0;
let parentQueueInvokeCount = 0;

async function requestAndSendMessage(character, text, atTargets = []) {
  const requestId = `${character}-${crypto.randomUUID()}`;
  const perm = await postJson("/api/permission-request", {
    toolName: "SendMessage",
    toolUseId: requestId,
    input: { text },
    browserSessionId: activeSessionId,
    character,
    timestamp: Date.now(),
  });
  if (!perm.ok) {
    throw new Error(`permission request failed: ${perm.status} ${JSON.stringify(perm.body)}`);
  }

  const send = await postJson("/api/mcp-send-message", {
    requestId,
    text,
    atTargets,
  });
  if (!send.ok) {
    throw new Error(`SendMessage failed: ${send.status} ${JSON.stringify(send.body)}`);
  }

  return send;
}

const originalInvoke = invokeModule.invoke;
invokeModule.invoke = async (_cli, _prompt, resumeSessionId, options = {}) => {
  const { roleA, roleB, roleC } = activeNames;

  if (activeScenario === "same-child-concurrency" && options.character === roleC) {
    cInvokeCount += 1;
    const invokeIndex = cInvokeCount;

    if (invokeIndex === 1) {
      while (!allowFirstCReply) {
        await sleep(20);
      }
    }

    await requestAndSendMessage(roleC, invokeIndex === 1 ? "C 回复 B" : "C 回复 A");
  }

  if (activeScenario === "parent-return-queue") {
    if (options.character === roleA) {
      parentQueueInvokeCount += 1;
      if (parentQueueInvokeCount === 1) {
        await requestAndSendMessage(roleA, "A 收集 B 和 C 的意见", [roleB, roleC]);
      } else if (parentQueueInvokeCount === 2) {
        await requestAndSendMessage(roleA, "A 跟进 B");
      } else if (parentQueueInvokeCount === 3) {
        await requestAndSendMessage(roleA, "A 跟进 C");
      }
    } else if (options.character === roleB) {
      await requestAndSendMessage(roleB, "B 的意见");
    } else if (options.character === roleC) {
      await requestAndSendMessage(roleC, "C 的意见");
    }
  }

  return {
    text: "",
    sessionId: resumeSessionId || `stub-${options.character || "unknown"}`,
    verified: true,
  };
};

delete require.cache[require.resolve("../server")];
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

function readLog(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(logsDir, `${sessionId}.json`), "utf-8"));
}

function cleanupLog(sessionId) {
  fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
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

async function createTestServer() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const address = tempServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return tempServer;
}

async function testQueuedSameCharacterKeepsCorrectReplyTargets() {
  assert(typeof server.__test.storeApproval === "function", "server exposes storeApproval helper");
  if (typeof server.__test.storeApproval !== "function") return;

  server.__test.ensureRoleSystemInitializedForTests();
  const roles = server.__test.roleStore.listRoles();
  const roleA = roles[0];
  const roleB = roles[1];
  const roleC = roles[2];

  const sessionId = `session-${crypto.randomUUID()}`;
  const reqB = `b-${crypto.randomUUID()}`;
  const reqA = `a-${crypto.randomUUID()}`;

  activeSessionId = sessionId;
  activeNames = { roleA: roleA.name, roleB: roleB.name, roleC: roleC.name };
  activeScenario = "same-child-concurrency";
  allowFirstCReply = false;
  cInvokeCount = 0;

  writeSession(sessionId, [roleA.id, roleB.id, roleC.id]);
  cleanupLog(sessionId);

  server.__test.storeApproval(reqB, sessionId, roleB.name, "SendMessage", `anchor-${crypto.randomUUID()}`);
  const sendB = await postJson("/api/mcp-send-message", {
    requestId: reqB,
    text: "B 召唤 C",
    atTargets: [roleC.name],
  });
  assert(sendB.ok, "B root SendMessage succeeds");

  server.__test.storeApproval(reqA, sessionId, roleA.name, "SendMessage", `anchor-${crypto.randomUUID()}`);
  const sendA = await postJson("/api/mcp-send-message", {
    requestId: reqA,
    text: "A 召唤 C",
    atTargets: [roleC.name],
  });
  assert(sendA.ok, "A root SendMessage succeeds");

  allowFirstCReply = true;

  const log = await waitFor(() => {
    try {
      const current = readLog(sessionId);
      const cReplies = current.messages.filter((msg) => msg.role === "assistant" && msg.character === roleC.name);
      if (cReplies.length >= 2) return current;
      const cErrors = current.messages.filter((msg) => msg.role === "error" && msg.character === roleC.name);
      if (cErrors.length > 0) return current;
      return null;
    } catch {
      return null;
    }
  }, "two C replies or a C error");

  const bMsg = log.messages.find((msg) => msg.role === "assistant" && msg.character === roleB.name && msg.text === "B 召唤 C");
  const aMsg = log.messages.find((msg) => msg.role === "assistant" && msg.character === roleA.name && msg.text === "A 召唤 C");
  const cReplyB = log.messages.find((msg) => msg.role === "assistant" && msg.character === roleC.name && msg.text === "C 回复 B");
  const cReplyA = log.messages.find((msg) => msg.role === "assistant" && msg.character === roleC.name && msg.text === "C 回复 A");
  const cErrors = log.messages.filter((msg) => msg.role === "error" && msg.character === roleC.name);

  assert(cErrors.length === 0, "queued C invokes do not enter error state");
  assert(cReplyB && cReplyB.replyTo === bMsg?.id, "first C reply stays attached to B's message");
  assert(cReplyA && cReplyA.replyTo === aMsg?.id, "second C reply stays attached to A's message");

  cleanupLog(sessionId);
}

async function testParentReturnEventsTriggerParentTwiceInOrder() {
  assert(typeof server.__test.storeApproval === "function", "server exposes storeApproval helper");
  if (typeof server.__test.storeApproval !== "function") return;

  server.__test.ensureRoleSystemInitializedForTests();
  const roles = server.__test.roleStore.listRoles();
  const roleA = roles[0];
  const roleB = roles[1];
  const roleC = roles[2];

  const sessionId = `session-${crypto.randomUUID()}`;

  activeSessionId = sessionId;
  activeNames = { roleA: roleA.name, roleB: roleB.name, roleC: roleC.name };
  activeScenario = "parent-return-queue";
  parentQueueInvokeCount = 0;

  writeSession(sessionId, [roleA.id, roleB.id, roleC.id]);
  cleanupLog(sessionId);

  const start = await postJson("/api/chat", {
    sessionId,
    text: `@${roleA.name} 先收集 ${roleB.name} 和 ${roleC.name} 的意见，并在每个子角色回复后各自继续跟进`,
  });
  assert(start.ok, "user message triggers root A invoke");

  const log = await waitFor(() => {
    try {
      const current = readLog(sessionId);
      const parentReplies = current.messages.filter(
        (msg) => msg.role === "assistant" && msg.character === roleA.name && (msg.text === "A 跟进 B" || msg.text === "A 跟进 C")
      );
      if (parentReplies.length >= 2) return current;
      const parentErrors = current.messages.filter((msg) => msg.role === "error" && msg.character === roleA.name);
      if (parentErrors.length > 0) return current;
      return null;
    } catch {
      return null;
    }
  }, "two parent follow-ups or parent error");

  const bReply = log.messages.find(
    (msg) => msg.role === "assistant" && msg.character === roleB.name && msg.text === "B 的意见"
  );
  const cReply = log.messages.find(
    (msg) => msg.role === "assistant" && msg.character === roleC.name && msg.text === "C 的意见"
  );
  const parentReplies = log.messages.filter(
    (msg) => msg.role === "assistant" && msg.character === roleA.name && (msg.text === "A 跟进 B" || msg.text === "A 跟进 C")
  );
  const parentErrors = log.messages.filter((msg) => msg.role === "error" && msg.character === roleA.name);

  assert(parentErrors.length === 0, "parent follow-up queue does not protocol-violate");
  assert(parentReplies.length === 2, "parent is triggered twice");
  assert(parentReplies[0]?.replyTo === bReply?.id, "first parent follow-up binds to first child");
  assert(parentReplies[1]?.replyTo === cReply?.id, "second parent follow-up binds to second child");

  cleanupLog(sessionId);
}

async function main() {
  const tempServer = await createTestServer();

  try {
    await testQueuedSameCharacterKeepsCorrectReplyTargets();
    await testParentReturnEventsTriggerParentTwiceInOrder();
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
