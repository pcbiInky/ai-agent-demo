#!/usr/bin/env node
/**
 * 探针：验证 dsh --profile acp 的 JSON-RPC 握手。
 * 只跑 initialize / session/new / session/close，不触发 LLM 调用，因此不需要 API key。
 *
 * 用法: node scripts/dsh-acp-probe.js
 */
const { spawn } = require("child_process");
const path = require("path");

const CWD = path.resolve(__dirname, "..");
const PERMISSION_SERVER = path.join(CWD, "permission-server.js");

function main() {
  const child = spawn("dsh", ["--profile", "acp"], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  const log = [];

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log.push(`[非 JSON 输出] ${line}`);
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        entry?.resolve(msg);
      } else if (msg.method) {
        // agent -> client 的请求/通知
        log.push(`[agent -> client] method=${msg.method} id=${msg.id ?? "(notification)"}`);
        if (msg.id !== undefined) {
          // 一律拒绝，探针不实现权限交互
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "probe does not implement this" } });
        }
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    log.push(`[stderr] ${chunk.toString().trimEnd()}`);
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（30s）`));
      }, 30000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${method} 失败: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  (async () => {
    try {
      const init = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      console.log("✅ initialize:", JSON.stringify(init, null, 2));

      const created = await request("session/new", {
        cwd: CWD,
        mcpServers: [
          {
            name: "permission",
            command: process.execPath,
            args: [PERMISSION_SERVER],
            env: [
              { name: "PERMISSION_SERVER_PORT", value: "3999" },
              { name: "PERMISSION_BROWSER_SESSION", value: "probe-session" },
              { name: "PERMISSION_CHARACTER", value: "Faker" },
              { name: "PERMISSION_WORKING_DIRECTORY", value: CWD },
            ],
          },
        ],
      });
      console.log("✅ session/new:", JSON.stringify(created, null, 2));

      await request("session/close", { sessionId: created.sessionId });
      console.log("✅ session/close ok, sessionId =", created.sessionId);

      console.log("\n--- 期间收到的事件 ---");
      console.log(log.join("\n") || "(无)");
      process.exitCode = 0;
    } catch (err) {
      console.error("❌ 探针失败:", err.message);
      console.error("\n--- 期间收到的事件 ---");
      console.error(log.join("\n") || "(无)");
      process.exitCode = 1;
    } finally {
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 500);
    }
  })();
}

main();
