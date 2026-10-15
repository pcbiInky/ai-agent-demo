#!/usr/bin/env node
// /api/abort-invoke 回归：终止必须对「正在执行 + 排队中」的 invoke 实例一并生效，
// 且排队期间的终止属正常终止——不产生 error 气泡（不写 error 日志/SSE）。
// 历史 bug：invokeAbortControllers 以 session:role 为 key 直接 set 覆盖，
// 同角色有排队 invoke 时，终止打到排队实例，正在跑的那个收不到。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

process.env.PORT = "0";

const projectRoot = path.join(__dirname, "..");
const sessionsDir = path.join(projectRoot, "role-system", "data", "sessions");
const logsDir = path.join(projectRoot, "chat-logs");

delete require.cache[require.resolve("../invoke")];
const invokeModule = require("../invoke");

// stub invoke：记录每次调用的 AbortSignal；被 gate 挂起；
// signal 终止时 resolve（与 invoke.js 真实行为一致：abort 后正常结算）
const seenSignals = [];
let gateQueue = [];
invokeModule.invoke = async (_cli, _prompt, resumeSessionId, options = {}) => {
  seenSignals.push(options.signal);
  await new Promise((resolve) => {
    const entry = { resolve, done: false };
    gateQueue.push(entry);
    options.signal?.addEventListener("abort", () => { entry.done = true; resolve(); }, { once: true });
  });
  return { text: "", sessionId: resumeSessionId || "stub-session" };
};
// 放行最早的未完成 gate（已 abort 的条目会留下陈旧 resolve，跳过）
function releaseNextGate() {
  const entry = gateQueue.find((e) => !e.done);
  if (entry) {
    entry.done = true;
    entry.resolve();
  }
}

delete require.cache[require.resolve("../server")];
const server = require("../server");

const unhandledRejections = [];
process.on("unhandledRejection", (reason) => unhandledRejections.push(reason));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeSession(sessionId, memberIds) {
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  const members = {};
  for (const roleId of memberIds) members[roleId] = { providerSessionId: null };
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, title: "test", members, workingDirectory: "" })
  );
}

function cleanupArtifacts(...sessionIds) {
  for (const sessionId of sessionIds) {
    fs.rmSync(path.join(logsDir, `${sessionId}.json`), { force: true });
    fs.rmSync(path.join(sessionsDir, `${sessionId}.json`), { force: true });
  }
}

function readLog(sessionId) {
  const file = path.join(logsDir, `${sessionId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).messages || [];
}

(async () => {
  const sessionId = `abort-${crypto.randomUUID()}`;
  const sessionId2 = `abort-ui-${crypto.randomUUID()}`;
  try {
    await waitFor(() => server.serverInstance.address()?.port, "server listening");
    const baseUrl = `http://127.0.0.1:${server.serverInstance.address().port}`;
    server.__test.ensureRoleSystemInitializedForTests();
    const role = server.__test.roleStore.listRoles()[0];
    assert(!!role, "角色系统已初始化");
    writeSession(sessionId, [role.id]);

    const postAbort = (sid) => fetch(`${baseUrl}/api/abort-invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserSessionId: sid, character: role.name }),
    }).then((r) => r.json());

    // ── A. 控制器语义：终止对执行中 + 排队中实例一并生效 ──
    const results = [];
    const errors = [];
    server.__test.enqueueInvoke(sessionId, role.cli, "任务一", role.name, (r) => results.push(r), (e) => errors.push(e));
    server.__test.enqueueInvoke(sessionId, role.cli, "任务二", role.name, (r) => results.push(r), (e) => errors.push(e));
    await waitFor(() => seenSignals.length === 1, "第一条 invoke 已启动");

    const body = await postAbort(sessionId);
    assert(body.aborted === true, "终止接口返回 aborted: true");

    await waitFor(() => errors.length === 1 && results.length === 1, "两条 invoke 都结算");
    assert(seenSignals[0].aborted === true, "执行中的 invoke 收到 AbortSignal 终止");
    assert(results.length === 1, "执行中的 invoke 按真实行为正常结算（resolve）");
    assert(seenSignals.length === 1, `排队实例在终止后出队不再启动 CLI（stub 调用 ${seenSignals.length} 次）`);
    assert(errors[0]?.invokeAborted === true && errors[0].message.includes("已被终止"), `排队实例以带标记的正常终止失败（实际：${errors[0]?.message}）`);

    const body2 = await postAbort(sessionId);
    assert(body2.aborted === false, "无活跃 invoke 时终止返回 aborted: false");

    // 终止后新入队的 invoke 正常工作（控制器 Set 已清空重建）
    server.__test.enqueueInvoke(sessionId, role.cli, "任务三", role.name, (r) => results.push(r), (e) => errors.push(e));
    await waitFor(() => seenSignals.length === 2, "终止后可再次入队执行");
    assert(seenSignals[1].aborted === false, "新 invoke 的 AbortSignal 未被污染");
    releaseNextGate();
    await waitFor(() => results.length === 2, "新 invoke 正常完成");

    const key = `${sessionId}:${role.id}`;
    await waitFor(() => !server.__test.invokeQueues.has(key), "invoke queue recycled");
    assert(!server.__test.invokeQueues.has(key), "invokeQueues 空闲后回收");

    // ── B. 端到端（/api/chat）：排队终止不产生 error 气泡 ──
    writeSession(sessionId2, [role.id]);
    await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `@${role.name} 任务一`, sessionId: sessionId2 }),
    });
    await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `@${role.name} 任务二`, sessionId: sessionId2 }),
    });
    await waitFor(() => seenSignals.length === 3, "第二条会话的第一条 invoke 已启动");
    const body3 = await postAbort(sessionId2);
    assert(body3.aborted === true, "端到端终止返回 aborted: true");

    const key2 = `${sessionId2}:${role.id}`;
    await waitFor(() => !server.__test.invokeQueues.has(key2), "第二条会话队列结算");
    // 等日志落盘
    await sleep(200);
    const log2 = readLog(sessionId2);
    const errorEntries = log2.filter((m) => m.role === "error");
    // stub 未走 MCP SendMessage 会产生协议违规 error（与本项无关的测试噪音），
    // 本断言只关心排队终止不得产生 error 气泡
    const abortErrors = errorEntries.filter((m) => String(m.error || "").includes("已被终止"));
    assert(abortErrors.length === 0, `排队终止不产生 error 气泡（实际 ${abortErrors.length} 条；全部 error 条目：${errorEntries.map((m) => m.error).join("; ") || "无"}）`);

    assert(unhandledRejections.length === 0, `无未处理 rejection（实际 ${unhandledRejections.length}）`);
  } catch (err) {
    console.error("测试异常:", err);
    failed += 1;
  } finally {
    gateQueue = [];
    cleanupArtifacts(sessionId, sessionId2);
    try { server.__test.closeServer(); } catch { /* ignore */ }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
