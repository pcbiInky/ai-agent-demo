/**
 * Bash 命令安全检查模块
 *
 * 判断一条 Bash 命令是否可以自动授权（无需用户审批）。
 * 规则：首段必须是安全的 git 只读子命令，管道后续段只允许严格无副作用的过滤器。
 */

const SAFE_GIT_QUERY_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "grep",
  "help",
  "version",
]);

function parseGitSubcommand(parts) {
  let i = 1;
  while (i < parts.length && parts[i].startsWith("-")) {
    const flag = parts[i];
    if (flag === "--no-pager") {
      i += 1;
      continue;
    }
    if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") {
      i += 2;
      continue;
    }
    return null;
  }
  return parts[i] || null;
}

// 管道右侧允许的安全过滤命令（严格无副作用的纯过滤器）
// 注意：sed/awk/xargs/tee 已移除，因为它们可执行任意命令或产生副作用
const SAFE_PIPE_COMMANDS = new Set([
  "head", "tail", "wc", "sort", "uniq", "cat", "less", "more",
  "cut", "tr", "grep",
]);

function isSafeSingleCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // 单条命令内不允许 换行、&、;、<、>、反引号、$（防注入）
  if (/[\n\r&;<>`$]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  if (parts[0] !== "git") return false;
  const subcommand = parseGitSubcommand(parts);
  return subcommand ? SAFE_GIT_QUERY_SUBCOMMANDS.has(subcommand) : false;
}

function isSafePipeTarget(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (/[\n\r&;<>`$]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  return SAFE_PIPE_COMMANDS.has(parts[0]);
}

function isSafeBashCommand(command) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 按管道符拆分
  const segments = trimmed.split("|");
  // 第一段必须是安全的 git 只读命令
  if (!isSafeSingleCommand(segments[0])) return false;
  // 后续每段必须是安全的过滤命令
  for (let i = 1; i < segments.length; i++) {
    if (!isSafePipeTarget(segments[i])) return false;
  }
  return true;
}

function shouldAutoAllowPermission(toolName, input) {
  if (toolName === "Read") return true;
  if (toolName === "Glob") return true;
  if (toolName === "Grep") return true;
  if (toolName === "Bash" && isSafeBashCommand(input?.command)) return true;
  return false;
}

module.exports = {
  SAFE_GIT_QUERY_SUBCOMMANDS,
  SAFE_PIPE_COMMANDS,
  parseGitSubcommand,
  isSafeSingleCommand,
  isSafePipeTarget,
  isSafeBashCommand,
  shouldAutoAllowPermission,
};
