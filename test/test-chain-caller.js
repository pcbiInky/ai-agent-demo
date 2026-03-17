#!/usr/bin/env node

/**
 * 链式回退回归测试
 * 目标链路：A(0) -> B(1) -> C(2) -> B(1) -> A(0)
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
let activeRoleNames = {};
let cReturnedToB = false;
let bReturnedToA = false;
let aSentFinalReply = false;

const originalInvoke = invokeModule.invoke;
invokeModule.invoke = async (_cli, _prompt, resumeSessionId, options = {}) => {
  const sessionId = activeSessionId;
  const character = options.character;
  const { roleA, roleB, roleC } = activeRoleNames;

  if (character === roleC && !cReturnedToB) {
    cReturnedToB = true;
    const requestId = `c-parent-${crypto.randomUUID()}`;
    server.__test.storeApproval(requestId, sessionId, character, "SendMessage", `anchor-${crypto.randomUUID()}`);
    const res = await postJson("/api/mcp-send-message", {
      requestId,
      text: "C 回给 B",
      atTargets: [],
    });
    if (!res.ok) {
      throw new Error(`C->B SendMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  } else if (character === roleB && cReturnedToB && !bReturnedToA) {
    bReturnedToA = true;
    const requestId = `b-parent-${crypto.randomUUID()}`;
    server.__test.storeApproval(requestId, sessionId, character, "SendMessage", `anchor-${crypto.randomUUID()}`);
    const res = await postJson("/api/mcp-send-message", {
      requestId,
      text: "B 回给 A",
      atTargets: [],
    });
    if (!res.ok) {
      throw new Error(`B->A SendMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  } else if (character === roleA && bReturnedToA && !aSentFinalReply) {
    aSentFinalReply = true;
    const requestId = `a-final-${crypto.randomUUID()}`;
    server.__test.storeApproval(requestId, sessionId, character, "SendMessage", `anchor-${crypto.randomUUID()}`);
    const res = await postJson("/api/mcp-send-message", {
      requestId,
      text: "A 回归主线",
      atTargets: [],
    });
    if (!res.ok) {
      throw new Error(`A mainline SendMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  return {
    text: "",
    sessionId: resumeSessionId || `stub-${character || "unknown"}`,
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

function findAssistantMessage(log, character, text) {
  return log.messages.find((msg) => msg.role === "assistant" && msg.character === character && msg.text === text);
}

function countAssistantMessages(log, character) {
  return log.messages.filter((msg) => msg.role === "assistant" && msg.character === character).length;
}

async function testNestedSummonReturnsToParentDepth() {
  assert(typeof server.__test.storeApproval === "function", "server exposes storeApproval helper for route-level SendMessage tests");
  if (typeof server.__test.storeApproval !== "function") return;

  server.__test.ensureRoleSystemInitializedForTests();
  const roles = server.__test.roleStore.listRoles();
  const roleA = roles[0];
  const roleB = roles[1];
  const roleC = roles[2];

  const sessionId = `session-${crypto.randomUUID()}`;
  const threadId = `thread-${crypto.randomUUID()}`;
  const requestId = `request-${crypto.randomUUID()}`;

  activeSessionId = sessionId;
  activeRoleNames = { roleA: roleA.name, roleB: roleB.name, roleC: roleC.name };
  cReturnedToB = false;
  bReturnedToA = false;
  aSentFinalReply = false;

  writeSession(sessionId, [roleA.id, roleB.id, roleC.id]);
  cleanupLog(sessionId);

  server.__test.invokeChainCallers.set(`${sessionId}:${roleB.name}`, {
    depth: 1,
    threadId,
    lineage: [roleA.name, roleB.name],
  });
  server.__test.storeApproval(requestId, sessionId, roleB.name, "SendMessage", `anchor-${crypto.randomUUID()}`);

  const res = await postJson("/api/mcp-send-message", {
    requestId,
    text: "B 首次回复",
    atTargets: [roleC.name],
  });
  assert(res.ok, "initial summoned SendMessage succeeds");

  const log = await waitFor(() => {
    try {
      const current = readLog(sessionId);
      const backToA = findAssistantMessage(current, roleA.name, "A 回归主线");
      return backToA ? current : null;
    } catch {
      return null;
    }
  }, "full nested return chain");

  const bFirstReply = findAssistantMessage(log, roleB.name, "B 首次回复");
  const cReply = findAssistantMessage(log, roleC.name, "C 回给 B");
  const bBackToA = findAssistantMessage(log, roleB.name, "B 回给 A");
  const aFinal = findAssistantMessage(log, roleA.name, "A 回归主线");

  assert(bFirstReply && bFirstReply.depth === 1, "B initial reply is depth=1");
  assert(Array.isArray(bFirstReply?.aiMentions) && bFirstReply.aiMentions.includes(roleC.name), "B depth=1 reply can summon C");
  assert(cReply && cReply.depth === 2, "C summoned reply is depth=2");
  assert(countAssistantMessages(log, roleC.name) === 1, "depth=2 node does not keep expanding children");
  assert(bBackToA && bBackToA.depth === 1, "return from C restores B at depth=1");
  assert(aFinal && !Object.prototype.hasOwnProperty.call(aFinal, "depth"), "final return restores A to depth=0");

  cleanupLog(sessionId);
  server.__test.invokeChainCallers.delete(`${sessionId}:${roleB.name}`);
}

function testPromptKeepsSummonAbilityBelowDepthTwo() {
  server.__test.ensureRoleSystemInitializedForTests();
  const roles = server.__test.roleStore.listRoles();
  const roleA = roles[0];
  const roleB = roles[1];
  const roleC = roles[2];
  const sessionId = `session-${crypto.randomUUID()}`;

  writeSession(sessionId, [roleA.id, roleB.id, roleC.id]);

  const depthOnePrompt = server.__test.buildContextPrompt(sessionId, "测试", roleB.name, {
    depth: 1,
    fromCharacter: roleA.name,
  });
  const depthTwoPrompt = server.__test.buildContextPrompt(sessionId, "测试", roleC.name, {
    depth: 2,
    fromCharacter: roleB.name,
  });

  assert(depthOnePrompt.includes("atTargets"), "depth=1 prompt still allows explicit summons");
  assert(depthTwoPrompt.includes("不要再次"), "depth=2 prompt tells AI not to summon further");
}

async function main() {
  const tempServer = await createTestServer();

  try {
    testPromptKeepsSummonAbilityBelowDepthTwo();
    await testNestedSummonReturnsToParentDepth();
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
