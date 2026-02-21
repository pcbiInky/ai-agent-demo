const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { invoke, initMcpRegistrations, cleanupMcpRegistrations } = require("./invoke");

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, "chat-logs");

// ── 角色配置 ──────────────────────────────────────────────
const CHARACTERS = {
  Faker: { cli: "claude", avatar: "F" },
  奇迹哥: { cli: "trae", avatar: "奇" },
  YYF: { cli: "codex", avatar: "Y" },
};

// ── 状态管理 ──────────────────────────────────────────────
// browserSessionId:cli -> CLI 返回的真实 sessionId
const cliSessions = new Map();
// browserSessionId:cli -> Promise 链（串行队列）
const invokeQueues = new Map();
// browserSessionId -> Set<Response>（SSE 客户端）
const sseClients = new Map();
// requestId -> { resolve, timer, data }（等待用户审批的权限请求）
const pendingPermissions = new Map();

const { isSafeBashCommand, shouldAutoAllowPermission } = require("./safe-command");

// ── 中间件 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── API: 角色列表 ─────────────────────────────────────────
app.get("/api/characters", (_req, res) => {
  const result = {};
  for (const [name, config] of Object.entries(CHARACTERS)) {
    result[name] = { cli: config.cli, avatar: config.avatar };
  }
  res.json({ characters: result });
});

// ── API: SSE 事件流 ───────────────────────────────────────
app.get("/api/events", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(sessionId)?.delete(res);
  });
});

function emitSSE(sessionId, event, data) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  for (const res of clients) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ── API: 权限请求（MCP permission-server 调用）─────────────
// 长轮询：MCP server POST 权限请求 → 存入 pending → SSE 通知前端 → 等待用户响应
const PERMISSION_TIMEOUT_MS = 120_000; // 120 秒用户无操作则自动拒绝

app.post("/api/permission-request", (req, res) => {
  const { toolName, toolUseId, input, browserSessionId, character, timestamp } = req.body;

  if (!toolUseId || !browserSessionId) {
    return res.status(400).json({ behavior: "deny", message: "缺少必要参数" });
  }

  const requestId = toolUseId; // 使用 tool_use_id 作为唯一标识

  console.log(`[权限请求] ${character || "unknown"} → ${toolName} (${requestId})`);

  if (shouldAutoAllowPermission(toolName, input)) {
    console.log(`[权限自动通过] ${toolName} (${requestId})`);
    // 先发 permission 事件让前端创建卡片（用户能看到 AI 在做什么）
    emitSSE(browserSessionId, "permission", {
      requestId,
      character: character || "unknown",
      toolName,
      input,
      timestamp: timestamp || Date.now(),
    });
    // 紧接着发 resolved 事件，前端会将卡片标记为自动通过的极简样式
    emitSSE(browserSessionId, "permission-resolved", {
      requestId,
      behavior: "allow",
      message: "安全命令默认授权",
    });
    return res.json({ behavior: "allow", message: "安全命令默认授权" });
  }

  // 通过 SSE 通知前端
  emitSSE(browserSessionId, "permission", {
    requestId,
    character: character || "unknown",
    toolName,
    input,
    timestamp: timestamp || Date.now(),
  });

  // 创建一个 Promise，等待前端用户响应
  const permissionPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时自动拒绝
      pendingPermissions.delete(requestId);
      console.log(`[权限超时] ${toolName} (${requestId}) — 自动拒绝`);
      emitSSE(browserSessionId, "permission-resolved", {
        requestId,
        behavior: "deny",
        message: "用户未在时限内响应，自动拒绝",
      });
      resolve({ behavior: "deny", message: "权限请求超时，自动拒绝" });
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(requestId, { resolve, timer, browserSessionId });
  });

  // 等待用户决定后返回给 MCP server
  permissionPromise.then((result) => {
    res.json(result);
  });
});

// ── API: 权限响应（前端用户操作）────────────────────────────
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;

  if (!requestId || !behavior) {
    return res.status(400).json({ error: "requestId 和 behavior 不能为空" });
  }

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    return res.status(404).json({ error: "权限请求不存在或已过期" });
  }

  // 清除超时定时器
  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);

  console.log(`[权限响应] ${requestId} → ${behavior}`);

  // 通知前端权限已处理
  emitSSE(pending.browserSessionId, "permission-resolved", {
    requestId,
    behavior,
    message: message || (behavior === "allow" ? "已允许" : "已拒绝"),
  });

  // 返回给 MCP server
  pending.resolve({
    behavior,
    ...(message && { message }),
  });

  res.json({ ok: true });
});

// ── API: 发送消息 ─────────────────────────────────────────
app.post("/api/chat", (req, res) => {
  const { text, sessionId } = req.body;
  if (!text || !sessionId) {
    return res.status(400).json({ error: "text 和 sessionId 不能为空" });
  }

  const mentions = parseMentions(text);
  if (mentions.length === 0) {
    return res.status(400).json({
      error: "未找到有效的 @mention，可用角色: " + Object.keys(CHARACTERS).join(", "),
    });
  }

  const messageId = crypto.randomUUID();

  // 保存用户消息
  appendToLog(sessionId, {
    id: messageId,
    role: "user",
    text,
    mentions: mentions.map((m) => m.character),
    timestamp: Date.now(),
  });

  // 立即返回，后台异步处理
  res.json({ messageId, mentions });

  // 对每个 @mention 触发 invoke
  for (const { character, prompt } of mentions) {
    const config = CHARACTERS[character];

    emitSSE(sessionId, "thinking", { character, messageId });

    enqueueInvoke(sessionId, config.cli, prompt, character, (result) => {
      emitSSE(sessionId, "reply", {
        character,
        messageId,
        text: result.text,
        ...(result.verified !== undefined && { verified: result.verified }),
      });

      appendToLog(sessionId, {
        id: crypto.randomUUID(),
        role: "assistant",
        character,
        text: result.text,
        replyTo: messageId,
        timestamp: Date.now(),
        ...(result.verified !== undefined && { verified: result.verified }),
      });
    }, (err) => {
      emitSSE(sessionId, "error", {
        character,
        messageId,
        error: err.message,
      });

      appendToLog(sessionId, {
        id: crypto.randomUUID(),
        role: "error",
        character,
        error: err.message,
        replyTo: messageId,
        timestamp: Date.now(),
      });
    });
  }
});

// ── API: 聊天历史 ─────────────────────────────────────────
app.get("/api/history", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId 不能为空" });

  const filePath = path.join(LOG_DIR, `${sessionId}.json`);
  try {
    const log = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.json(log);
  } catch {
    res.json({ sessionId, createdAt: Date.now(), messages: [] });
  }
});

// ── API: 所有会话列表 ─────────────────────────────────────
app.get("/api/sessions", (_req, res) => {
  ensureLogDir();
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".json"));
  const sessions = files.map((f) => {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), "utf-8"));
      const lastMsg = log.messages[log.messages.length - 1];
      return {
        sessionId: log.sessionId,
        createdAt: log.createdAt,
        lastMessageAt: lastMsg?.timestamp || log.createdAt,
        messageCount: log.messages.length,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  sessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  res.json({ sessions });
});

// ── @mention 解析 ─────────────────────────────────────────
function parseMentions(text) {
  const names = Object.keys(CHARACTERS).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`@(${escaped.join("|")})`, "g");

  const positions = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    positions.push({
      character: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const mentions = [];
  for (let i = 0; i < positions.length; i++) {
    const promptStart = positions[i].end;
    const promptEnd = i + 1 < positions.length ? positions[i + 1].start : text.length;
    const prompt = text.slice(promptStart, promptEnd).trim();
    if (prompt.length > 0) {
      mentions.push({ character: positions[i].character, prompt });
    }
  }

  return mentions;
}

// ── invoke 串行队列 ───────────────────────────────────────
function enqueueInvoke(browserSessionId, cli, prompt, character, onResult, onError) {
  const key = `${browserSessionId}:${cli}`;
  const prev = invokeQueues.get(key) || Promise.resolve();

  const next = prev.then(async () => {
    const cliSessionId = cliSessions.get(key);
    try {
      const result = await invoke(cli, prompt, cliSessionId || undefined, {
        verify: true,
        browserSessionId,
        character,
      });
      cliSessions.set(key, result.sessionId);
      onResult(result);
    } catch (err) {
      onError(err);
    }
  });

  invokeQueues.set(key, next);
}

// ── 聊天记录持久化 ────────────────────────────────────────
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendToLog(sessionId, message) {
  ensureLogDir();
  const filePath = path.join(LOG_DIR, `${sessionId}.json`);

  let log;
  try {
    log = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    log = { sessionId, createdAt: Date.now(), messages: [] };
  }

  log.messages.push(message);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

// ── 启动服务 ──────────────────────────────────────────────
// 服务启动时统一注册 Trae / Codex 的 MCP permission 服务器
initMcpRegistrations(String(PORT));

// 进程退出时清理 MCP 注册
process.on("SIGINT", () => { cleanupMcpRegistrations(); process.exit(0); });
process.on("SIGTERM", () => { cleanupMcpRegistrations(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`AI Chat Arena 已启动: http://localhost:${PORT}`);
});
