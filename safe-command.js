/**
 * Bash / 文件工具安全检查模块
 */

const fs = require("fs");
const path = require("path");

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

const SAFE_PIPE_COMMANDS = new Set([
  "head", "tail", "wc", "sort", "uniq", "cat", "less", "more",
  "cut", "tr", "grep",
]);

const SAFE_STANDALONE_COMMANDS = new Set([
  "cd",
]);

const SAFE_WORKDIR_BASH_COMMANDS = new Set([
  "rg",
  "grep",
  "sed",
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

function isSafeSingleCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (/[\n\r&;<>`$]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  if (SAFE_STANDALONE_COMMANDS.has(parts[0])) return true;
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

  if (/&&|\|\||[;\n\r\\`]|\$\(|[<>]|^\s*\(|\)\s*$/.test(trimmed)) return false;

  const segments = trimmed.split("|");
  if (!isSafeSingleCommand(segments[0])) return false;
  for (let i = 1; i < segments.length; i++) {
    if (!isSafePipeTarget(segments[i])) return false;
  }
  return true;
}

function getCommandName(command) {
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  if (!trimmed || /&&|\|\||[;\n\r\\`]|\$\(|[<>]/.test(trimmed)) return "";
  const parts = trimmed.split(/\s+/);
  return parts[0] || "";
}

function normalizePath(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) return null;
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let probe = resolved;
    const suffix = [];
    while (probe && probe !== path.dirname(probe) && !fs.existsSync(probe)) {
      suffix.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
    try {
      const realBase = fs.realpathSync.native(probe);
      return path.join(realBase, ...suffix);
    } catch {
      return resolved;
    }
  }
}

function isPathWithin(baseDir, targetPath) {
  const base = normalizePath(baseDir);
  const target = normalizePath(targetPath);
  if (!base || !target) return false;
  return target === base || target.startsWith(base + path.sep);
}

function isWorkdirSearchAllowed(input, workingDirectory) {
  const targetPath = input?.path || workingDirectory;
  return isPathWithin(workingDirectory, targetPath);
}

function isAllowedWorkdirBash(command, cwd, workingDirectory) {
  if (!workingDirectory || !cwd || !isPathWithin(workingDirectory, cwd)) return false;
  const commandName = getCommandName(command);
  if (!SAFE_WORKDIR_BASH_COMMANDS.has(commandName)) return false;
  if (/&&|\|\||[;\n\r\\`]|\$\(|[<>]/.test(command || "")) return false;
  return true;
}

function shouldAutoAllowPermission(toolName, input, context = {}) {
  const workingDirectory = context.workingDirectory || "";

  if (toolName === "Read") return true;
  if (toolName === "Glob") {
    return workingDirectory ? isWorkdirSearchAllowed(input, workingDirectory) : true;
  }
  if (toolName === "Grep") {
    return workingDirectory ? isWorkdirSearchAllowed(input, workingDirectory) : true;
  }
  if (toolName === "Edit") {
    return workingDirectory ? isPathWithin(workingDirectory, input?.file_path) : false;
  }
  if (toolName === "Write") {
    return workingDirectory ? isPathWithin(workingDirectory, input?.file_path) : false;
  }
  if (toolName === "Bash") {
    if (workingDirectory && isAllowedWorkdirBash(input?.command, input?.cwd, workingDirectory)) return true;
    return isSafeBashCommand(input?.command);
  }
  if (toolName === "SendMessage" && context?.isChatMember) return true;
  return false;
}

module.exports = {
  SAFE_GIT_QUERY_SUBCOMMANDS,
  SAFE_PIPE_COMMANDS,
  SAFE_WORKDIR_BASH_COMMANDS,
  parseGitSubcommand,
  isSafeSingleCommand,
  isSafePipeTarget,
  isSafeBashCommand,
  isPathWithin,
  normalizePath,
  shouldAutoAllowPermission,
};
