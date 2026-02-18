const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { invoke } = require("./invoke");

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, "chat-logs");

// ── 角色配置 ──────────────────────────────────────────────
const CHARACTERS = {
  Faker: { cli: "claude", avatar: "F" },
  奇迹哥: { cli: "trae", avatar: "奇" },
};

// ── 状态管理 ──────────────────────────────────────────────
// browserSessionId:cli -> CLI 返回的真实 sessionId
const cliSessions = new Map();
// browserSessionId:cli -> Promise 链（串行队列）
const invokeQueues = new Map();
// browserSessionId -> Set<Response>（SSE 客户端）
const sseClients = new Map();

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

    enqueueInvoke(sessionId, config.cli, prompt, (result) => {
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
function enqueueInvoke(browserSessionId, cli, prompt, onResult, onError) {
  const key = `${browserSessionId}:${cli}`;
  const prev = invokeQueues.get(key) || Promise.resolve();

  const next = prev.then(async () => {
    const cliSessionId = cliSessions.get(key);
    try {
      const result = await invoke(cli, prompt, cliSessionId || undefined, { verify: true });
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
app.listen(PORT, () => {
  console.log(`AI Chat Arena 已启动: http://localhost:${PORT}`);
});
