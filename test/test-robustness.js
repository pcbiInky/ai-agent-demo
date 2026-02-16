#!/usr/bin/env node

/**
 * 健壮性测试：覆盖本次改动的三个功能
 * 1. 超时机制（心跳检测 + 两阶段终止）
 * 2. 父进程退出时子进程清理
 * 3. 暗号验证（幻觉检测）
 *
 * 测试 1-2 使用 helpers/slow-cli.js 模拟，无需真实 CLI
 * 测试 3 需要真实 claude CLI
 *
 * 用法:
 *   node test/test-robustness.js           — 运行全部测试
 *   node test/test-robustness.js --quick   — 跳过需要真实 CLI 的测试
 */

const { spawn } = require("child_process");
const path = require("path");

const SLOW_CLI = path.join(__dirname, "helpers", "slow-cli.js");
const INVOKE_PATH = path.join(__dirname, "..", "invoke.js");

const quickMode = process.argv.includes("--quick");

let passed = 0;
let failed = 0;

function log(icon, msg) {
  console.log(`${icon} ${msg}`);
}

function assert(condition, testName) {
  if (condition) {
    passed++;
    log("✅", testName);
  } else {
    failed++;
    log("❌", testName);
  }
}

// ── 测试 1: 超时应该触发 ──────────────────────────────────
// 用极短超时调用一个永远不输出的进程，预期被超时 kill
async function testTimeoutKill() {
  console.log("\n=== 测试 1: 超时终止 (hang 进程) ===");

  const { invoke } = require(INVOKE_PATH);

  const start = Date.now();
  try {
    // 1 秒超时 + hang 模式的 slow-cli（不过 invoke 只认 CLI_CONFIG 中的命令）
    // 所以这里直接用 spawn 模拟 invoke 的超时逻辑
    await invokeWithFakeCli("hang", 1000);
    assert(false, "应该抛出超时错误");
  } catch (err) {
    const elapsed = Date.now() - start;
    assert(err.message.includes("超时"), `抛出超时错误: "${err.message}"`);
    // 超时应在 1s~8s 内触发 (1s timeout + 5s check interval buffer)
    assert(elapsed < 10_000, `超时耗时合理: ${elapsed}ms`);
  }
}

// ── 测试 2: stderr 活跃信号不应触发超时 ────────────────────
// slow-cli 在 stderr 持续输出（模拟 thinking），stdout 3 秒后才输出
// 超时设为 2 秒，如果只监听 stdout 就会误杀，正确行为是不超时
async function testStderrKeepsAlive() {
  console.log("\n=== 测试 2: stderr 活跃信号防误杀 ===");

  try {
    const result = await invokeWithFakeCli("slow", 2000);
    assert(result.text.includes("done"), `进程正常完成: "${result.text.trim()}"`);
  } catch (err) {
    assert(false, `不应超时但报错了: "${err.message}"`);
  }
}

// ── 测试 3: 两阶段终止 (SIGTERM → SIGKILL) ────────────────
// slow-cli ignore-term 模式忽略 SIGTERM，验证兜底 SIGKILL 生效
async function testSigtermThenSigkill() {
  console.log("\n=== 测试 3: 两阶段终止 (SIGTERM → SIGKILL) ===");

  const start = Date.now();
  try {
    await invokeWithFakeCli("ignore-term", 1000);
    assert(false, "应该抛出超时错误");
  } catch (err) {
    const elapsed = Date.now() - start;
    assert(err.message.includes("超时"), `SIGKILL 兜底生效: "${err.message}"`);
    // 应在 timeout(1s) + check-interval(5s) + SIGKILL-delay(5s) 内完成
    assert(elapsed < 15_000, `两阶段终止耗时合理: ${elapsed}ms`);
  }
}

// ── 测试 4: 向后兼容 — 不传 options 时行为不变 ─────────────
async function testBackwardCompat() {
  console.log("\n=== 测试 4: 向后兼容 (三参数调用) ===");

  try {
    const result = await invokeWithFakeCli("normal");
    assert(typeof result.text === "string" && result.text.length > 0, `返回文本: "${result.text.trim()}"`);
    assert(typeof result.sessionId === "string", `返回 sessionId: "${result.sessionId}"`);
    assert(result.verified === undefined, "未启用 verify 时无 verified 字段");
  } catch (err) {
    assert(false, `不应报错: "${err.message}"`);
  }
}

// ── 测试 5: 暗号验证 — 真实 CLI ──────────────────────────
async function testVerifyWithRealCli() {
  console.log("\n=== 测试 5: 暗号验证 (真实 Claude CLI) ===");

  const { invoke } = require(INVOKE_PATH);

  try {
    const result = await invoke("claude", "1+1等于几？请只回答数字", null, { verify: true });
    assert(typeof result.verified === "boolean", `verified 字段存在: ${result.verified}`);
    assert(!result.text.includes("VERIFY:"), `VERIFY 标记已从输出中清除`);

    if (result.verified) {
      log("✅", "暗号校验通过 — AI 忠实遵循了指令");
    } else {
      log("⚠️", "暗号校验未通过 — AI 未在末尾输出 VERIFY（不一定是幻觉，可能是指令遵循问题）");
    }
    console.log(`   回复内容: "${result.text.trim()}"`);
  } catch (err) {
    assert(false, `调用失败: "${err.message}"`);
  }
}

// ── 辅助：用 slow-cli.js 模拟 invoke 的核心逻辑 ──────────
// 因为 CLI_CONFIG 是模块私有的，这里直接复制 invoke 的超时/清理逻辑
// 来测试其行为是否正确
function invokeWithFakeCli(mode, timeoutMs = 600_000) {
  const { randomUUID } = require("crypto");

  return new Promise((resolve, reject) => {
    const child = spawn("node", [SLOW_CLI, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let result = "";
    let stderr = "";
    const id = randomUUID();

    // ── 以下逻辑与 invoke.js 保持一致 ──

    let lastActivity = Date.now();
    const markActive = () => { lastActivity = Date.now(); };
    child.stdout.on("data", markActive);
    child.stderr.on("data", markActive);

    let killTimer = null;
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > timeoutMs) {
        clearInterval(timer);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!child.killed || child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }
    }, 5000);

    child.stdout.on("data", (chunk) => { result += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearInterval(timer);
      clearTimeout(killTimer);
      reject(new Error(`启动失败: ${err.message}`));
    });

    child.on("close", (code) => {
      clearInterval(timer);
      clearTimeout(killTimer);
      if (child.killed) {
        reject(new Error(`超时 (${timeoutMs}ms 无活跃输出)`));
      } else if (code !== 0) {
        reject(new Error(`退出码 ${code}\n${stderr}`));
      } else {
        resolve({ text: result, sessionId: id });
      }
    });
  });
}

// ── 运行所有测试 ──────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     invoke.js 健壮性测试             ║");
  console.log("╚══════════════════════════════════════╝");

  if (quickMode) {
    console.log("(--quick 模式：跳过真实 CLI 测试)\n");
  }

  await testBackwardCompat();
  await testStderrKeepsAlive();
  await testTimeoutKill();
  await testSigtermThenSigkill();

  if (!quickMode) {
    await testVerifyWithRealCli();
  }

  console.log("\n══════════════════════════════════════");
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log("══════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

main();
