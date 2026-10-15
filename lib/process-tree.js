// 进程树终止与命令执行工具：invoke.js 与 permission-server.js 共用
// 背景：codex 等 CLI 包装脚本收到 SIGTERM 只转发给直接子进程，且会把 shell
// 命令放进独立进程组；只杀直接子进程（或只杀进程组）都会漏掉另起进程组的
// 孙进程。终止时必须「进程组 + 进程树」双管齐下。
const { execSync, spawn } = require("child_process");

const IS_WINDOWS = process.platform === "win32";

// 列出 rootPid 的全部子孙 pid（不含自身）；ps 不可用或已退出时返回空数组
function listDescendantPids(rootPid) {
  if (IS_WINDOWS || !Number.isInteger(rootPid)) return [];
  let out;
  try {
    out = execSync("ps -eo pid=,ppid=", { encoding: "utf-8", timeout: 5000 });
  } catch {
    return [];
  }
  const byParent = new Map();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const result = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const childPid of byParent.get(pid) || []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      result.push(childPid);
      queue.push(childPid);
    }
  }
  return result;
}

// 终止整棵进程树：先收集子孙（杀完再收集就来不及了），再杀进程组
// （detached spawn 后 child.pid 即 pgid），最后逐个补杀另起进程组的子孙
function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.pid == null) return;
  const pid = child.pid;
  const descendants = listDescendantPids(pid);
  if (!IS_WINDOWS) {
    try { process.kill(-pid, signal); } catch { /* 进程组不存在（未 detached 或已退出） */ }
  }
  try { child.kill(signal); } catch { /* 已退出 */ }
  for (const descendantPid of descendants) {
    try { process.kill(descendantPid, signal); } catch { /* 已退出 */ }
  }
}

// ── spawn 版命令执行（替代 execSync）──────────────────────────
// 保留子进程引用：超时或宿主终止时能整棵树杀掉，而不是只杀 sh 自己

// 仍在执行的命令子进程，进程退出时统一清理
const activeCommandChildren = new Set();

function killActiveCommandTrees(signal = "SIGTERM") {
  for (const child of activeCommandChildren) {
    killProcessTree(child, signal);
  }
}

// 执行 shell 命令，resolve { code, signal, stdout, stderr, timedOut, truncated }；
// 永不 reject（错误也走 result），调用方按 code/timedOut 判断
function runCommandTree(command, { cwd, timeoutMs = 120_000, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      // 独占进程组：终止时整组回收（含命令再启动的后台进程）
      detached: !IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeCommandChildren.add(child);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (key) => (chunk) => {
      const text = chunk.toString();
      const current = key === "stdout" ? stdout : stderr;
      if (current.length + text.length > maxBuffer) {
        // 与 execSync 语义对齐：输出超限直接终止命令（整树），
        // 避免 runaway 输出（如 yes）截断后还跑到超时
        const keep = Math.max(0, maxBuffer - current.length);
        if (key === "stdout") stdout = current + text.slice(0, keep);
        else stderr = current + text.slice(0, keep);
        if (!truncated) {
          truncated = true;
          killProcessTree(child, "SIGKILL");
        }
        return;
      }
      if (key === "stdout") stdout = current + text;
      else stderr = current + text;
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeCommandChildren.delete(child);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      finish({ code: null, signal: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${err.message}`, timedOut, truncated });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut, truncated });
    });
  });
}

module.exports = {
  IS_WINDOWS,
  listDescendantPids,
  killProcessTree,
  activeCommandChildren,
  killActiveCommandTrees,
  runCommandTree,
};
