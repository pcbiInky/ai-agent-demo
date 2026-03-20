#!/usr/bin/env node

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

async function createTestServer() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  const address = tempServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return tempServer;
}

async function testPermissionRequestsPersistAndUpdateInHistory() {
  const sessionId = `permission-history-${crypto.randomUUID()}`;
  const requestId = `perm-${crypto.randomUUID()}`;

  cleanupLog(sessionId);

  const requestBody = {
    toolName: "Write",
    toolUseId: requestId,
    input: {
      file_path: "/tmp/demo.txt",
      content: "hello",
    },
    browserSessionId: sessionId,
    character: "YYF",
    timestamp: Date.now(),
  };

  const permissionRequestPromise = postJson("/api/permission-request", requestBody);

  try {
    const pendingEntry = await waitFor(() => {
      try {
        const log = readLog(sessionId);
        return log.messages.find((msg) => msg.role === "permission" && msg.requestId === requestId);
      } catch {
        return null;
      }
    }, "permission request to be persisted in chat log");

    assert(Boolean(pendingEntry), "permission request is written to chat log before approval");
    assert(pendingEntry && pendingEntry.status === "pending", "persisted permission starts in pending status");

    const allow = await postJson("/api/permission-response", {
      requestId,
      behavior: "allow",
    });
    assert(allow.ok, "permission response endpoint accepts approval for persisted request");

    const requestResult = await permissionRequestPromise;
    assert(requestResult.ok, "permission request resolves after approval");
    assert(requestResult.body && requestResult.body.behavior === "allow", "permission request returns allow after approval");

    const log = readLog(sessionId);
    const entries = log.messages.filter((msg) => msg.role === "permission" && msg.requestId === requestId);
    assert(entries.length === 1, "permission request keeps a single log entry after status update");
    assert(entries[0] && entries[0].status === "allow", "permission log entry is updated in place to allow");

    const history = await getJson(`/api/history?sessionId=${sessionId}`);
    const historyEntry = history.body?.messages?.find((msg) => msg.role === "permission" && msg.requestId === requestId);
    assert(Boolean(historyEntry), "history endpoint returns persisted permission entry");
    assert(historyEntry && historyEntry.status === "allow", "history endpoint returns updated permission status");
  } finally {
    try {
      await postJson("/api/permission-response", {
        requestId,
        behavior: "deny",
      });
    } catch {
      // ignore cleanup errors
    }

    try {
      await permissionRequestPromise;
    } catch {
      // ignore cleanup errors
    }

    cleanupLog(sessionId);
  }
}

async function main() {
  const tempServer = await createTestServer();

  try {
    await testPermissionRequestsPersistAndUpdateInHistory();
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
