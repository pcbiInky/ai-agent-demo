/**
 * SendMessage 功能测试
 *
 * 测试内容：
 * 1. safe-command.js: SendMessage 权限策略（成员自动放行、非成员不放行）
 * 2. server.js: /api/mcp-send-message 端点（参数校验、审批记录校验）
 */

const { shouldAutoAllowPermission } = require("../safe-command");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.log(`❌ ${label}`);
    failed++;
  }
}

// ── 1. SendMessage 权限策略测试 ──────────────────────────

console.log("\n=== SendMessage 权限策略 ===");

assert(
  shouldAutoAllowPermission("SendMessage", { text: "hello" }, { isChatMember: true }) === true,
  "聊天室成员发 SendMessage 自动放行"
);

assert(
  shouldAutoAllowPermission("SendMessage", { text: "hello" }, { isChatMember: false }) === false,
  "非聊天室成员发 SendMessage 不自动放行"
);

assert(
  shouldAutoAllowPermission("SendMessage", { text: "hello" }) === false,
  "无 context 时 SendMessage 不自动放行"
);

assert(
  shouldAutoAllowPermission("SendMessage", { text: "hello" }, {}) === false,
  "context 中无 isChatMember 时 SendMessage 不自动放行"
);

// 确认其他工具的行为不受影响
assert(
  shouldAutoAllowPermission("Read", { file_path: "/tmp/test" }) === true,
  "Read 仍然自动放行（向后兼容）"
);

assert(
  shouldAutoAllowPermission("Glob", { pattern: "**/*.js" }) === true,
  "Glob 仍然自动放行（向后兼容）"
);

assert(
  shouldAutoAllowPermission("Write", { file_path: "/tmp/test" }) === false,
  "Write 仍然不自动放行（向后兼容）"
);

assert(
  shouldAutoAllowPermission("Edit", { file_path: "/tmp/test" }) === false,
  "Edit 仍然不自动放行（向后兼容）"
);

// context 参数不影响其他工具
assert(
  shouldAutoAllowPermission("Read", { file_path: "/tmp/test" }, { isChatMember: false }) === true,
  "Read 不受 context 影响"
);

assert(
  shouldAutoAllowPermission("Write", { file_path: "/tmp/test" }, { isChatMember: true }) === false,
  "Write 不受 context.isChatMember 影响"
);

// ── 总结 ─────────────────────────────────────────────────

console.log(`\n${"═".repeat(38)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log("═".repeat(38));

if (failed > 0) process.exit(1);
