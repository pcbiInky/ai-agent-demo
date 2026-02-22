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

// ── AI 互@ 链式调用限制 ──────────────────────────────────
const MAX_AI_CHAIN_CALLS = 5;  // 每轮用户消息最多触发的 AI→AI 交互次数
const MAX_DEPTH = 2;           // 最大唤醒深度（depth=0: 用户@, depth=1: AI@, depth=2: 被AI@的回复，不能再@）

// ── 状态管理 ──────────────────────────────────────────────
// browserSessionId:cli -> CLI 返回的真实 sessionId
const cliSessions = new Map();
// browserSessionId:cli -> Promise 链（串行队列）
const invokeQueues = new Map();
// browserSessionId -> Set<Response>（SSE 客户端）
const sseClients = new Map();
// requestId -> { resolve, timer, data }（等待用户审批的权限请求）
const pendingPermissions = new Map();
// browserSessionId -> { characterName: displayName }（用户设置的昵称映射）
const sessionNicknames = new Map();
// browserSessionId:character -> messageId（当前正在思考的消息 ID，用于关联权限卡片）
const activeThinking = new Map();

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

  // 查找当前角色正在思考的 messageId，用于前端精确定位 thinking 容器
  const thinkingMessageId = activeThinking.get(`${browserSessionId}:${character}`) || null;

  console.log(`[权限请求] ${character || "unknown"} → ${toolName} (${requestId}) messageId=${thinkingMessageId}`);

  if (shouldAutoAllowPermission(toolName, input)) {
    console.log(`[权限自动通过] ${toolName} (${requestId})`);
    // 先发 permission 事件让前端创建卡片（用户能看到 AI 在做什么）
    emitSSE(browserSessionId, "permission", {
      requestId,
      character: character || "unknown",
      toolName,
      input,
      timestamp: timestamp || Date.now(),
      messageId: thinkingMessageId,
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
    messageId: thinkingMessageId,
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
  const { text, sessionId, nicknames } = req.body;
  if (!text || !sessionId) {
    return res.status(400).json({ error: "text 和 sessionId 不能为空" });
  }

  // 保存用户设置的昵称映射
  if (nicknames && typeof nicknames === "object") {
    sessionNicknames.set(sessionId, nicknames);
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

  // 串行处理每个 @mention，带共享记忆 + AI 互@ 链式唤醒
  const chainCounter = { count: 0 };

  (async () => {
    for (const { character, prompt } of mentions) {
      const config = CHARACTERS[character];
      const contextPrompt = buildContextPrompt(sessionId, prompt, character, { depth: 0 });

      emitSSE(sessionId, "thinking", { character, messageId });
      activeThinking.set(`${sessionId}:${character}`, messageId);

      await new Promise((resolve) => {
        enqueueInvoke(sessionId, config.cli, contextPrompt, character, async (result) => {
          setCharStatus(sessionId, character, "online");
          activeThinking.delete(`${sessionId}:${character}`);
          await processAIChain(sessionId, character, result, messageId, null, 0, chainCounter);
          resolve();
        }, (err) => {
          setCharStatus(sessionId, character, "online");
          activeThinking.delete(`${sessionId}:${character}`);
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
          resolve();
        });
      });
    }
  })();
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

  // 提取每个 @mention 各自的 prompt（到下一个 @mention 之间的文本）
  const mentionsWithPrompt = [];
  const mentionsWithoutPrompt = [];
  // 全局 prompt：最后一个 @mention 之后的文本
  const globalPrompt = positions.length > 0
    ? text.slice(positions[positions.length - 1].end).trim()
    : text.trim();

  for (let i = 0; i < positions.length; i++) {
    const promptStart = positions[i].end;
    const promptEnd = i + 1 < positions.length ? positions[i + 1].start : text.length;
    const prompt = text.slice(promptStart, promptEnd).trim();
    if (prompt.length > 0) {
      mentionsWithPrompt.push({ character: positions[i].character, prompt });
    } else {
      mentionsWithoutPrompt.push({ character: positions[i].character });
    }
  }

  // 没有独立 prompt 的 @mention 共享全局 prompt（无 prompt 时回退到空串，避免丢弃 mention）
  for (const m of mentionsWithoutPrompt) {
    mentionsWithPrompt.push({ character: m.character, prompt: globalPrompt || "" });
  }

  // 按原始出现顺序排序
  const charOrder = positions.map(p => p.character);
  mentionsWithPrompt.sort((a, b) => charOrder.indexOf(a.character) - charOrder.indexOf(b.character));

  // 去重（同一角色只保留第一次出现）
  const seen = new Set();
  const mentions = [];
  for (const m of mentionsWithPrompt) {
    if (!seen.has(m.character)) {
      seen.add(m.character);
      mentions.push(m);
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

// ── 共享记忆：为 AI 构建带上下文的 prompt ─────────────────
function buildContextPrompt(sessionId, prompt, character, { depth = 0, fromCharacter = null } = {}) {
  const logPath = path.join(LOG_DIR, `${sessionId}.json`);
  const characterInfo = Object.entries(CHARACTERS)
    .map(([name, cfg]) => `${name}(${cfg.cli})`)
    .join(", ");

  let recentSummary = "(暂无历史)";
  try {
    const log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
    const recent = log.messages.slice(-8);
    if (recent.length > 0) {
      recentSummary = recent.map(m => {
        const who = m.role === "user" ? "铲屎官" : m.character;
        const content = (m.text || m.error || "").slice(0, 200);
        return `[${who}]: ${content}`;
      }).join("\n");
    }
  } catch { /* 新会话，无历史 */ }

  // AI 互@ 规则提示
  let mentionRules = "";
  if (depth < MAX_DEPTH) {
    mentionRules = `\n\n【AI 互@规则】
如果你认为需要向其他角色提问、求证或讨论，可以在回复中使用 @角色名 来召唤他们。
可用角色: ${characterInfo}
注意: 只在确实有必要时才@其他角色，不要为了展示而@。`;
  } else {
    mentionRules = `\n\n【注意】你是被其他 AI 角色召唤的，请直接回答问题，不要在回复中@其他角色。`;
  }

  // 被 AI 唤醒时的额外说明
  let invokeContext = "";
  if (fromCharacter) {
    invokeContext = `\n\n【召唤上下文】${fromCharacter} 召唤了你，请结合聊天记录上下文回答。`;
  }

  const myConfig = CHARACTERS[character];
  const myCliName = myConfig?.cli || "unknown";

  // 获取用户设置的昵称映射
  const nicknames = sessionNicknames.get(sessionId) || {};
  const myNickname = nicknames[character];
  let nicknameHint = "";
  if (Object.keys(nicknames).length > 0) {
    const mapping = Object.entries(nicknames).map(([k, v]) => `${k} → ${v}`).join(", ");
    nicknameHint = `\n用户给角色设置的昵称: ${mapping}`;
  }

  return `${prompt}

---
【你的身份】
你是 ${character}${myNickname ? `（用户给你的昵称是「${myNickname}」）` : ""}，使用 ${myCliName} CLI。请牢记你的角色名是「${character}」，不要与其他角色混淆。${nicknameHint}

【共享聊天记录】
- 聊天记录文件: ${logPath}
- 格式: JSON { sessionId, createdAt, messages: [{ id, role, character, text, timestamp, threadId?, replyToThread?, aiMentions? }] }
- 参与角色: ${characterInfo}
- 用户昵称: 铲屎官
- 最近消息:
${recentSummary}
如需更早的上下文，可读取上述文件。${mentionRules}${invokeContext}`;
}

// ── AI 回复中的 @mention 检测 ─────────────────────────────
function parseAIMentions(text) {
  const names = Object.keys(CHARACTERS).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`@(${escaped.join("|")})`, "g");

  const found = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

// ── AI 互@ 链式处理 ──────────────────────────────────────
async function processAIChain(sessionId, character, result, messageId, threadId, depth, chainCounter) {
  // 保存 AI 回复
  const replyId = crypto.randomUUID();
  const aiMentions = depth < MAX_DEPTH ? parseAIMentions(result.text).filter(c => c !== character) : [];

  appendToLog(sessionId, {
    id: replyId,
    role: "assistant",
    character,
    text: result.text,
    replyTo: messageId,
    timestamp: Date.now(),
    ...(result.verified !== undefined && { verified: result.verified }),
    ...(threadId && { threadId }),
    ...(depth > 0 && { depth }),
    ...(aiMentions.length > 0 && { aiMentions }),
  });

  // 如果 depth=0 且有 aiMentions，这条消息将成为 thread origin
  // 提前计算 activeThreadId 以便在 SSE 中传递
  const hasAIMentions = aiMentions.length > 0;
  const activeThreadId = threadId || (hasAIMentions ? replyId : null);

  // 回写 threadId 到日志
  if (hasAIMentions && !threadId) {
    updateMessageInLog(sessionId, replyId, { threadId: activeThreadId });
  }

  emitSSE(sessionId, "reply", {
    character,
    messageId,
    replyId,
    text: result.text,
    ...(result.verified !== undefined && { verified: result.verified }),
    ...(activeThreadId && { threadId: activeThreadId }),
    ...(depth > 0 && { depth }),
    ...(hasAIMentions && { aiMentions }),
  });

  // depth 超限或无 mentions 则停止
  if (depth >= MAX_DEPTH || !hasAIMentions) return;

  // 串行处理被 AI @的每个角色
  for (const targetChar of aiMentions) {
    if (chainCounter.count >= MAX_AI_CHAIN_CALLS) {
      emitSSE(sessionId, "system-notice", {
        text: `AI 互动已达上限（${MAX_AI_CHAIN_CALLS} 次），停止自动唤醒`,
        threadId: activeThreadId,
      });
      break;
    }
    chainCounter.count++;

    const targetConfig = CHARACTERS[targetChar];
    const contextPrompt = buildContextPrompt(
      sessionId,
      `${character} 在聊天中提到了你，请查看最近的聊天记录并回应。`,
      targetChar,
      { depth: depth + 1, fromCharacter: character }
    );

    // 通知前端：AI 发起了召唤
    emitSSE(sessionId, "ai-mention", {
      from: character,
      to: targetChar,
      threadId: activeThreadId,
      sourceMessageId: replyId,
    });

    emitSSE(sessionId, "thinking", { character: targetChar, messageId, threadId: activeThreadId });
    activeThinking.set(`${sessionId}:${targetChar}`, messageId);

    // 等待被@角色的回复
    await new Promise((resolve) => {
      enqueueInvoke(sessionId, targetConfig.cli, contextPrompt, targetChar, async (targetResult) => {
        setCharStatus(sessionId, targetChar, "online");
        activeThinking.delete(`${sessionId}:${targetChar}`);
        removeThinking(sessionId, targetChar, messageId);
        await processAIChain(sessionId, targetChar, targetResult, messageId, activeThreadId, depth + 1, chainCounter);
        resolve();
      }, (err) => {
        setCharStatus(sessionId, targetChar, "online");
        activeThinking.delete(`${sessionId}:${targetChar}`);
        removeThinking(sessionId, targetChar, messageId);
        emitSSE(sessionId, "error", { character: targetChar, messageId, error: err.message, threadId: activeThreadId });
        appendToLog(sessionId, {
          id: crypto.randomUUID(),
          role: "error",
          character: targetChar,
          error: err.message,
          replyTo: messageId,
          timestamp: Date.now(),
          threadId: activeThreadId,
          depth: depth + 1,
        });
        resolve();
      });
    });
  }

  // 所有被@的角色回复完后，原始角色做 follow-up（仅 depth=0 时）
  if (depth === 0 && aiMentions.length > 0 && chainCounter.count < MAX_AI_CHAIN_CALLS) {
    chainCounter.count++;
    const followUpPrompt = buildContextPrompt(
      sessionId,
      `你之前在回复中@了其他角色讨论，他们已经回复了。请查看最新的聊天记录，对他们的回复发表你的意见或总结下一步。不要再@其他角色。`,
      character,
      { depth: 1 }
    );

    emitSSE(sessionId, "thinking", { character, messageId, threadId: activeThreadId });
    activeThinking.set(`${sessionId}:${character}`, messageId);

    await new Promise((resolve) => {
      enqueueInvoke(sessionId, CHARACTERS[character].cli, followUpPrompt, character, (followResult) => {
        setCharStatus(sessionId, character, "online");
        activeThinking.delete(`${sessionId}:${character}`);
        removeThinking(sessionId, character, messageId);
        const followId = crypto.randomUUID();
        appendToLog(sessionId, {
          id: followId,
          role: "assistant",
          character,
          text: followResult.text,
          replyTo: messageId,
          timestamp: Date.now(),
          ...(followResult.verified !== undefined && { verified: followResult.verified }),
          threadId: activeThreadId,
          depth: 1,
        });
        emitSSE(sessionId, "reply", {
          character,
          messageId,
          replyId: followId,
          text: followResult.text,
          ...(followResult.verified !== undefined && { verified: followResult.verified }),
          threadId: activeThreadId,
          depth: 1,
        });
        resolve();
      }, (err) => {
        setCharStatus(sessionId, character, "online");
        activeThinking.delete(`${sessionId}:${character}`);
        removeThinking(sessionId, character, messageId);
        emitSSE(sessionId, "error", { character, messageId, error: err.message, threadId: activeThreadId });
        resolve();
      });
    });
  }
}

// ── 辅助：更新已写入的消息字段 ───────────────────────────
function updateMessageInLog(sessionId, msgId, updates) {
  const filePath = path.join(LOG_DIR, `${sessionId}.json`);
  try {
    const log = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const msg = log.messages.find(m => m.id === msgId);
    if (msg) {
      Object.assign(msg, updates);
      fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
    }
  } catch { /* ignore */ }
}

// ── 辅助：SSE 方式的状态通知 ─────────────────────────────
function setCharStatus(sessionId, character, status) {
  emitSSE(sessionId, "status", { character, status });
}

function removeThinking(sessionId, character, messageId) {
  // 前端通过 reply/error 事件自动移除 thinking
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
