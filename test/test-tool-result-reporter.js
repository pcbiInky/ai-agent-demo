#!/usr/bin/env node
// lib/tool-result-reporter.js 的回归测试
// 覆盖：hashFile 变化判定、classifySnapshot 回报形态分类（含 after 缺失/读取失败）、
//       reportToolResult 非 2xx 降级为 oversized 重试、无快照 payload 不重试、日志告警
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SNAPSHOT_TOTAL_MAX_BYTES,
  fileSizeOrNull,
  hashFile,
  classifySnapshot,
  reportToolResult,
} = require("../lib/tool-result-reporter");

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : null;
        requests.push(parsed);
        handler(res, parsed, requests.length);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, requests }));
  });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-test-"));
  const fileA = path.join(tmpDir, "a.txt");
  const fileB = path.join(tmpDir, "b.txt");

  try {
    // ── hashFile ──
    fs.writeFileSync(fileA, "hello");
    fs.writeFileSync(fileB, "hello");
    const snapA = await hashFile(fileA);
    const snapB = await hashFile(fileB);
    assert(snapA.status === "ok" && typeof snapA.hash === "string" && snapA.hash.length === 64, "hashFile 返回 {status:ok, hash:sha256}");
    assert(snapA.hash === snapB.hash, "相同内容 hash 相同");
    fs.writeFileSync(fileB, "hello2");
    assert(snapA.hash !== (await hashFile(fileB)).hash, "内容变化后 hash 不同");
    const missing = await hashFile(path.join(tmpDir, "missing.txt"));
    assert(missing.status === "missing" && missing.hash === null, "文件不存在 → status=missing（区别于读取失败）");
    assert((await hashFile(null)).status === "missing", "空路径 → status=missing");
    const dirSnap = await hashFile(tmpDir);
    assert(dirSnap.status === "error", `存在但不可读（目录）→ status=error（实际 ${dirSnap.status}）`);
    assert(fileSizeOrNull(fileA) === 5 && fileSizeOrNull(path.join(tmpDir, "x")) === null, "fileSizeOrNull 正常/缺失");
    assert(SNAPSHOT_TOTAL_MAX_BYTES === 80 * 1024, "快照总预算 80KB（低于 express.json 100KB 上限）");

    // ── 成功回报：单次请求，无重试 ──
    {
      const { srv, port, requests } = await startMockServer((res) => { res.writeHead(200); res.end("{}"); });
      const logs = [];
      const status = await reportToolResult(
        { requestId: "rq", toolName: "Edit", ok: true, filePath: "/a", before: "a", after: "b", changed: true },
        { port, log: (m) => logs.push(m) }
      );
      assert(status === 200 && requests.length === 1, "成功回报只发一次请求");
      assert(logs.length === 0, "成功回报无告警日志");
      await new Promise((r) => srv.close(r));
    }

    // ── 413：降级为 oversized 重试 ──
    {
      const { srv, port, requests } = await startMockServer((res, _p, n) => {
        res.writeHead(n === 1 ? 413 : 200);
        res.end("{}");
      });
      const logs = [];
      const status = await reportToolResult(
        { requestId: "rq", toolName: "Write", ok: true, filePath: "/big", before: "x".repeat(1000), after: "y".repeat(1000), changed: true },
        { port, log: (m) => logs.push(m) }
      );
      assert(status === 200, "413 后降级重试最终返回 200");
      assert(requests.length === 2, "共发送两次请求（原始 + 降级）");
      const fallback = requests[1];
      assert(fallback.oversized === true && fallback.before === undefined && fallback.after === undefined, "降级 payload 仅 oversized，无快照内容");
      assert(fallback.requestId === "rq" && fallback.ok === true && fallback.changed === true, "降级 payload 保留关键字段");
      assert(logs.some((m) => m.includes("降级")), "413 触发降级日志");
      await new Promise((r) => srv.close(r));
    }

    // ── 无快照 payload 被拒：不重试，仅告警 ──
    {
      const { srv, port, requests } = await startMockServer((res) => { res.writeHead(404); res.end("{}"); });
      const logs = [];
      const status = await reportToolResult(
        { requestId: "rq", toolName: "Edit", ok: false, error: "boom", filePath: "/a", changed: false },
        { port, log: (m) => logs.push(m) }
      );
      assert(status === 404 && requests.length === 1, "无快照 payload 被拒不重试");
      assert(logs.some((m) => m.includes("可观测性缺口")), "被拒时输出可观测性缺口告警");
      await new Promise((r) => srv.close(r));
    }

    // ── 网络失败：返回 0，不抛异常 ──
    {
      const logs = [];
      const status = await reportToolResult(
        { requestId: "rq", toolName: "Edit", ok: true, filePath: "/a", before: "a", after: "b" },
        { port: 1, log: (m) => logs.push(m) }
      );
      assert(status === 0, "网络失败返回 0");
      assert(logs.length > 0, "网络失败有告警日志");
    }
    // ── classifySnapshot：回报形态分类（含 after 缺失回归）──
    {
      const okSnap = (hash) => ({ status: "ok", hash });
      const missing = { status: "missing", hash: null };
      const err = { status: "error", hash: null };

      let r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: okSnap("h2"), beforeContent: "a", afterContent: "b", totalSize: 3 });
      assert(r.changed === true && r.before === "a" && r.after === "b" && !r.snapshotError && !r.oversized, "正常修改：有效快照 + changed=true");

      r = classifySnapshot({ beforeSnap: okSnap("h"), afterSnap: okSnap("h"), beforeContent: "a", afterContent: "a", totalSize: 2 });
      assert(r.changed === false && r.before === "a", "内容相同：changed=false 且仍带快照");

      r = classifySnapshot({ beforeSnap: missing, afterSnap: okSnap("h2"), beforeContent: null, afterContent: "b", totalSize: 1 });
      assert(r.changed === true && r.before === null && r.after === "b" && !r.snapshotError, "新文件：before 为 null，不算读取失败");

      r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: missing, beforeContent: "a", afterContent: null, totalSize: 1 });
      assert(r.snapshotError === true && r.before === undefined && r.after === undefined, "after 文件已不存在：snapshotError，不伪装成空文件");
      assert(r.changed === undefined, "after 文件已不存在：changed 未知");

      r = classifySnapshot({ beforeSnap: missing, afterSnap: missing, beforeContent: null, afterContent: null, totalSize: 0 });
      assert(r.snapshotError === true && r.changed === undefined && r.before === undefined, "before/after 均缺失（新建后即被删除）：snapshotError + changed 未知，不判成无变化");

      r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: okSnap("h2"), beforeContent: null, afterContent: "b", totalSize: 3 });
      assert(r.snapshotError === true && r.changed === true, "before 读取失败：snapshotError（changed 仍按 hash 判定）");

      r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: okSnap("h2"), beforeContent: "a", afterContent: null, totalSize: 3 });
      assert(r.snapshotError === true, "after 读取失败：snapshotError");

      r = classifySnapshot({ beforeSnap: err, afterSnap: err, beforeContent: null, afterContent: null, totalSize: 0 });
      assert(r.snapshotError === true && r.changed === undefined, "hash 失败：snapshotError 且 changed 未知");

      r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: okSnap("h2"), beforeContent: null, afterContent: null, totalSize: SNAPSHOT_TOTAL_MAX_BYTES + 1 });
      assert(r.oversized === true && !r.snapshotError && r.changed === true, "超过合计预算：oversized 而非 snapshotError");

      r = classifySnapshot({ beforeSnap: okSnap("h1"), afterSnap: missing, beforeContent: null, afterContent: null, totalSize: SNAPSHOT_TOTAL_MAX_BYTES + 1 });
      assert(r.snapshotError === true && !r.oversized, "超预算且 after 缺失：snapshotError 优先");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
