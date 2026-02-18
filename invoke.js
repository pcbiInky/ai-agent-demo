const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

// 活跃子进程集合，父进程退出时统一清理
const activeChildren = new Set();
function cleanupChildren() {
  for (const child of activeChildren) {
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", () => { cleanupChildren(); process.exit(1); });
process.on("SIGTERM", () => { cleanupChildren(); process.exit(1); });
process.on("exit", cleanupChildren);

// CLI 配置表：只定义各 CLI 的差异部分
// session 参数两者一致：首次 --session-id <uuid>，后续 --resume <uuid>
const CLI_CONFIG = {
  claude: {
    command: "claude",
    extraArgs: ["--output-format", "stream-json", "--verbose"],
    // stream-json: 逐行解析 NDJSON，提取 assistant 事件中的文本
    parse: (stdout, onText) => {
      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant") {
            for (const block of event.message?.content ?? []) {
              if (block.type === "text" && block.text) onText(block.text);
            }
          }
        } catch {
          // 忽略非 JSON 行
        }
      });
    },
    // 支持 system prompt 参数
    supportsSystemPrompt: true,
    // 支持 --permission-prompt-tool（MCP 权限代理）
    supportsPermissionTool: true,
  },
  trae: {
    command: "trae-cli",
    extraArgs: [],
    // 纯文本输出，直接透传
    parse: (stdout, onText) => {
      stdout.on("data", (chunk) => onText(chunk.toString()));
    },
    // Trae CLI 不支持 system prompt
    supportsSystemPrompt: false,
  },
  codex: {
    command: process.env.CODEX_CLI_COMMAND || "codex",
    extraArgs: [],
    buildArgs: ({ prompt, isResume, sessionId }) => {
      if (isResume) {
        return ["exec", "resume", "--json", sessionId, prompt];
      }
      return ["exec", "--json", prompt];
    },
    // JSONL 输出：提取 agent_message 文本 + thread_id（作为 sessionId 统一概念）
    parse: (stdout, onText, onMeta) => {
      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            // Codex 使用 thread_id，这里映射为 sessionId 以统一概念
            onMeta?.({ sessionId: event.thread_id });
          }
          // 适配 codex exec --json 的输出:
          // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            const text = typeof event.item.text === "string" ? event.item.text : "";
            if (text) onText(text);
          }
        } catch {
          // 忽略非 JSON 行
        }
      });
    },
    // Codex CLI 是否支持 system prompt 不确定，默认关闭
    supportsSystemPrompt: false,
  },
};

// permission-server.js 的绝对路径（用于生成临时 MCP 配置）
const PERMISSION_SERVER_PATH = path.join(__dirname, "permission-server.js");

/**
 * 调用指定的 AI CLI，返回回复文本和 sessionId
 * @param {"claude" | "trae" | "codex"} cli - CLI 名称
 * @param {string} prompt - 提问内容
 * @param {string} [sessionId] - 可选，传入则继续上次对话；不传则创建新会话
 * @param {object} [options]
 * @param {number} [options.timeoutMs=600000] - 无活跃输出超时时间（毫秒），默认 10 分钟
 * @param {boolean} [options.verify=false] - 是否启用暗号验证（幻觉检测）
 * @param {string} [options.browserSessionId] - 浏览器会话 ID（权限代理需要）
 * @param {string} [options.character] - 角色名（权限代理需要）
 * @returns {Promise<{ text: string, sessionId: string, verified?: boolean }>}
 */
function invoke(cli, prompt, sessionId, options = {}) {
  const { timeoutMs = 600_000, verify = false, browserSessionId, character } = options;

  const config = CLI_CONFIG[cli];
  if (!config) {
    return Promise.reject(new Error(`不支持的 CLI: ${cli}，可选: ${Object.keys(CLI_CONFIG).join(", ")}`));
  }

  const isResume = !!sessionId;
  const id = sessionId || randomUUID();

  // 暗号验证：注入 canary + 诚实性指令
  let canary = null;
  let systemPrompt = null;
  let finalPrompt = prompt;
  
  if (verify) {
    canary = randomUUID().slice(0, 6);
    
    // 使用 system prompt 而不是 user prompt
    // 这样可以避免模型把验证指令当作噪音忽略
    systemPrompt = 
      '重要：如果你对答案不确定，请直接说"我不确定"或"我不知道"，不要编造信息。\n' +
      `验证码: ${canary}，请在回答最末尾单独一行输出 VERIFY:${canary}`;
  }

  // 如果 CLI 支持 system prompt 且需要验证，添加 system prompt 参数
  if (verify && config.supportsSystemPrompt) {
    // no-op here, handled below for default args
  } else if (verify && !config.supportsSystemPrompt) {
    // 回退方案：不支持 system prompt 的 CLI，在 user prompt 末尾追加
    finalPrompt = prompt +
      "\n\n---" +
      '\n重要：如果你对答案不确定，请直接说"我不确定"或"我不知道"，不要编造信息。' +
      `\n[验证码: ${canary}，请在回答最末尾单独一行输出 VERIFY:${canary}]`;
  }

  // 通用参数：-p <prompt> + session 参数 + 各 CLI 特有参数
  let args;
  if (typeof config.buildArgs === "function") {
    args = config.buildArgs({
      prompt: finalPrompt,
      isResume,
      sessionId: id,
      verify,
      systemPrompt,
    });
  } else {
    args = [
      "-p", finalPrompt,
      ...(isResume ? ["--resume", id] : ["--session-id", id]),
    ];
    if (verify && config.supportsSystemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
  }
  
  // 添加 CLI 特有参数
  args.push(...config.extraArgs);

  // ── 权限代理：为支持的 CLI 注入 MCP permission-prompt-tool ──
  let tmpMcpConfig = null;
  const permissionServerPort = process.env.PORT || "3000";

  if (config.supportsPermissionTool && browserSessionId) {
    // 生成临时 MCP 配置文件
    const mcpConfig = {
      mcpServers: {
        permission: {
          type: "stdio",
          command: "node",
          args: [PERMISSION_SERVER_PATH],
          env: {
            PERMISSION_SERVER_PORT: permissionServerPort,
            PERMISSION_BROWSER_SESSION: browserSessionId,
            PERMISSION_CHARACTER: character || "",
          },
        },
      },
    };

    tmpMcpConfig = path.join(os.tmpdir(), `mcp-perm-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(tmpMcpConfig, JSON.stringify(mcpConfig));

    args.push(
      "--mcp-config", tmpMcpConfig,
      "--permission-mode", "delegate"
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeChildren.add(child);

    let result = "";
    let stderr = "";

    // 活跃信号：同时监听 stdout 和 stderr
    // CLI 在 thinking/工具调用时只输出到 stderr，只监听 stdout 会误判超时
    let lastActivity = Date.now();
    const markActive = () => { lastActivity = Date.now(); };
    child.stdout.on("data", markActive);
    child.stderr.on("data", markActive);

    // 定时检查是否超时：先 SIGTERM 优雅终止，5 秒后兜底 SIGKILL
    let killTimer = null;
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > timeoutMs) {
        clearInterval(timer);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!child.killed || child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }
    }, 5000);

    let reportedSessionId = null;
    config.parse(child.stdout, (text) => {
      result += text;
    }, (meta) => {
      if (meta?.sessionId) reportedSessionId = meta.sessionId;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // 清理临时 MCP 配置文件
    const cleanupTmpConfig = () => {
      if (tmpMcpConfig) {
        try { fs.unlinkSync(tmpMcpConfig); } catch { /* ignore */ }
        tmpMcpConfig = null;
      }
    };

    child.on("error", (err) => {
      activeChildren.delete(child);
      clearInterval(timer);
      clearTimeout(killTimer);
      cleanupTmpConfig();
      const errorMsg = `启动 ${config.command} 失败: ${err.message}`;
      if (stderr) {
        console.error(`\n=== 错误详情 ===`);
        console.error(`stderr: ${stderr}`);
        console.error(`stdout: ${result}`);
        console.error(`==================`);
      }
      reject(new Error(errorMsg));
    });

    child.on("close", (code) => {
      activeChildren.delete(child);
      clearInterval(timer);
      clearTimeout(killTimer);
      cleanupTmpConfig();
      if (child.killed) {
        reject(new Error(`${config.command} 超时 (${timeoutMs}ms 无活跃输出)`));
      } else if (code !== 0) {
        const errorMsg = `${config.command} 退出码 ${code}`;
        console.error(`\n=== 错误详情 ===`);
        console.error(`stderr: ${stderr}`);
        console.error(`stdout: ${result}`);
        console.error(`==================`);
        const err = new Error(errorMsg);
        err.stderr = stderr;
        err.exitCode = code;
        reject(err);
      } else if (canary) {
        const verified = new RegExp(`VERIFY:${canary}\\s*$`).test(result);
        const text = result.replace(/\n?VERIFY:\w+\s*$/, "").trimEnd();
        resolve({ text, sessionId: reportedSessionId || id, verified });
      } else {
        resolve({ text: result, sessionId: reportedSessionId || id });
      }
    });
  });
}

module.exports = { invoke };

// 直接运行:
//   node invoke.js <claude|trae|codex> "你的问题"                              — 新会话
//   node invoke.js <claude|trae|codex> "你的问题" <sessionId>                  — 继续对话
//   node invoke.js <claude|trae|codex> "你的问题" <sessionId> '{"verify":true}'  — 带选项
if (require.main === module) {
  const [cli, prompt, sessionId, optionsStr] = process.argv.slice(2);
  if (!cli || !prompt) {
    console.error('用法: node invoke.js <claude|trae|codex> "你的问题" [sessionId] [options]');
    console.error('示例:');
    console.error('  node invoke.js claude "你好"');
    console.error('  node invoke.js claude "你好" "session-id-123"');
    console.error('  node invoke.js claude "你好" "" \'{"verify":true}\'');
    process.exit(1);
  }

  let options = {};
  if (optionsStr) {
    try {
      options = JSON.parse(optionsStr);
    } catch (err) {
      console.error(`错误: 无法解析 options JSON: ${err.message}`);
      process.exit(1);
    }
  }

  invoke(cli, prompt, sessionId, options)
    .then((r) => {
      console.log(r.text);
      console.error(`\n[sessionId: ${r.sessionId}]`);
      if (r.verified !== undefined) {
        console.error(`[verified: ${r.verified}]`);
      }
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
