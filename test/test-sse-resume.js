#!/usr/bin/env node
// SSE 按序号续订 + 一致快照的回归测试
// 覆盖：快照字段、显式 cursor=0 补发、cursor 取最大合法值、非法值过滤、
//       部分重放保序、journal 溢出 resync、临界衔接
process.env.PORT = "0"; // 系统分配的临时端口，避免并行 CI/本机占用冲突
const server = require("../server.js");
const PORT = server.serverInstance.address().port;

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

const { emitSSE, setActiveThinking, closeServer } = server.__test;
const http = require("http");

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "localhost", port: PORT, path }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function getRaw(path, headers = {}, ms = 400) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "localhost", port: PORT, path, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      setTimeout(() => { req.destroy(); resolve(buf); }, ms);
    });
    req.on("error", reject);
  });
}

(async () => {
  try {
    // 快照字段
    const hist0 = await getJSON("/api/history?sessionId=sse-seq-test");
    assert(hist0.lastSeq === 0, "新会话快照 lastSeq=0");
    assert(Array.isArray(hist0.activeThinking), "快照含 activeThinking 字段");

    // 产生 seq=1（thinking）
    setActiveThinking("sse-seq-test", "YYF", "m1");
    const hist1 = await getJSON("/api/history?sessionId=sse-seq-test");
    assert(hist1.lastSeq === 1, "产生事件后快照 lastSeq=1");
    assert(hist1.activeThinking.some((t) => t.character === "YYF" && t.messageId === "m1"), "快照 activeThinking 含执行中 invoke");

    // 显式 afterSeq=0 补发全部
    let raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=0");
    assert(raw.includes("id: 1") && raw.includes("event: thinking"), "显式 afterSeq=0 补发 seq=1");

    // 未提供 cursor 不补发
    raw = await getRaw("/api/events?sessionId=sse-seq-test");
    assert(!/id: \d+/.test(raw), "未提供 cursor 不补发");

    // cursor 取最大合法值（两个方向）
    emitSSE("sse-seq-test", "reply", { character: "YYF", replyId: "r1", text: "x" }); // 2
    emitSSE("sse-seq-test", "reply", { character: "YYF", replyId: "r2", text: "y" }); // 3
    emitSSE("sse-seq-test", "reply", { character: "YYF", replyId: "r3", text: "z" }); // 4
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=3", { "Last-Event-ID": "1" });
    assert(raw.includes("id: 4") && !raw.includes("id: 3") && !raw.includes("id: 2"), "header=1/query=3 取较大值只发 seq 4");
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=1", { "Last-Event-ID": "3" });
    assert(raw.includes("id: 4") && !raw.includes("id: 3"), "header=3/query=1 取较大值只发 seq 4");

    // 部分重放保序
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=1");
    assert(raw.indexOf("id: 2") > -1 && raw.indexOf("id: 3") > raw.indexOf("id: 2") && raw.indexOf("id: 4") > raw.indexOf("id: 3"), "部分重放按序");

    // 非法值过滤
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=2", { "Last-Event-ID": "-1" });
    assert(raw.includes("id: 3") && raw.includes("id: 4"), "负值 header 被过滤，按 query 补发");
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=abc", { "Last-Event-ID": "xyz" }, 300);
    assert(!/id: \d+/.test(raw), "双非法 cursor 不补发");

    // journal 溢出 resync；临界衔接不 resync
    for (let i = 0; i < 210; i++) emitSSE("sse-seq-test", "status", { character: "YYF", status: "online" });
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=5");
    assert(raw.includes("event: resync") && !/event: (thinking|reply)/.test(raw), "journal 溢出触发 resync 且不重放");
    raw = await getRaw("/api/events?sessionId=sse-seq-test&afterSeq=14");
    assert(!raw.includes("event: resync") && raw.includes("id: 15"), "after=oldest-1 临界衔接不重发 resync，从 oldest 补");
  } finally {
    closeServer();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
