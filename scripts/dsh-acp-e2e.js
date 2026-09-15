#!/usr/bin/env node
/**
 * 端到端探针：initialize -> session/new -> session/prompt -> session/close
 * -> session/resume -> session/prompt -> session/close
 *
 * 与 dsh-acp-probe.js 的区别：会真正触发 LLM 调用，因此需要已配置 DEEPSEEK_API_KEY
 * （~/.dsh/.credentials.yaml 或 <cwd>/.env）。
 *
 * 用法: node scripts/dsh-acp-e2e.js
 */
const { spawn } = require("child_process");
const path = require("path");

const CWD = path.resolve(__dirname, "..");
const PERMISSION_SERVER = path.join(CWD, "permission-server.js");

/** dsh 声明的 MCP 服务器（会话恢复时必须重新提供，否则恢复后的会话没有权限工具）。 */
function mcpServers() {
  return [
    {
      name: "permission",
      command: process.execPath,
      args: [PERMISSION_SERVER],
      env: [
        { name: "PERMISSION_SERVER_PORT", value: "3999" },
        { name: "PERMISSION_BROWSER_SESSION", value: "e2e-session" },
        { name: "PERMISSION_CHARACTER", value: "Faker" },
        { name: "PERMISSION_WORKING_DIRECTORY", value: CWD },
      ],
    },
  ];
}

function main() {
  const child = spawn("dsh", ["--profile", "acp"], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  const stderr = [];
  const updates = [];

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
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        entry?.(msg);
        continue;
      }
      if (!msg.method) continue;

      if (msg.method === "session/update") {
        updates.push(msg.params);
        const u = msg.params?.update || {};
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          process.stdout.write(u.content.text);
        }
        continue;
      }
      if (msg.id !== undefined) {
        // agent -> client 请求：自动选择“允许一次”
        let result = {};
        if (msg.method === "session/request_permission") {
          const options = msg.params?.options || [];
          const pick =
            options.find((o) => o.kind === "allow_once") ||
            options.find((o) => o.kind === "allow_always") ||
            options[0];
          result = pick
            ? { outcome: { outcome: "selected", optionId: pick.optionId } }
            : { outcome: { outcome: "cancelled" } };
        } else if (msg.method === "fs/read_text_file") {
          result = { content: "" };
        } else if (msg.method === "fs/write_text_file") {
          result = {};
        }
        send({ jsonrpc: "2.0", id: msg.id, result });
      }
    }
  });

  child.stderr.on("data", (chunk) => stderr.push(chunk.toString().trimEnd()));

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function request(method, params, timeoutMs = 180000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method} 失败: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function prompt(sessionId, text) {
    process.stdout.write(`\n>>> ${text}\n<<< `);
    const res = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    process.stdout.write(`\n[stopReason=${res.stopReason}]\n`);
    return res;
  }

  (async () => {
    try {
      const init = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      console.log("✅ initialize:", init.agentInfo?.name, init.agentInfo?.version);

      const created = await request("session/new", { cwd: CWD, mcpServers: mcpServers() });
      const sessionId = created.sessionId;
      console.log("✅ session/new:", sessionId);
      const modelOpt = (created.configOptions || []).find((o) => o.id === "model");
      if (modelOpt) console.log("   model =", modelOpt.currentValue);

      await prompt(sessionId, "只回复两个字：收到");

      await request("session/close", { sessionId });
      console.log("✅ session/close ok");

      const resumed = await request("session/resume", {
        sessionId,
        cwd: CWD,
        mcpServers: mcpServers(),
      });
      console.log("✅ session/resume ok, configOptions =", JSON.stringify(resumed.configOptions ?? null));

      await prompt(sessionId, "刚才我让你回复什么？只回答那两个字的原话");

      await request("session/close", { sessionId });
      console.log("✅ session/close ok（第二次）");
      console.log("\n🎉 全链路通过：api key 生效，prompt 与 resume 均可用");
      process.exitCode = 0;
    } catch (err) {
      console.error("\n❌ e2e 失败:", err.message);
      if (stderr.length) console.error("--- stderr ---\n" + stderr.join("\n"));
      process.exitCode = 1;
    } finally {
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 500);
    }
  })();
}

main();
