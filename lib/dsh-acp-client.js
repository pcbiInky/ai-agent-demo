/**
 * DeepSeek Harness (dsh) ACP 客户端
 *
 * dsh 的 ACP profile 是一个长期运行的 JSON-RPC over NDJSON 服务：
 *   dsh --profile acp
 * 通过 stdin/stdout 交换 ACP v1 消息，因此不能走 invoke.js 里
 * "spawn 一次性进程 + 解析 stdout" 的通用路径，需要这一层双向驱动。
 *
 * 一轮调用的生命周期：
 *   initialize -> session/new | session/resume -> (set_config_option) ->
 *   session/prompt -> session/close
 *
 * 关键约束（均由本模块内部处理，调用方无需关心）：
 * - session/resume 要求 cwd 与创建时完全一致，且恢复时必须重新声明 mcpServers，
 *   否则恢复后的会话没有权限工具；resume 失败会自动回退到 session/new。
 * - ACP 没有 system prompt 参数，调用方应把 system prompt 合并进 prompt 文本
 *   （invoke.js 中 dsh 的 supportsSystemPrompt=false 已走该回退）。
 */

"use strict";

const { spawn } = require("child_process");
const { resolveCliInvocation } = require("./cli-invocation");

const PROTOCOL_VERSION = 1;
const DEFAULT_PROFILE = "acp";
const DEFAULT_TIMEOUT_MS = 1800_000;
const CLOSE_GRACE_MS = 3000;

/** 允许的权限选项优先级：本次允许 > 始终允许；都没有就取消。 */
function selectAllowOption(options) {
  if (!Array.isArray(options)) return null;
  return (
    options.find((option) => option?.kind === "allow_once") ||
    options.find((option) => option?.kind === "allow_always") ||
    null
  );
}

/**
 * 把角色配置里的模型名解析成 dsh 广告的 select value。
 * dsh 的模型 value 是 JSON 元组字符串，例如 '["deepseek-official","deepseek-v4-flash"]'，
 * 角色配置里既可能写完整元组，也可能只写 'deepseek-v4-flash'，两种都接受。
 *
 * @param {Array} configOptions - session/new 返回的配置项
 * @param {string} model - 角色配置里的模型名
 * @returns {string|null} 可直接传给 set_config_option 的 value
 */
function resolveModelValue(configOptions, model) {
  if (!model) return null;
  const modelOption = (configOptions || []).find((option) => option?.id === "model");
  if (!modelOption) return null;

  const allOptions = (modelOption.options || []).flatMap((group) => group?.options || []);
  if (allOptions.some((option) => option.value === model)) return model;

  const byName = allOptions.find((option) => option.name === model);
  if (byName) return byName.value;

  const byTupleMember = allOptions.find((option) => {
    try {
      return JSON.parse(option.value).includes(model);
    } catch {
      return false;
    }
  });
  return byTupleMember ? byTupleMember.value : model;
}

/**
 * 启动 dsh ACP agent 并完成一轮对话。
 *
 * @param {object} params
 * @param {string} params.prompt - 用户消息（已包含各 CLI 通用的提示拼接）
 * @param {string} [params.sessionId] - 传入则优先 resume，失败回退新建
 * @param {string} params.cwd - 会话工作目录，resume 时必须与创建时一致
 * @param {Array} [params.mcpServers] - ACP 格式的 MCP 服务器声明
 * @param {string} [params.model] - 模型名或元组字符串
 * @param {string} [params.command="dsh"] - dsh 可执行文件
 * @param {string} [params.profile="acp"] - dsh profile
 * @param {number} [params.timeoutMs] - 无活跃输出超时
 * @param {AbortSignal} [params.signal] - 外部终止
 * @param {object} [params.env] - 子进程环境变量
 * @param {function} [params.onText] - 增量文本回调
 * @param {function} [params.onEvent] - 结构化事件回调（sessionId / tool_call 等）
 * @returns {Promise<{text: string, sessionId: string, resumed: boolean, stderr: string}>}
 */
function invokeDshAcp({
  prompt,
  sessionId,
  cwd,
  mcpServers = [],
  model,
  command = "dsh",
  profile = DEFAULT_PROFILE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  env,
  onText,
  onEvent,
} = {}) {
  return new Promise((resolve, reject) => {
    const invocation = resolveCliInvocation(command, ["--profile", profile]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: env || process.env,
    });

    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    let buffer = "";
    let stderr = "";
    let text = "";
    let activeSessionId = null;
    let resumed = false;
    let settled = false;
    let lastActivity = Date.now();

    function markActive() {
      lastActivity = Date.now();
    }

    function send(message) {
      if (child.stdin.destroyed) return;
      child.stdin.write(JSON.stringify(message) + "\n");
    }

    function emit(event) {
      if (typeof onEvent === "function") onEvent(event);
    }

    /** 发送一个请求并等待同 id 的响应。 */
    function request(method, params) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
        send({ jsonrpc: "2.0", id, method, params });
      });
    }

    /** agent -> client 的请求：权限一律允许一次，文件读写给最小实现。 */
    function handleReverseRequest(message) {
      const { method, params } = message;
      if (method === "session/request_permission") {
        const option = selectAllowOption(params?.options);
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
        return;
      }
      if (method === "fs/read_text_file") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: "" } });
        return;
      }
      if (method === "fs/write_text_file") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `客户端未实现 ${method}` },
      });
    }

    function handleNotification(message) {
      if (message.method !== "session/update") return;
      const update = message.params?.update || {};
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content?.type === "text" && typeof update.content.text === "string") {
          text += update.content.text;
          if (typeof onText === "function") onText(update.content.text);
        }
        return;
      }
      emit({ type: "session_update", sessionId: message.params?.sessionId ?? null, update });
    }

    function handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (!entry) return;
        if (message.error) {
          const error = new Error(`${entry.method} 失败: ${JSON.stringify(message.error)}`);
          error.rpcError = message.error;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }

      if (message.method && message.id !== undefined) {
        handleReverseRequest(message);
        return;
      }

      if (message.method) handleNotification(message);
    }

    child.stdout.on("data", (chunk) => {
      markActive();
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      markActive();
      stderr += chunk.toString();
    });

    // 无活跃输出超时：与其它 CLI 语义一致
    const timer = setInterval(() => {
      if (Date.now() - lastActivity <= timeoutMs) return;
      const error = new Error(`${command} 超时 (${timeoutMs}ms 无活跃输出)`);
      cancelAndReject(error);
    }, 5000);

    function cancelAndReject(error) {
      if (settled) return;
      settled = true;
      if (activeSessionId) {
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: activeSessionId } });
      }
      cleanup(error);
    }

    function onAbort() {
      cancelAndReject(Object.assign(new Error("dsh invoke 已中止"), { aborted: true }));
    }

    if (signal) {
      if (signal.aborted) {
        // 已中止：延迟到 spawn 完成后走同一条清理路径
        setImmediate(onAbort);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    function cleanup(error) {
      clearInterval(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      for (const entry of pending.values()) {
        entry.reject(error || new Error("dsh 连接已关闭"));
      }
      pending.clear();
      try { child.stdin.end(); } catch { /* ignore */ }
      // 给 session/close 一点时间，再由调用方兜底 SIGKILL
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, CLOSE_GRACE_MS);
      }, 100);
      if (error) reject(error);
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`启动 ${command} 失败: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const error = new Error(`${command} 退出码 ${code}`);
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });

    /** resume 失败（cwd 不匹配 / 会话不可用）时回退新建，保证本轮仍然可用。 */
    async function createOrResumeSession() {
      const base = { cwd: cwd || process.cwd(), mcpServers };
      if (sessionId) {
        try {
          const result = await request("session/resume", { sessionId, ...base });
          activeSessionId = sessionId;
          resumed = true;
          emit({ type: "session", sessionId, resumed: true });
          return result;
        } catch (error) {
          emit({ type: "session_resume_failed", sessionId, error: error.message });
        }
      }
      const created = await request("session/new", base);
      activeSessionId = created.sessionId;
      resumed = false;
      emit({ type: "session", sessionId: created.sessionId, resumed: false });
      return created;
    }

    (async () => {
      try {
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const session = await createOrResumeSession();

        const modelValue = resolveModelValue(session.configOptions, model);
        if (modelValue) {
          try {
            await request("session/set_config_option", {
              sessionId: activeSessionId,
              configId: "model",
              value: modelValue,
            });
          } catch (error) {
            // 模型设置失败不应让整轮失败，退回默认模型
            emit({ type: "model_set_failed", sessionId: activeSessionId, model: modelValue, error: error.message });
          }
        }

        await request("session/prompt", {
          sessionId: activeSessionId,
          prompt: [{ type: "text", text: prompt || "" }],
        });

        await request("session/close", { sessionId: activeSessionId }).catch(() => { /* 忽略关闭失败 */ });

        clearInterval(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        settled = true;
        child.stdin.end();
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }, 100);
        resolve({ text, sessionId: activeSessionId, resumed, stderr });
      } catch (error) {
        if (settled) return;
        settled = true;
        if (activeSessionId) {
          await request("session/close", { sessionId: activeSessionId }).catch(() => { /* ignore */ });
        }
        error.stderr = stderr;
        error.sessionId = activeSessionId || sessionId || null;
        cleanup();
        reject(error);
      }
    })();
  });
}

module.exports = {
  invokeDshAcp,
  resolveModelValue,
  selectAllowOption,
  PROTOCOL_VERSION,
  DEFAULT_PROFILE,
};
