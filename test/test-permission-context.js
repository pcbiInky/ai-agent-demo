#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  __test,
} = require("../invoke");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }

  console.error(`FAIL ${label}`);
  failed += 1;
}

function cleanup(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function testTraeUsesPerInvokePermissionConfig() {
  assert(typeof __test?.preparePermissionTransport === "function", "invoke exposes preparePermissionTransport helper");
  assert(typeof __test?.buildPermissionEnv === "function", "invoke exposes buildPermissionEnv helper");
  assert(typeof __test?.buildTraePermissionRegistrationConfig === "function", "invoke exposes buildTraePermissionRegistrationConfig helper");
  assert(typeof __test?.hasTraePermissionRegistration === "function", "invoke exposes hasTraePermissionRegistration helper");
  if (
    typeof __test?.preparePermissionTransport !== "function" ||
    typeof __test?.buildPermissionEnv !== "function" ||
    typeof __test?.buildTraePermissionRegistrationConfig !== "function" ||
    typeof __test?.hasTraePermissionRegistration !== "function"
  ) return;

  const sharedContextPath = path.join(os.tmpdir(), "mcp-perm-context.json");
  cleanup(sharedContextPath);

  const prepared = __test.preparePermissionTransport("trae", {
    browserSessionId: "session-trae",
    character: "YYF",
    workingDirectory: "/tmp/worktree-trae",
    permissionServerPort: "3999",
  });

  assert(!fs.existsSync(sharedContextPath), "trae invoke no longer writes shared MCP context file");
  assert(prepared.cleanupPaths.length === 0, "trae invoke does not rely on temp context files");
  assert(
    prepared.args.includes("--allowed-tool"),
    "trae invoke still preauthorizes MCP tools"
  );
  assert(
    prepared.args.includes("--disallowed-tool"),
    "trae invoke still disables built-in executable tools"
  );
  assert(
    !prepared.args.some((value) => value.includes("mcp_servers.permission")),
    "trae invoke no longer injects per-invoke MCP config overrides"
  );

  const permissionEnv = __test.buildPermissionEnv("3999", "session-trae", "YYF", "/tmp/worktree-trae");
  assert(
    permissionEnv.PERMISSION_SERVER_PORT === "3999" &&
      permissionEnv.PERMISSION_BROWSER_SESSION === "session-trae" &&
      permissionEnv.PERMISSION_CHARACTER === "YYF" &&
      permissionEnv.PERMISSION_WORKING_DIRECTORY === "/tmp/worktree-trae",
    "trae invoke builds permission env for parent-process inheritance"
  );

  const registration = __test.buildTraePermissionRegistrationConfig();
  assert(
    registration.command === "node" &&
      Array.isArray(registration.args) &&
      registration.args[0] === path.join(__dirname, "..", "permission-server.js"),
    "trae registration points to the permission server entrypoint"
  );
  assert(
    registration.env && Object.keys(registration.env).length === 0,
    "trae registration uses empty env so MCP server inherits invoke env"
  );
  assert(
    __test.hasTraePermissionRegistration("mcp_servers:\n  - name: permission\n"),
    "trae registration detector recognizes existing permission entry"
  );
  assert(
    !__test.hasTraePermissionRegistration("mcp_servers:\n  - name: github\n"),
    "trae registration detector ignores unrelated MCP entries"
  );
}

function testCodexUsesPerInvokePermissionConfig() {
  assert(typeof __test?.preparePermissionTransport === "function", "invoke exposes preparePermissionTransport helper");
  if (typeof __test?.preparePermissionTransport !== "function") return;

  const sharedContextPath = path.join(os.tmpdir(), "mcp-perm-context.json");
  cleanup(sharedContextPath);

  const prepared = __test.preparePermissionTransport("codex", {
    browserSessionId: "session-codex",
    character: "奇迹哥",
    workingDirectory: "/tmp/worktree-codex",
    permissionServerPort: "4999",
  });

  assert(!fs.existsSync(sharedContextPath), "codex invoke no longer writes shared MCP context file");
  assert(prepared.cleanupPaths.length === 0, "codex invoke does not rely on temp context files");
  assert(
    prepared.args.some((value) => value.includes("mcp_servers.permission.command") && value.includes("node")),
    "codex invoke includes per-invoke MCP command override"
  );
  assert(
    prepared.args.some((value) => value.includes("mcp_servers.permission.env.PERMISSION_CHARACTER") && value.includes("奇迹哥")),
    "codex invoke includes per-invoke character env override"
  );
  assert(
    prepared.args.some((value) => value.includes("mcp_servers.permission.env.PERMISSION_BROWSER_SESSION") && value.includes("session-codex")),
    "codex invoke includes per-invoke session env override"
  );
}

function main() {
  testTraeUsesPerInvokePermissionConfig();
  testCodexUsesPerInvokePermissionConfig();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
