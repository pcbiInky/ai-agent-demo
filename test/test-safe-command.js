#!/usr/bin/env node

/**
 * safe-command.js 单元测试
 *
 * 覆盖 Issue #10 中提到的绕过场景：
 * - xargs 可执行任意命令
 * - awk 的 system() 可执行任意命令
 * - sed 的 e 标志可执行命令
 * - tee 可写入任意文件
 */

const {
  isSafeBashCommand,
  isSafePipeTarget,
  isSafeSingleCommand,
  shouldAutoAllowPermission,
  SAFE_PIPE_COMMANDS,
} = require("../safe-command");

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`✅ ${testName}`);
  } else {
    failed++;
    console.log(`❌ ${testName}`);
  }
}

// ── 白名单不应包含危险命令 ─────────────────────────────────
console.log("\n=== 白名单内容检查 ===");
assert(!SAFE_PIPE_COMMANDS.has("xargs"), "xargs 不在白名单中");
assert(!SAFE_PIPE_COMMANDS.has("awk"), "awk 不在白名单中");
assert(!SAFE_PIPE_COMMANDS.has("sed"), "sed 不在白名单中");
assert(!SAFE_PIPE_COMMANDS.has("tee"), "tee 不在白名单中");

// ── 安全命令应通过 ────────────────────────────────────────
console.log("\n=== 安全命令应通过 ===");
assert(isSafeBashCommand("git status"), "git status");
assert(isSafeBashCommand("git diff"), "git diff");
assert(isSafeBashCommand("git log --oneline"), "git log --oneline");
assert(isSafeBashCommand("git log | head -10"), "git log | head -10");
assert(isSafeBashCommand("git log | grep fix"), "git log | grep fix");
assert(isSafeBashCommand("git log | wc -l"), "git log | wc -l");
assert(isSafeBashCommand("git log | sort | uniq"), "git log | sort | uniq");
assert(isSafeBashCommand("git diff | head -50"), "git diff | head -50");
assert(isSafeBashCommand("git --no-pager log"), "git --no-pager log");
assert(isSafeBashCommand("git -C /some/path status"), "git -C /some/path status");
assert(isSafeBashCommand("git blame file.js | tail -20"), "git blame file.js | tail -20");
assert(isSafeBashCommand("git ls-files | grep .js"), "git ls-files | grep .js");
assert(isSafeBashCommand("git show HEAD | head"), "git show HEAD | head");
assert(isSafeBashCommand("git log | cut -d: -f1"), "git log | cut -d: -f1");
assert(isSafeBashCommand("git log | tr A-Z a-z"), "git log | tr A-Z a-z");

// ── Issue #10 绕过场景：必须被拒绝 ──────────────────────────
console.log("\n=== Issue #10 绕过场景（必须拒绝）===");
assert(!isSafeBashCommand("git log | xargs rm -rf"), "xargs rm -rf 被拒绝");
assert(!isSafeBashCommand("git log | xargs echo"), "xargs echo 被拒绝");
assert(!isSafeBashCommand("git ls-files | xargs cat"), "xargs cat 被拒绝");
assert(!isSafeBashCommand('git log | awk \'system("id")\''), "awk system() 被拒绝");
assert(!isSafeBashCommand("git log | awk '{print}'"), "awk 被拒绝（即使无害参数）");
assert(!isSafeBashCommand("git log | sed -e '1e id'"), "sed e 命令执行被拒绝");
assert(!isSafeBashCommand("git log | sed 's/a/b/'"), "sed 被拒绝（即使无害参数）");
assert(!isSafeBashCommand("git log | tee /etc/passwd"), "tee 写文件被拒绝");
assert(!isSafeBashCommand("git log | tee output.txt"), "tee 被拒绝（即使看似无害）");

// ── Shell 命令连接符必须被拒绝 ────────────────────────────
console.log("\n=== Shell 命令连接符（必须拒绝）===");
assert(!isSafeBashCommand("git log && rm -rf /"), "&& 连接符被拒绝");
assert(!isSafeBashCommand("git log && echo pwned"), "&& echo 被拒绝");
assert(!isSafeBashCommand("git status && git push"), "&& 链接两个 git 命令被拒绝");
assert(!isSafeBashCommand("git log || rm -rf /"), "|| 连接符被拒绝");
assert(!isSafeBashCommand("git log || echo fallback"), "|| echo 被拒绝");
assert(!isSafeBashCommand("git log; rm -rf /"), "分号连接被拒绝");
assert(!isSafeBashCommand("git log; echo pwned"), "分号 echo 被拒绝");
assert(!isSafeBashCommand("git log & rm -rf /"), "后台执行 & 被拒绝");
assert(!isSafeBashCommand("git log |& cat"), "|& (bash 特殊管道) 被拒绝");

// ── 其他危险命令也必须被拒绝 ─────────────────────────────
console.log("\n=== 其他危险命令 ===");
assert(!isSafeBashCommand("rm -rf /"), "rm -rf 被拒绝");
assert(!isSafeBashCommand("ls -la"), "ls 被拒绝（非 git 命令）");
assert(!isSafeBashCommand("git push"), "git push 被拒绝（非只读）");
assert(!isSafeBashCommand("git commit -m 'test'"), "git commit 被拒绝");
assert(!isSafeBashCommand("git checkout main"), "git checkout 被拒绝");
assert(!isSafeBashCommand("git reset --hard"), "git reset --hard 被拒绝");
assert(!isSafeBashCommand("git log > /etc/passwd"), "重定向 > 被拒绝");
assert(!isSafeBashCommand("git log < /dev/null"), "重定向 < 被拒绝");
assert(!isSafeBashCommand("git log >> /tmp/out"), "追加重定向 >> 被拒绝");
assert(!isSafeBashCommand("git log 2>&1 | cat"), "stderr 重定向被拒绝");
assert(!isSafeBashCommand("git log `id`"), "反引号注入被拒绝");
assert(!isSafeBashCommand("git log $(id)"), "$() 注入被拒绝");
assert(!isSafeBashCommand("(git log)"), "子 shell () 被拒绝");
assert(!isSafeBashCommand("git log\nrm -rf /"), "换行注入被拒绝");
assert(!isSafeBashCommand(""), "空字符串被拒绝");
assert(!isSafeBashCommand(null), "null 被拒绝");
assert(!isSafeBashCommand(undefined), "undefined 被拒绝");

// ── shouldAutoAllowPermission ────────────────────────────
console.log("\n=== shouldAutoAllowPermission ===");
assert(shouldAutoAllowPermission("Read", {}), "Read 自动通过");
assert(shouldAutoAllowPermission("Glob", {}), "Glob 自动通过");
assert(shouldAutoAllowPermission("Grep", {}), "Grep 自动通过");
assert(shouldAutoAllowPermission("Bash", { command: "git status" }), "安全 git 命令自动通过");
assert(!shouldAutoAllowPermission("Bash", { command: "git log | xargs rm" }), "xargs 管道不自动通过");
assert(!shouldAutoAllowPermission("Bash", { command: "git log | awk '{print}'" }), "awk 管道不自动通过");
assert(!shouldAutoAllowPermission("Bash", { command: "rm -rf /" }), "危险命令不自动通过");
assert(!shouldAutoAllowPermission("Write", {}), "Write 不自动通过");
assert(!shouldAutoAllowPermission("Edit", {}), "Edit 不自动通过");

// ── 结果 ──────────────────────────────────────────────────
console.log("\n══════════════════════════════════════");
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log("══════════════════════════════════════");

process.exit(failed > 0 ? 1 : 0);
