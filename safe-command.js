/**
 * Bash / 文件工具安全检查模块
 */

const dns = require("dns");
const fs = require("fs");
const net = require("net");
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

const NON_PUBLIC_IPS = new net.BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPS.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:2::", 48],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) {
  NON_PUBLIC_IPS.addSubnet(address, prefix, "ipv6");
}

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

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

function stripIpv6Brackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpAddress(address) {
  const normalized = stripIpv6Brackets(String(address || "").toLowerCase());
  if (normalized.startsWith("::ffff:")) return false;
  const family = net.isIP(normalized);
  if (family === 4) return !NON_PUBLIC_IPS.check(normalized, "ipv4");
  if (family === 6) return !NON_PUBLIC_IPS.check(normalized, "ipv6");
  return false;
}

function isExplicitLocalHostname(hostname) {
  const normalized = stripIpv6Brackets(String(hostname || "").toLowerCase()).replace(/\.$/, "");
  return normalized === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function isPublicWebFetchUrl(rawUrl, lookup = dns.promises.lookup) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) return false;
  if (parsed.username || parsed.password || isExplicitLocalHostname(parsed.hostname)) return false;

  const hostname = stripIpv6Brackets(parsed.hostname);
  if (net.isIP(hostname)) return isPublicIpAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicIpAddress(address));
  } catch {
    return false;
  }
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
    return true; // 所有 Bash 命令自动审批通过
  }
  if (toolName === "SendMessage" && context?.isChatMember) return true;
  return false;
}

async function shouldAutoAllowPermissionAsync(toolName, input, context = {}, dependencies = {}) {
  if (toolName === "WebFetch") {
    return isPublicWebFetchUrl(input?.url, dependencies.lookup || dns.promises.lookup);
  }
  return shouldAutoAllowPermission(toolName, input, context);
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
  isPublicIpAddress,
  isPublicWebFetchUrl,
  shouldAutoAllowPermission,
  shouldAutoAllowPermissionAsync,
};
