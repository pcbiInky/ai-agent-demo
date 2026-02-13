const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { randomUUID } = require("crypto");

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
  },
  trae: {
    command: "trae-cli",
    extraArgs: [],
    // 纯文本输出，直接透传
    parse: (stdout, onText) => {
      stdout.on("data", (chunk) => onText(chunk.toString()));
    },
  },
};

/**
 * 调用指定的 AI CLI，返回回复文本和 sessionId
 * @param {"claude" | "trae"} cli - CLI 名称
 * @param {string} prompt - 提问内容
 * @param {string} [sessionId] - 可选，传入则继续上次对话；不传则创建新会话
 * @returns {Promise<{ text: string, sessionId: string }>}
 */
function invoke(cli, prompt, sessionId) {
  const config = CLI_CONFIG[cli];
  if (!config) {
    return Promise.reject(new Error(`不支持的 CLI: ${cli}，可选: ${Object.keys(CLI_CONFIG).join(", ")}`));
  }

  const isResume = !!sessionId;
  const id = sessionId || randomUUID();

  // 通用参数：-p <prompt> + session 参数 + 各 CLI 特有参数
  const args = [
    "-p", prompt,
    ...(isResume ? ["--resume", id] : ["--session-id", id]),
    ...config.extraArgs,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let result = "";
    let stderr = "";

    config.parse(child.stdout, (text) => {
      result += text;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`启动 ${config.command} 失败: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${config.command} 退出码 ${code}\n${stderr}`));
      } else {
        resolve({ text: result, sessionId: id });
      }
    });
  });
}

module.exports = { invoke };

// 直接运行:
//   node invoke.js <claude|trae> "你的问题"                  — 新会话
//   node invoke.js <claude|trae> "你的问题" <sessionId>      — 继续对话
if (require.main === module) {
  const [cli, prompt, sessionId] = process.argv.slice(2);
  if (!cli || !prompt) {
    console.error('用法: node invoke.js <claude|trae> "你的问题" [sessionId]');
    process.exit(1);
  }

  invoke(cli, prompt, sessionId)
    .then((r) => {
      console.log(r.text);
      console.error(`\n[sessionId: ${r.sessionId}]`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
