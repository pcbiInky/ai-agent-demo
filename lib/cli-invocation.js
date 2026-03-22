const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function isDirectlySpawnableWindowsBinary(command) {
  return /\.(exe|com)$/i.test(command || "");
}

function defaultWhere(command) {
  try {
    return execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findOnWindowsPath(command, { where = defaultWhere } = {}) {
  if (!command) return [];

  const candidates = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  }

  const lookupNames = [command];
  if (!/\.(cmd|bat|exe|com|ps1)$/i.test(command)) {
    lookupNames.push(`${command}.cmd`);
  }

  for (const lookupName of lookupNames) {
    for (const match of where(lookupName)) {
      if (!candidates.includes(match)) candidates.push(match);
    }
  }

  return candidates;
}

function normalizeWindowsPath(target) {
  return target.replace(/\//g, "\\");
}

function extractNodeScriptFromCmd(candidate, readFileSync) {
  if (!/\.cmd$/i.test(candidate)) return null;

  try {
    const content = readFileSync(candidate, "utf8");
    const match = content.match(/"%dp0%\\([^"\r\n]+\.js)"/i);
    if (!match) return null;
    return normalizeWindowsPath(path.join(path.dirname(candidate), match[1]));
  } catch {
    return null;
  }
}

function resolveCliInvocation(command, args = [], options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const nodePath = options.nodePath || process.execPath;

  if (platform !== "win32") {
    return { command, args };
  }

  if (isDirectlySpawnableWindowsBinary(command)) {
    return { command, args };
  }

  for (const candidate of findOnWindowsPath(command, options)) {
    const scriptPath = extractNodeScriptFromCmd(candidate, readFileSync);
    if (scriptPath && existsSync(scriptPath)) {
      return {
        command: nodePath,
        args: [scriptPath, ...args],
      };
    }
  }

  if (/\.js$/i.test(command) && existsSync(command)) {
    return {
      command: nodePath,
      args: [command, ...args],
    };
  }

  return { command, args };
}

module.exports = {
  resolveCliInvocation,
};
