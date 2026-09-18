#!/usr/bin/env node
// Thinking 日志节流落盘回归测试：高频 delta 即时累积，但不会每个 token 全量重写会话文件。

process.env.PORT = "0";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const server = require("../server.js");

const {
  appendThinkingToLog,
  flushThinkingToLog,
  getThinkingLogKey,
  pendingThinkingLogs,
  closeServer,
} = server.__test;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed += 1;
  } else {
    console.log(`❌ ${label}`);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = `thinking-log-test-${process.pid}-${Date.now()}`;
const recordId = crypto.randomUUID();
const logPath = path.join(__dirname, "..", "chat-logs", `${sessionId}.json`);
const originalWriteFileSync = fs.writeFileSync;

function getHistory() {
  const port = server.serverInstance.address().port;
  return new Promise((resolve, reject) => {
    http.get({
      host: "localhost",
      port,
      path: `/api/history?sessionId=${encodeURIComponent(sessionId)}`,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on("error", reject);
  });
}

(async () => {
  let targetWrites = 0;
  let failNextTargetWrite = false;

  try {
    originalWriteFileSync(logPath, JSON.stringify({ sessionId, createdAt: Date.now(), messages: [] }, null, 2));

    fs.writeFileSync = function patchedWriteFileSync(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(logPath)) {
        targetWrites += 1;
        if (failNextTargetWrite) {
          failNextTargetWrite = false;
          throw new Error("simulated write failure");
        }
      }
      return originalWriteFileSync.call(this, filePath, ...args);
    };

    for (let i = 0; i < 100; i += 1) {
      appendThinkingToLog(sessionId, {
        id: recordId,
        character: "YYF",
        messageId: "message-1",
        text: "x",
        delta: true,
        timestamp: 1,
      });
    }

    const key = getThinkingLogKey(sessionId, recordId);
    assert(pendingThinkingLogs.get(key)?.text.length === 100, "100 个 token 先在内存中完整累积");
    assert(targetWrites === 0, "节流窗口内没有逐 token 写盘");

    await sleep(500);

    assert(targetWrites === 1, "首个节流窗口只全量写盘一次");
    let log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    let records = log.messages.filter((message) => message.id === recordId);
    assert(records.length === 1, "thinking 记录按 id 唯一聚合");
    assert(records[0]?.text === "x".repeat(100), "节流写盘内容完整");

    appendThinkingToLog(sessionId, {
      id: recordId,
      character: "YYF",
      messageId: "message-1",
      text: "第二段",
      delta: false,
      timestamp: 2,
    });
    flushThinkingToLog(key, { final: true });

    log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    records = log.messages.filter((message) => message.id === recordId);
    assert(targetWrites === 2, "finalize 强制刷新剩余内容");
    assert(records.length === 1, "finalize 后仍无重复 id 记录");
    assert(records[0]?.text === `${"x".repeat(100)}\n\n第二段`, "非 delta 内容保留段落分隔");
    assert(!pendingThinkingLogs.has(key), "finalize 成功后释放内存缓冲");

    const failedRecordId = crypto.randomUUID();
    const failedKey = getThinkingLogKey(sessionId, failedRecordId);
    appendThinkingToLog(sessionId, {
      id: failedRecordId,
      character: "YYF",
      messageId: "message-2",
      text: "需要重试",
      delta: true,
      timestamp: 3,
    });
    failNextTargetWrite = true;
    flushThinkingToLog(failedKey, { final: true });

    assert(pendingThinkingLogs.get(failedKey)?.dirty === true, "final 写盘失败时保留 dirty 缓冲");
    assert(pendingThinkingLogs.get(failedKey)?.finalRequested === true, "final 写盘失败时保留完成状态等待重试");

    await sleep(900);

    log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    records = log.messages.filter((message) => message.id === failedRecordId);
    assert(records.length === 1 && records[0].text === "需要重试", "final 写盘失败后自动重试成功");
    assert(!pendingThinkingLogs.has(failedKey), "重试成功后释放 final 缓冲");

    const historyRecordId = crypto.randomUUID();
    const historyKey = getThinkingLogKey(sessionId, historyRecordId);
    appendThinkingToLog(sessionId, {
      id: historyRecordId,
      character: "YYF",
      messageId: "message-3",
      text: "刷新前尚未到节流窗口",
      delta: true,
      timestamp: 4,
    });

    log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert(!log.messages.some((message) => message.id === historyRecordId), "history 请求前内容仍只在内存缓冲");
    const history = await getHistory();
    const historyRecord = history.messages.find((message) => message.id === historyRecordId);
    assert(historyRecord?.text === "刷新前尚未到节流窗口", "history 快照前同步刷新本会话 thinking");
    flushThinkingToLog(historyKey, { final: true });
    assert(!pendingThinkingLogs.has(historyKey), "history 刷新后的缓冲可正常 finalize");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    closeServer();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  fs.writeFileSync = originalWriteFileSync;
  try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  closeServer();
  console.error(err);
  process.exitCode = 1;
});
