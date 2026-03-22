const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { buildSkillTypeInjection } = require("./skill-loader");
const { getCodexRoleCardMetrics } = require("./lib/codex-metrics");
const { resolveCliInvocation } = require("./lib/cli-invocation");

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
    permissionStyle: "mcp-config-file",
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
    // 通过全局注册的 permission MCP server + invoke 级 env 继承
    supportsPermissionTool: true,
    permissionStyle: "global-mcp",
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
    // 指标从 lib/codex-metrics.js 统一获取（见 close 事件处理）
    parse: (stdout, onText, onMeta) => {
      const rl = createInterface({ input: stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            onMeta?.({ sessionId: event.thread_id });
          }
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            const text = typeof event.item.text === "string" ? event.item.text : "";
            if (text) onText(text);
          }
        } catch {
          // 忽略非 JSON 行
        }
      });
    },
    // Codex CLI 不支持 system prompt，回退到 user prompt
    supportsSystemPrompt: false,
    // 通过 codex mcp add/remove 动态管理 MCP 服务器
    supportsPermissionTool: true,
    permissionStyle: "codex-mcp-cli",
  },
};

// permission-server.js 的绝对路径（用于生成临时 MCP 配置）
const PERMISSION_SERVER_PATH = path.join(__dirname, "permission-server.js");

// MCP 代理工具名列表（与 permission-server.js 注册的 10 个工具对应）
const MCP_TOOL_NAMES = [
  "mcp__permission__Bash",
  "mcp__permission__Read",
  "mcp__permission__Edit",
  "mcp__permission__Write",
  "mcp__permission__Glob",
  "mcp__permission__Grep",
  "mcp__permission__WebFetch",
  "mcp__permission__WebSearch",
  "mcp__permission__NotebookEdit",
  "mcp__permission__SendMessage",
];

// Trae CLI: 内置工具名列表（需要通过 --disallowed-tool 禁用）
const TRAE_BUILTIN_TOOLS = [
  "Bash", "BashOutput", "KillShell",
  "Edit", "Write", "Read",
  "Glob", "Grep", "LS",
];

const TRAE_CONFIG_PATH = path.join(os.homedir(), ".trae", "trae_cli.yaml");

function toTomlString(value) {
  return JSON.stringify(String(value));
}

function toTomlStringArray(values) {
  return `[${values.map((value) => toTomlString(value)).join(", ")}]`;
}

function buildPermissionEnv(permissionServerPort, browserSessionId, character = "", workingDirectory = "") {
  return {
    PERMISSION_SERVER_PORT: String(permissionServerPort),
    PERMISSION_BROWSER_SESSION: browserSessionId,
    PERMISSION_CHARACTER: character,
    PERMISSION_WORKING_DIRECTORY: workingDirectory,
  };
}

function buildPermissionServerConfig(permissionServerPort, browserSessionId, character = "", workingDirectory = "") {
  return {
    type: "stdio",
    command: "node",
    args: [PERMISSION_SERVER_PATH],
    // Claude CLI 启动 MCP 子进程时不会自动把 invoke env 透传下去，这里必须显式声明。
    env: buildPermissionEnv(permissionServerPort, browserSessionId, character, workingDirectory),
  };
}

function getCliInvocation(cli, args) {
  const config = CLI_CONFIG[cli];
  return resolveCliInvocation(config.command, args);
}

function buildPerInvokePermissionOverrides(permissionConfig) {
  return [
    "-c", `mcp_servers.permission.type=${toTomlString(permissionConfig.type)}`,
    "-c", `mcp_servers.permission.command=${toTomlString(permissionConfig.command)}`,
    "-c", `mcp_servers.permission.args=${toTomlStringArray(permissionConfig.args)}`,
    "-c", `mcp_servers.permission.env.PERMISSION_SERVER_PORT=${toTomlString(permissionConfig.env.PERMISSION_SERVER_PORT)}`,
    "-c", `mcp_servers.permission.env.PERMISSION_BROWSER_SESSION=${toTomlString(permissionConfig.env.PERMISSION_BROWSER_SESSION)}`,
    "-c", `mcp_servers.permission.env.PERMISSION_CHARACTER=${toTomlString(permissionConfig.env.PERMISSION_CHARACTER)}`,
    "-c", `mcp_servers.permission.env.PERMISSION_WORKING_DIRECTORY=${toTomlString(permissionConfig.env.PERMISSION_WORKING_DIRECTORY)}`,
  ];
}

function buildTraePermissionRegistrationConfig() {
  return {
    type: "stdio",
    command: "node",
    args: [PERMISSION_SERVER_PATH],
    // Trae 官方支持 env:{} 继承父进程环境变量，动态上下文由 invoke() 注入
    env: {},
  };
}

function hasTraePermissionRegistration(configText) {
  return typeof configText === "string" && configText.includes("name: permission");
}

function preparePermissionTransport(cli, { browserSessionId, character = "", workingDirectory = "", permissionServerPort }) {
  const config = CLI_CONFIG[cli];
  if (!config?.supportsPermissionTool || !browserSessionId) {
    return { args: [], cleanupPaths: [] };
  }

  const permissionConfig = buildPermissionServerConfig(
    permissionServerPort,
    browserSessionId,
    character,
    workingDirectory
  );

  if (config.permissionStyle === "mcp-config-file") {
    const mcpConfig = {
      mcpServers: {
        permission: permissionConfig,
      },
    };
    const tmpMcpConfig = path.join(os.tmpdir(), `mcp-perm-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(tmpMcpConfig, JSON.stringify(mcpConfig));
    return {
      args: [
        "--mcp-config", tmpMcpConfig,
        "--tools", "",
        "--allowedTools", MCP_TOOL_NAMES.join(","),
      ],
      cleanupPaths: [tmpMcpConfig],
    };
  }

  if (config.permissionStyle === "global-mcp") {
    return {
      args: buildTraePermissionArgs(),
      cleanupPaths: [],
    };
  }

  if (config.permissionStyle === "codex-mcp-cli") {
    return {
      args: buildPerInvokePermissionOverrides(permissionConfig),
      cleanupPaths: [],
    };
  }

  return { args: [], cleanupPaths: [] };
}

function recordSkillInjection(skillDecision, type, injection) {
  if (!skillDecision) return;
  if (!skillDecision.trace) skillDecision.trace = {};
  if (!skillDecision.trace.injectedByType) skillDecision.trace.injectedByType = {};
  skillDecision.trace.injectedByType[type] = {
    ids: injection.injected,
    totalChars: injection.totalChars,
  };
  if (!Array.isArray(skillDecision.trace.skipped)) {
    skillDecision.trace.skipped = [];
  }
  for (const skipped of injection.skipped || []) {
    skillDecision.trace.skipped.push(skipped);
  }
}

/**
 * 构建 Trae CLI 的权限代理参数
 * 通过 --disallowed-tool 禁用内置工具 + --allowed-tool 预授权 MCP 工具
 */
function buildTraePermissionArgs() {
  return [
    // 禁用所有内置可执行工具，强制模型使用 MCP 代理工具
    ...TRAE_BUILTIN_TOOLS.flatMap(name => ["--disallowed-tool", name]),
    // 预授权所有 MCP 代理工具，避免 Trae 弹出内部权限确认
    ...MCP_TOOL_NAMES.flatMap(name => ["--allowed-tool", name]),
  ];
}

/**
 * 服务启动时统一注册 Trae / Codex 的 MCP permission 服务器。
 * 只需调用一次，进程退出时由 cleanupMcpRegistrations() 清理。
 *
 * @param {string} port — Express 服务端口
 */
function initMcpRegistrations(port) {
  const { execFileSync } = require("child_process");

  try {
    const existingConfig = fs.existsSync(TRAE_CONFIG_PATH)
      ? fs.readFileSync(TRAE_CONFIG_PATH, "utf-8")
      : "";
    if (hasTraePermissionRegistration(existingConfig)) {
      console.log("[MCP] Trae permission server 已存在，跳过注册");
    } else {
      execFileSync(
        CLI_CONFIG.trae.command,
        ["mcp", "add-json", "permission", JSON.stringify(buildTraePermissionRegistrationConfig())],
        { stdio: "ignore" }
      );
      console.log("[MCP] Trae permission server 已注册（env 继承自 invoke）");
    }
  } catch (err) {
    console.warn(`[MCP] Trae 注册跳过: ${err.message}`);
  }

  try {
    const codexInvocation = getCliInvocation("codex", ["mcp", "remove", "permission"]);
    try { execFileSync(codexInvocation.command, codexInvocation.args, { stdio: "ignore" }); } catch { /* ignore */ }
  } catch (err) {
    console.warn(`[MCP] Codex 注册跳过: ${err.message}`);
  }
}

/**
 * 服务关闭时清理 Trae / Codex 的 MCP 注册
 */
function cleanupMcpRegistrations() {
  const { execFileSync } = require("child_process");
  // Codex: mcp remove
  try {
    const codexInvocation = getCliInvocation("codex", ["mcp", "remove", "permission"]);
    execFileSync(codexInvocation.command, codexInvocation.args, { stdio: "ignore" });
  } catch { /* ignore */ }
}

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
 * @param {string|number} [options.permissionServerPort] - 权限服务端口（权限代理需要）
 * @returns {Promise<{ text: string, sessionId: string, verified?: boolean }>}
 */
function invoke(cli, prompt, sessionId, options = {}) {
  const {
    timeoutMs = 600_000,
    verify = false,
    browserSessionId,
    character,
    model,
    permissionServerPort = process.env.PORT || "3000",
    workingDirectory = "",
    signal,
    skillDecision = null,
    onRuntimeEvent = null,
  } = options;

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

  // MCP 工具代理提示：告知模型必须使用 MCP Server 提供的工具
  const mcpHint = (config.supportsPermissionTool && browserSessionId)
    ? '\n\n你的所有工具操作（Bash、Read、Edit、Write、Glob、Grep、WebFetch、WebSearch、NotebookEdit、SendMessage）' +
      '均由 MCP Server "permission" 提供。' +
      '请直接使用这些工具完成任务，工具名称格式为 mcp__permission__<工具名>。' +
      '内置工具已被禁用，不要尝试使用内置工具。' +
      '你的最终对外回复必须调用 mcp__permission__SendMessage 发送，不要直接输出正文。' +
      '调用 SendMessage 成功后，本轮任务即结束；工具返回(如“消息已发送/发送失败”)只是工具执行结果，不是需要回复的系统消息。' +
      '若 SendMessage 返回失败，请根据错误原因修正参数后再尝试发送；成功后不要再次调用 SendMessage。' +
      '每次被召唤(单次 invoke)最多只能成功发送一条消息。' +
      '如需召唤其他角色，请在 SendMessage 的 atTargets 参数中显式给出角色名列表。' +
        '调用 Bash 时优先传 cwd 参数，不要使用 cd /path && command 这种形式。'
    : null;

  // Skill 注入：只消费请求入口已经决策好的 skillDecision
  const toolingInjection = (config.supportsPermissionTool && browserSessionId)
    ? buildSkillTypeInjection(skillDecision?.toolingSkills || [])
    : { content: "", injected: [], skipped: [], totalChars: 0 };
  const globalConstraintInjection = buildSkillTypeInjection(skillDecision?.globalConstraintSkills || []);
  recordSkillInjection(skillDecision, "tooling", toolingInjection);
  recordSkillInjection(skillDecision, "global_constraint", globalConstraintInjection);

  const combinedMcpHint = mcpHint
    ? mcpHint + toolingInjection.content
    : null;

  if (combinedMcpHint) {
    if (config.supportsSystemPrompt) {
      systemPrompt = systemPrompt ? systemPrompt + combinedMcpHint : combinedMcpHint.trimStart();
    } else {
      finalPrompt += combinedMcpHint;
    }
  }

  // global_constraint 类 Skill 注入到 systemPrompt
  if (globalConstraintInjection.content) {
    if (config.supportsSystemPrompt) {
      systemPrompt = systemPrompt
        ? systemPrompt + globalConstraintInjection.content
        : globalConstraintInjection.content.trimStart();
    } else {
      finalPrompt += globalConstraintInjection.content;
    }
  }

  // 不支持 system prompt 的 CLI：回退到 user prompt 末尾追加验证指令
  if (verify && !config.supportsSystemPrompt) {
    finalPrompt += "\n\n---" +
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
    // 有 system prompt 就注入（验证指令 + MCP 工具提示）
    if (systemPrompt && config.supportsSystemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
  }
  
  // 添加 CLI 特有参数
  args.push(...config.extraArgs);

  // ── 模型覆盖：按角色注入模型参数 ──
  if (model) {
    if (cli === "trae") {
      args.push("-c", `model.name=${model}`);
    }
    // claude / codex 暂不支持运行时模型切换，预留扩展位
  }

  // ── 权限代理：MCP 工具代理（禁用内置工具，全部走 MCP Server 审批+执行）──
  // 所有 CLI 都在单次 invoke 内注入独立的 permission server 配置，避免并发串号
  const cleanupPaths = [];
  const permissionEnv = buildPermissionEnv(
    permissionServerPort,
    browserSessionId || "",
    character || "",
    workingDirectory || ""
  );

  if (config.supportsPermissionTool && browserSessionId) {
    const preparedPermission = preparePermissionTransport(cli, {
      browserSessionId,
      character: character || "",
      workingDirectory: workingDirectory || "",
      permissionServerPort,
    });
    args.push(...preparedPermission.args);
    cleanupPaths.push(...preparedPermission.cleanupPaths);
  }

  return new Promise((resolve, reject) => {
    // 构建进程环境变量：注入角色上下文，解决并发 invoke 串号问题
    const childEnv = {
      ...process.env,
    };
    if (config.supportsPermissionTool && browserSessionId) {
      Object.assign(childEnv, permissionEnv);
    }

    const cliInvocation = getCliInvocation(cli, args);
    const child = spawn(cliInvocation.command, cliInvocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    activeChildren.add(child);

    let result = "";
    let stderr = "";
    let aborted = false; // signal 提前终止标记

    // signal 支持：外部可通过 AbortSignal 提前终止 CLI 进程
    if (signal) {
      const onAbort = () => {
        if (child.exitCode !== null) return; // 已退出，忽略
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3000);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

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

    const cleanupPermissionArtifacts = () => {
      while (cleanupPaths.length > 0) {
        const filePath = cleanupPaths.pop();
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    };

    child.on("error", (err) => {
      activeChildren.delete(child);
      clearInterval(timer);
      clearTimeout(killTimer);
      cleanupPermissionArtifacts();
      const errorMsg = `启动 ${config.command} 失败: ${err.message}`;
      if (stderr) {
        console.error(`\n=== 错误详情 ===`);
        console.error(`stderr: ${stderr}`);
        console.error(`stdout: ${result}`);
        console.error(`==================`);
      }
      reject(new Error(errorMsg));
    });

    child.on("close", async (code) => {
      activeChildren.delete(child);
      clearInterval(timer);
      clearTimeout(killTimer);
      cleanupPermissionArtifacts();

      // Codex: 通过 lib/codex-metrics.js 获取完整角色卡片指标
      // rate limits 走 app-server，thread token usage 走 local-fallback
      if (cli === "codex" && reportedSessionId && onRuntimeEvent) {
        try {
          const allMetrics = await getCodexRoleCardMetrics(reportedSessionId);
          const data = {};
          if (allMetrics.supportsUsageWindows != null) {
            data.supportsUsageWindows = allMetrics.supportsUsageWindows;
          }
          if (allMetrics.supportsTokenUsage != null) {
            data.supportsTokenUsage = allMetrics.supportsTokenUsage;
          }
          if (allMetrics.primaryUsedPercent != null) {
            data.primaryUsedPercent = allMetrics.primaryUsedPercent;
          }
          if (allMetrics.secondaryUsedPercent != null) {
            data.secondaryUsedPercent = allMetrics.secondaryUsedPercent;
          }
          if (allMetrics.primaryResetsAt != null) {
            data.primaryResetsAt = allMetrics.primaryResetsAt;
          }
          if (allMetrics.secondaryResetsAt != null) {
            data.secondaryResetsAt = allMetrics.secondaryResetsAt;
          }
          if (allMetrics.contextTokens != null) {
            data.contextTokens = allMetrics.contextTokens;
          }
          if (allMetrics.totalTokens != null) {
            data.totalTokens = allMetrics.totalTokens;
          }
          if (allMetrics.modelContextWindow != null) {
            data.modelContextWindow = allMetrics.modelContextWindow;
          }
          if (allMetrics.contextCompactedAt != null) {
            data.contextCompactedAt = allMetrics.contextCompactedAt;
          }
          if (Object.keys(data).length > 0) {
            onRuntimeEvent({ type: "metrics", sessionId: null, timestamp: Date.now(), data });
          }
        } catch { /* ignore metrics errors */ }
      }

      if (aborted) {
        // 被 signal 提前终止 — 正常 resolve（消息已通过 MCP SendMessage 发出）
        if (canary) {
          const verified = new RegExp(`VERIFY:${canary}\\s*$`).test(result);
          const text = result.replace(/\n?VERIFY:\w+\s*$/, "").trimEnd();
          resolve({ text, sessionId: reportedSessionId || id, verified });
        } else {
          resolve({ text: result, sessionId: reportedSessionId || id });
        }
      } else if (child.killed) {
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

module.exports = {
  invoke,
  initMcpRegistrations,
  cleanupMcpRegistrations,
  __test: {
    preparePermissionTransport,
    buildPermissionEnv,
    buildPerInvokePermissionOverrides,
    buildTraePermissionRegistrationConfig,
    hasTraePermissionRegistration,
    buildPermissionServerConfig,
    resolveCliInvocation,
  },
};

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
