#!/usr/bin/env node
// lib/process-tree.js 回归测试（真实进程）
// 覆盖：子孙枚举、进程树终止（含另起独立进程组的孙进程，模拟 codex 行为）、
//       runCommandTree 成功/失败/超时整树回收
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listDescendantPids,
  killProcessTree,
  killActiveCommandTrees,
  runCommandTree,
} = require("../lib/process-tree");

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`✅ ${label}`); passed += 1; }
  else { console.log(`❌ ${label}`); failed += 1; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

// 等待 pid 退出（被杀后 wait 回收需要时间）
async function waitDead(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-tree-test-"));
const pidFile = path.join(tmpDir, "grandchild.pid");

// 父进程：spawn 一个 detached sleep 孙进程（模拟 codex 把命令放进独立进程组），
// 把孙进程 pid 写到文件，然后自己常驻
const SPAWNER_SCRIPT = `
const { spawn } = require("child_process");
const fs = require("fs");
const grandchild = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
fs.writeFileSync(process.env.PID_FILE, String(grandchild.pid));
grandchild.unref();
setTimeout(() => {}, 600000);
`;

(async () => {
  const cleanupPids = [];
  try {
    // ── 1. 子孙枚举 + 进程树终止（含独立进程组的孙进程） ──
    const parent = spawn(process.execPath, ["-e", SPAWNER_SCRIPT], {
      env: { ...process.env, PID_FILE: pidFile },
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    cleanupPids.push(parent.pid);

    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await sleep(50);
    assert(fs.existsSync(pidFile), "孙进程已启动并记录 pid");
    const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    cleanupPids.push(grandchildPid);
    assert(pidAlive(parent.pid) && pidAlive(grandchildPid), "父子进程均在运行（孙进程独立进程组）");

    const descendants = listDescendantPids(parent.pid);
    assert(descendants.includes(grandchildPid), `子孙枚举包含独立进程组的孙进程（${grandchildPid}）`);

    killProcessTree(parent, "SIGKILL");
    assert(await waitDead(parent.pid), "父进程被终止");
    assert(await waitDead(grandchildPid), "独立进程组的孙进程也被回收（不被 init 收养继续跑）");

    // 对已退出的进程再杀一次：静默忽略，不抛错
    killProcessTree(parent, "SIGKILL");
    killProcessTree({ pid: 99999999 }, "SIGTERM");
    assert(true, "对已退出/不存在的进程重复终止不抛错");

    // ── 2. runCommandTree 正常成功 ──
    const ok = await runCommandTree("echo hello && echo world", {});
    assert(ok.code === 0 && ok.stdout.trim() === "hello\nworld", "命令成功：exit 0 且输出完整");

    // ── 3. runCommandTree 非零退出 ──
    const fail = await runCommandTree("echo oops >&2; exit 3", {});
    assert(fail.code === 3 && fail.stderr.trim() === "oops", "命令失败：保留退出码与 stderr");

    // ── 3b. 输出超限即整树终止（对齐 execSync 的 maxBuffer 语义） ──
    const runawayStart = Date.now();
    const runaway = await runCommandTree("yes flood", { maxBuffer: 4096, timeoutMs: 60000 });
    const runawayMs = Date.now() - runawayStart;
    assert(runaway.truncated === true && runaway.signal === "SIGKILL", "输出超限后命令被 SIGKILL 并标记截断");
    assert(runawayMs < 10000, `超限命令立即终止而不是跑到超时（耗时 ${runawayMs}ms）`);

    // ── 4. 超时：整棵树回收，含命令再启动的子孙 ──
    const slowPidFile = path.join(tmpDir, "slow-grandchild.pid");
    process.env.SLOW_PID_FILE = slowPidFile; // spawn 默认继承父进程环境
    const slow = await runCommandTree(
      `node -e 'const{spawn}=require("child_process");const fs=require("fs");const g=spawn("sleep",["300"],{detached:true,stdio:"ignore"});fs.writeFileSync(process.env.SLOW_PID_FILE,String(g.pid));g.unref();setTimeout(()=>{},600000)'`,
      { timeoutMs: 400 }
    );
    assert(slow.timedOut === true, "超时命令被标记 timedOut");
    assert(slow.code === null && slow.signal === "SIGKILL", "超时后进程被 SIGKILL");
    if (fs.existsSync(slowPidFile)) {
      const slowGrandchild = Number(fs.readFileSync(slowPidFile, "utf8"));
      cleanupPids.push(slowGrandchild);
      assert(await waitDead(slowGrandchild), "超时后命令的子孙（独立进程组）也被回收");
    } else {
      assert(false, "超时命令的孙进程 pid 文件未生成（命令未真正执行？）");
    }

    // ── 5. killActiveCommandTrees：宿主退出语义 ──
    const { activeCommandChildren } = require("../lib/process-tree");
    const hanging = runCommandTree(
      `node -e 'const{spawn}=require("child_process");const g=spawn("sleep",["300"],{detached:true,stdio:"ignore"});g.unref();setTimeout(()=>{},600000)'`,
      { timeoutMs: 60000 }
    );
    await sleep(300);
    assert(activeCommandChildren.size === 1, "执行中的命令被跟踪");
    const hangingChild = [...activeCommandChildren][0];
    const hangingDescendants = listDescendantPids(hangingChild.pid);
    // bash -c 对单条命令会 exec 优化（bash 进程直接被 node 替换），子孙至少含 sleep
    assert(hangingDescendants.length >= 1, `命令的子孙被枚举（实际 ${hangingDescendants.length} 个）`);
    killActiveCommandTrees("SIGKILL");
    const hangingResult = await hanging;
    assert(hangingResult.signal === "SIGKILL" || hangingResult.code === null, "宿主终止时执行中的命令被杀掉");
    for (const pid of hangingDescendants) {
      cleanupPids.push(pid);
      assert(await waitDead(pid), `宿主终止时命令的子孙 ${pid} 被回收`);
    }
  } catch (err) {
    console.error("测试异常:", err);
    failed += 1;
  } finally {
    // 兜底清理所有可能残留的进程
    for (const pid of cleanupPids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
