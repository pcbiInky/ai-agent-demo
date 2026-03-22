#!/usr/bin/env node

const { __test } = require("../invoke");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.log(`FAIL ${label}`);
    failed += 1;
  }
}

const npmRoot = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const nodePath = "C:\\Program Files\\nodejs\\node.exe";

function existsSync(target) {
  return [
    `${npmRoot}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
    `${npmRoot}\\node_modules\\@openai\\codex\\bin\\codex.js`,
    `${npmRoot}\\node_modules\\bytedance\\trae-cli\\bin\\trae.js`,
  ].includes(target);
}

function readFileSync(target) {
  const table = {
    [`${npmRoot}\\claude.cmd`]: `@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`,
    [`${npmRoot}\\codex.cmd`]: `@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    [`${npmRoot}\\trae-cli.cmd`]: `@ECHO off\r\n"%dp0%\\node_modules\\bytedance\\trae-cli\\bin\\trae.js" %*\r\n`,
  };
  if (!(target in table)) {
    throw new Error(`Unexpected file: ${target}`);
  }
  return table[target];
}

function where(command) {
  const table = {
    claude: [`${npmRoot}\\claude`, `${npmRoot}\\claude.cmd`],
    "trae-cli": [`${npmRoot}\\trae-cli.cmd`],
    codex: [`${npmRoot}\\codex`, `${npmRoot}\\codex.cmd`],
  };
  return table[command] || [];
}

const claudeResolved = __test.resolveCliInvocation("claude", ["--version"], {
  platform: "win32",
  nodePath,
  where,
  existsSync,
  readFileSync,
});

assert(claudeResolved.command === nodePath, "claude resolves to node on win32");
assert(
  claudeResolved.args[0] === `${npmRoot}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
  "claude prepends cli.js"
);
assert(claudeResolved.args[1] === "--version", "claude keeps args");

const codexResolved = __test.resolveCliInvocation("codex", ["exec", "--json", "hello"], {
  platform: "win32",
  nodePath,
  where,
  existsSync,
  readFileSync,
});

assert(codexResolved.command === nodePath, "codex resolves to node on win32");
assert(
  codexResolved.args[0] === `${npmRoot}\\node_modules\\@openai\\codex\\bin\\codex.js`,
  "codex prepends cli.js"
);
assert(codexResolved.args.slice(1).join("|") === "exec|--json|hello", "codex keeps args");

const traeResolved = __test.resolveCliInvocation("trae-cli", ["--version"], {
  platform: "win32",
  nodePath,
  where,
  existsSync,
  readFileSync,
});

assert(traeResolved.command === nodePath, "trae-cli resolves to node on win32");
assert(
  traeResolved.args[0] === `${npmRoot}\\node_modules\\bytedance\\trae-cli\\bin\\trae.js`,
  "trae-cli prepends cli.js"
);
assert(traeResolved.args[1] === "--version", "trae-cli keeps args");

const exeResolved = __test.resolveCliInvocation("C:\\Tools\\claude.exe", ["--version"], {
  platform: "win32",
  nodePath,
  where,
  existsSync,
  readFileSync,
});

assert(exeResolved.command === "C:\\Tools\\claude.exe", ".exe stays unchanged");
assert(exeResolved.args.join("|") === "--version", ".exe keeps args");

const nonWindows = __test.resolveCliInvocation("claude", ["--version"], {
  platform: "darwin",
  nodePath,
  where,
  existsSync,
  readFileSync,
});

assert(nonWindows.command === "claude", "non-win command stays unchanged");
assert(nonWindows.args.join("|") === "--version", "non-win args stay unchanged");

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
