#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

process.env.PORT = "0";

const server = require("../server");
const sessionStore = require("../role-system/sessions");

const projectRoot = path.join(__dirname, "..");
const logsDir = path.join(projectRoot, "chat-logs");
const sessionsDir = path.join(projectRoot, "role-system", "data", "sessions");

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

function writeLog(sessionId, messages) {
  fs.writeFileSync(
    path.join(logsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, createdAt: Date.now(), messages }, null, 2),
  );
}

function cleanup(sessionId) {
  fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
  fs.rmSync(path.join(sessionsDir, `${sessionId}.json`), { force: true });
}

async function getMemberNames(sessionId) {
  const res = await fetch(`${baseUrl}/api/sessions`);
  const data = await res.json();
  const summary = (data.sessions || []).find((s) => s.sessionId === sessionId);
  return summary ? summary.memberNames : null;
}

async function main() {
  const tempServer = http.createServer(server.app);
  await new Promise((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${tempServer.address().port}`;

  const sessionA = `members-a-${crypto.randomUUID()}`;
  const sessionB = `members-b-${crypto.randomUUID()}`;
  const sessionC = `members-c-${crypto.randomUUID()}`;
  const sessionD = `members-d-${crypto.randomUUID()}`;
  const someRole = server.__test.roleStore.listRoles({ includeArchived: true })[0];

  try {
    writeLog(sessionA, [
      { id: "1", role: "user", text: "@YYF 你好", mentions: ["YYF"], timestamp: 1 },
      { id: "2", role: "assistant", character: "YYF", text: "你好", timestamp: 2 },
    ]);
    writeLog(sessionB, [
      { id: "1", role: "user", text: "@奇迹哥 你好", mentions: ["奇迹哥"], timestamp: 1 },
      { id: "2", role: "assistant", character: "奇迹哥", text: "你好", timestamp: 2 },
      { id: "3", role: "assistant", character: "YYF", text: "补充", timestamp: 3 },
    ]);

    const membersA = await getMemberNames(sessionA);
    const membersB = await getMemberNames(sessionB);
    assert(Array.isArray(membersA) && membersA.length > 0, "session A returns a memberNames array");
    assert(membersA.includes("YYF") && !membersA.includes("奇迹哥"), "session A memberNames come from its own log");
    assert(membersB.includes("奇迹哥") && membersB.includes("YYF"), "session B memberNames include both speakers");
    assert(
      JSON.stringify(membersA) !== JSON.stringify(membersB),
      "sessions with different logs return different memberNames",
    );

    // 元数据成员与日志发言人取并集：链式唤醒但未登记的角色也能显示
    sessionStore.getOrCreateSession(sessionC, [someRole.id]);
    writeLog(sessionC, [
      { id: "1", role: "assistant", character: "日志角色X", text: "hi", timestamp: 1 },
    ]);
    const membersC = await getMemberNames(sessionC);
    assert(membersC.includes(someRole.name), "metadata member is included (union semantics)");
    assert(membersC.includes("日志角色X"), "log-only speaker is included (union semantics)");

    // 空会话返回空数组，不回退全局角色列表
    writeLog(sessionD, []);
    const membersD = await getMemberNames(sessionD);
    assert(Array.isArray(membersD) && membersD.length === 0, "empty session returns empty memberNames");
  } catch (err) {
    console.error(err.stack || err.message || String(err));
    failed += 1;
  } finally {
    cleanup(sessionA);
    cleanup(sessionB);
    cleanup(sessionC);
    cleanup(sessionD);
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
