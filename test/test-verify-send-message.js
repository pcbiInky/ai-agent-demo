#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

process.env.PORT = "0";

const server = require("../server");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }

  console.log(`FAIL ${label}`);
  failed += 1;
}

function readLog(sessionId) {
  const logPath = path.join(__dirname, "..", "chat-logs", `${sessionId}.json`);
  return JSON.parse(fs.readFileSync(logPath, "utf-8"));
}

function cleanupLog(sessionId) {
  const logPath = path.join(__dirname, "..", "chat-logs", `${sessionId}.json`);
  fs.rmSync(logPath, { force: true });
}

async function main() {
  const { __test } = server;

  assert(typeof __test.extractVerifyMeta === "function", "server exposes extractVerifyMeta helper");
  assert(typeof __test.registerPendingMcpReply === "function", "server exposes registerPendingMcpReply helper");
  assert(typeof __test.finalizePendingMcpVerification === "function", "server exposes finalizePendingMcpVerification helper");
  assert(typeof __test.appendToLog === "function", "server exposes appendToLog helper");

  if (typeof __test.extractVerifyMeta === "function") {
    const parsed = __test.extractVerifyMeta("修复已完成\nVERIFY:7dac1f");
    assert(parsed.text === "修复已完成", "extractVerifyMeta strips trailing VERIFY line");
    assert(parsed.verified === true, "extractVerifyMeta marks inline verified reply");

    const untouched = __test.extractVerifyMeta("普通消息");
    assert(untouched.text === "普通消息", "extractVerifyMeta keeps normal text intact");
    assert(untouched.verified === undefined, "extractVerifyMeta leaves verified unset when suffix is absent");
  }

  if (
    typeof __test.registerPendingMcpReply === "function" &&
    typeof __test.finalizePendingMcpVerification === "function" &&
    typeof __test.appendToLog === "function"
  ) {
    const falseSessionId = `verify-send-${crypto.randomUUID()}`;
    const falseMessageId = crypto.randomUUID();

    try {
      __test.appendToLog(falseSessionId, {
        id: falseMessageId,
        role: "assistant",
        character: "YYF",
        text: "处理中",
        timestamp: Date.now(),
        source: "mcp-tool",
      });

      __test.registerPendingMcpReply(falseSessionId, "YYF", falseMessageId);
      __test.finalizePendingMcpVerification(falseSessionId, "YYF", false);

      const log = readLog(falseSessionId);
      const msg = log.messages.find((item) => item.id === falseMessageId);
      assert(Boolean(msg), "pending MCP reply is persisted in chat log");
      assert(msg && msg.verified === false, "finalizePendingMcpVerification writes final verified=false to chat log");
    } finally {
      cleanupLog(falseSessionId);
    }

    const inlineTrueSessionId = `verify-inline-${crypto.randomUUID()}`;
    const inlineTrueMessageId = crypto.randomUUID();

    try {
      __test.appendToLog(inlineTrueSessionId, {
        id: inlineTrueMessageId,
        role: "assistant",
        character: "YYF",
        text: "已完成",
        verified: true,
        timestamp: Date.now(),
        source: "mcp-tool",
      });

      __test.registerPendingMcpReply(inlineTrueSessionId, "YYF", inlineTrueMessageId);
      __test.finalizePendingMcpVerification(inlineTrueSessionId, "YYF", false);

      const log = readLog(inlineTrueSessionId);
      const msg = log.messages.find((item) => item.id === inlineTrueMessageId);
      assert(msg && msg.verified === true, "inline verified reply is not downgraded by later false verification");
    } finally {
      cleanupLog(inlineTrueSessionId);
    }
  }

  try {
    server.__test.closeServer();
  } catch {
    // ignore
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
