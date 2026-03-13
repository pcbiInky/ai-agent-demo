const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { invoke, initMcpRegistrations, cleanupMcpRegistrations } = require("./invoke");
const roleStore = require("./role-system/roles");
const sessionStore = require("./role-system/sessions");
const { ensureRoleSystemInitialized } = require("./role-system/migrations");

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_DIR = path.join(__dirname, "chat-logs");

// ── 角色系统初始化 ────────────────────────────────────────
const legacyNameMap = ensureRoleSystemInitialized();

/**
 * 获取所有活跃角色（未归档），返回 { name -> { cli, avatar, id } } 格式
 * 兼容旧代码中 CHARACTERS 的用法
 */
function getActiveRoles() {
  const roles = roleStore.listRoles();
  const result = {};
  for (const role of roles) {
    result[role.name] = { cli: role.cli, avatar: role.avatar, id: role.id };
  }
  return result;
}

/**
 * 获取所有角色（含归档），同样格式
 */
function getAllRoles() {
  const roles = roleStore.listRoles({ includeArchived: true });
  const result = {};
  for (const role of roles) {
    result[role.name] = { cli: role.cli, avatar: role.avatar, id: role.id, archived: role.archived };
  }
  return result;
}

/**
 * 按角色名查找角色配置（兼容旧消息中的 character 字段）
 */
function getRoleConfig(characterName) {
  const role = roleStore.getRoleByName(characterName) || roleStore.getRoleByAlias(characterName);
  if (role) {
    return {
      cli: role.cli,
      avatar: role.avatar,
      id: role.id,
      name: role.name,
      model: role.model,
      aliases: role.aliases || [],
    };
  }

  const roleId = legacyNameMap[characterName];
  if (roleId) {
    const legacyRole = roleStore.getRoleById(roleId);
    if (legacyRole) {
      return {
        cli: legacyRole.cli,
        avatar: legacyRole.avatar,
        id: legacyRole.id,
        name: legacyRole.name,
        model: legacyRole.model,
        aliases: legacyRole.aliases || [],
      };
    }
  }

  return null;
}

function getSessionMentionableRoles(sessionId, { excludeCharacter = null } = {}) {
  const memberIds = sessionStore.getSessionMembers(sessionId);
  const excludedRoleId = excludeCharacter ? getRoleConfig(excludeCharacter)?.id : null;

  return memberIds
    .map((id) => roleStore.getRoleById(id))
    .filter((role) => role && !role.archived)
    .filter((role) => role.id !== excludedRoleId);
}

function getSessionMentionableNames(sessionId, options) {
  return getSessionMentionableRoles(sessionId, options).map((role) => role.name);
}

function isMentionAllowedInSession(sessionId, characterName, { excludeCharacter = null } = {}) {
  return getSessionMentionableNames(sessionId, { excludeCharacter }).includes(characterName);
}

// ── AI 互@ 链式调用限制 ──────────────────────────────────
const MAX_AI_CHAIN_CALLS = 5;  // 每轮用户消息最多触发的 AI→AI 交互次数
const MAX_DEPTH = 2;           // 最大唤醒深度（depth=0: 用户@, depth=1: AI@, depth=2: 被AI@的回复，不能再@）
const ENFORCE_MCP_SENDMESSAGE = process.env.ENFORCE_MCP_SENDMESSAGE !== "false";

// ── 状态管理 ──────────────────────────────────────────────
// browserSessionId:roleId -> Promise 链（串行队列）
const invokeQueues = new Map();
// browserSessionId -> Set<Response>（SSE 客户端）
const sseClients = new Map();
// requestId -> { resolve, timer, data }（等待用户审批的权限请求）
const pendingPermissions = new Map();
// browserSessionId:character -> messageId（当前正在思考的消息 ID，用于关联权限卡片）
const activeThinking = new Map();
// requestId -> { browserSessionId, character, toolName, expireAt }（已批准的权限请求，一次性消费）
const approvedRequests = new Map();
// browserSessionId:character -> number（该角色在当前会话通过 MCP SendMessage 成功发消息次数）
const mcpSendCounts = new Map();

const { isSafeBashCommand, shouldAutoAllowPermission } = require("./safe-command");

// ── 聊天室成员追踪（委托到 sessionStore）──────────────────
function addSessionMember(sessionId, character) {
  const role = getRoleConfig(character);
  if (role) {
    sessionStore.inviteToSession(sessionId, role.id);
  }
}

function isSessionMember(sessionId, character) {
  const role = getRoleConfig(character);
  if (!role) return false;
  const members = sessionStore.getSessionMembers(sessionId);
  return members.includes(role.id);
}

function getMcpSendCount(sessionId, character) {
  return mcpSendCounts.get(`${sessionId}:${character}`) || 0;
}

function markMcpSend(sessionId, character) {
  const key = `${sessionId}:${character}`;
  const next = getMcpSendCount(sessionId, character) + 1;
  mcpSendCounts.set(key, next);
  return next;
}

// ── 审批记录管理（一次性消费 + TTL）────────────────────────
const APPROVAL_TTL_MS = 30_000; // 30 秒过期

function storeApproval(requestId, browserSessionId, character, toolName) {
  approvedRequests.set(requestId, {
    browserSessionId,
    character,
    toolName,
    expireAt: Date.now() + APPROVAL_TTL_MS,
  });
  // 自动清理过期记录
  setTimeout(() => approvedRequests.delete(requestId), APPROVAL_TTL_MS);
}

function consumeApproval(requestId, requiredToolName) {
  const record = approvedRequests.get(requestId);
  if (!record) return null;
  if (record.expireAt < Date.now()) {
    approvedRequests.delete(requestId);
    return null;
  }
  if (record.toolName !== requiredToolName) return null;
  // 一次性消费
  approvedRequests.delete(requestId);
  return record;
}

// ── 中间件 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── API: 角色列表（兼容旧前端 + 新前端）─────────────────
app.get("/api/characters", (_req, res) => {
  const roles = roleStore.listRoles({ includeArchived: true });
  const result = {};
  for (const role of roles) {
    result[role.name] = { cli: role.cli, avatar: role.avatar, id: role.id, archived: role.archived, model: role.model };
  }
  res.json({ characters: result });
});

// ── API: 角色 CRUD ────────────────────────────────────────
app.get("/api/roles", (_req, res) => {
  const roles = roleStore.listRoles({ includeArchived: true });
  res.json({ roles });
});

app.post("/api/roles", async (req, res) => {
  try {
    const role = await roleStore.createRole(req.body);
    res.json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/roles/:roleId", async (req, res) => {
  try {
    const role = await roleStore.updateRole(req.params.roleId, req.body);
    res.json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/roles/:roleId/archive", async (req, res) => {
  try {
    const role = await roleStore.archiveRole(req.params.roleId);
    res.json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/roles/:roleId/restore", async (req, res) => {
  try {
    const role = await roleStore.restoreRole(req.params.roleId);
    res.json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── API: 会话成员 ─────────────────────────────────────────
app.get("/api/sessions/:sessionId/members", (req, res) => {
  const memberIds = sessionStore.getSessionMembers(req.params.sessionId);
  const members = memberIds.map(id => roleStore.getRoleById(id)).filter(Boolean);
  res.json({ members });
});

app.post("/api/sessions/:sessionId/members/:roleId/invite", (req, res) => {
  const role = roleStore.getRoleById(req.params.roleId);
  if (!role) return res.status(404).json({ error: "角色不存在" });
  if (role.archived) return res.status(400).json({ error: "已归档角色不可邀请" });
  sessionStore.inviteToSession(req.params.sessionId, req.params.roleId);
  res.json({ ok: true });
});

app.delete("/api/sessions/:sessionId/members/:roleId", (req, res) => {
  sessionStore.removeFromSession(req.params.sessionId, req.params.roleId);
  res.json({ ok: true });
});

// ── API: 创建会话（带成员选择）───────────────────────────
app.post("/api/sessions", (req, res) => {
  const { sessionId, memberIds } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId 不能为空" });

  // 默认加入所有未归档角色
  const defaultIds = memberIds || roleStore.listRoles().map(r => r.id);
  sessionStore.getOrCreateSession(sessionId, defaultIds);
  res.json({ ok: true, sessionId });
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

  const permContext = {
    isChatMember: isSessionMember(browserSessionId, character),
  };

  if (shouldAutoAllowPermission(toolName, input, permContext)) {
    console.log(`[权限自动通过] ${toolName} (${requestId})`);
    // 存储审批记录（供 /api/mcp-send-message 校验身份）
    storeApproval(requestId, browserSessionId, character, toolName);
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
    return res.json({ behavior: "allow", message: "安全命令默认授权", requestId });
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

    pendingPermissions.set(requestId, { resolve, timer, browserSessionId, character, toolName });
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

  // 如果批准，存储审批记录（供 /api/mcp-send-message 等后续调用校验身份）
  if (behavior === "allow" && pending.toolName) {
    storeApproval(requestId, pending.browserSessionId, pending.character, pending.toolName);
  }

  // 返回给 MCP server
  pending.resolve({
    behavior,
    ...(message && { message }),
    requestId,
  });

  res.json({ ok: true });
});

// ── API: 发送消息 ─────────────────────────────────────────
app.post("/api/chat", (req, res) => {
  const { text, sessionId } = req.body;
  if (!text || !sessionId) {
    return res.status(400).json({ error: "text 和 sessionId 不能为空" });
  }

  // 确保会话存在（如果是旧会话没有 session 文件，用所有未归档角色初始化）
  const allActiveIds = roleStore.listRoles().map((r) => r.id);
  sessionStore.getOrCreateSession(sessionId, allActiveIds);

  const mentions = parseMentions(text, sessionId);
  if (mentions.length === 0) {
    const mentionableNames = getSessionMentionableNames(sessionId);
    return res.status(400).json({
      error: "未找到有效的 @mention，可用角色: " + mentionableNames.join(", "),
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
      const config = getRoleConfig(character);
      if (!config) continue;
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
function buildMentionPattern(names) {
  if (names.length === 0) return null;
  const escaped = names
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@(${escaped.join("|")})`, "g");
}

function parseMentions(text, sessionId) {
  const names = getSessionMentionableNames(sessionId);
  const pattern = buildMentionPattern(names);
  if (!pattern) return [];

  const positions = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    positions.push({
      character: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const mentionsWithPrompt = [];
  const mentionsWithoutPrompt = [];
  const globalPrompt = positions.length > 0 ? text.slice(positions[positions.length - 1].end).trim() : text.trim();

  for (let i = 0; i < positions.length; i += 1) {
    const promptStart = positions[i].end;
    const promptEnd = i + 1 < positions.length ? positions[i + 1].start : text.length;
    const prompt = text.slice(promptStart, promptEnd).trim();
    if (prompt.length > 0) {
      mentionsWithPrompt.push({ character: positions[i].character, prompt });
    } else {
      mentionsWithoutPrompt.push({ character: positions[i].character });
    }
  }

  for (const mention of mentionsWithoutPrompt) {
    mentionsWithPrompt.push({ character: mention.character, prompt: globalPrompt || "" });
  }

  const charOrder = positions.map((position) => position.character);
  mentionsWithPrompt.sort((a, b) => charOrder.indexOf(a.character) - charOrder.indexOf(b.character));

  const seen = new Set();
  const mentions = [];
  for (const mention of mentionsWithPrompt) {
    if (!seen.has(mention.character)) {
      seen.add(mention.character);
      mentions.push(mention);
    }
  }

  return mentions;
}

// ── invoke 串行队列 ───────────────────────────────────────
function enqueueInvoke(browserSessionId, cli, prompt, character, onResult, onError) {
  const roleConfig = getRoleConfig(character);
  const roleId = roleConfig?.id || character;
  const key = `${browserSessionId}:${roleId}`;
  const prev = invokeQueues.get(key) || Promise.resolve();

  // 模型从角色配置读取
  const model = roleConfig?.model || undefined;
  // 注意：roleStore.getRoleByName 返回完整 role 对象（含 model）
  const fullRole = roleStore.getRoleByName(character);
  const roleModel = fullRole?.model || model;

  const next = prev.then(async () => {
    // 从落盘的 session-context 读取 provider sessionId
    const cliSessionId = sessionStore.getProviderSessionId(browserSessionId, roleId);
    const sendCountBefore = getMcpSendCount(browserSessionId, character);
    try {
      const result = await invoke(cli, prompt, cliSessionId || undefined, {
        verify: true,
        browserSessionId,
        character,
        model: roleModel,
      });
      const sendCountAfter = getMcpSendCount(browserSessionId, character);
      result.usedMcpSendMessage = sendCountAfter > sendCountBefore;
      // 落盘 provider sessionId
      sessionStore.setProviderSessionId(browserSessionId, roleId, result.sessionId);
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
  // 获取当前会话成员的角色信息
  const memberIds = sessionStore.getSessionMembers(sessionId);
  const memberRoles = memberIds.map(id => roleStore.getRoleById(id)).filter(Boolean);
  const characterInfo = memberRoles.length > 0
    ? memberRoles.map(r => `${r.name}(${r.cli})`).join(", ")
    : Object.entries(getActiveRoles()).map(([name, cfg]) => `${name}(${cfg.cli})`).join(", ");

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

  const myConfig = getRoleConfig(character);
  const myCliName = myConfig?.cli || "unknown";

  return `${prompt}

---
【你的身份】
你是 ${character}，使用 ${myCliName} CLI。请牢记你的角色名是「${character}」，不要与其他角色混淆。

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
function parseAIMentions(text, sessionId, fromCharacter) {
  const pattern = buildMentionPattern(getSessionMentionableNames(sessionId, { excludeCharacter: fromCharacter }));
  if (!pattern) return [];

  const found = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

// ── AI 互@ 统一调度 ──────────────────────────────────────
/**
 * 统一的 AI 召唤调度函数，processAIChain 和 /api/mcp-send-message 共用。
 * 负责：串行 invoke 被召唤角色 → 等待回复 → 递归处理 → follow-up。
 * @param {string} sessionId - 浏览器会话 ID
 * @param {string} fromCharacter - 发起召唤的角色
 * @param {string[]} aiMentions - 被召唤的角色列表（已去重、已排除 self）
 * @param {string} messageId - 原始用户消息 ID（reply 的锚点）
 * @param {string} threadId - 线程 ID
 * @param {number} depth - 当前深度
 * @param {object} chainCounter - { count: number } 共享计数器
 * @param {string} sourceMessageId - 触发召唤的消息 ID（用于 ai-mention 事件）
 */
async function dispatchAIMentions(sessionId, fromCharacter, aiMentions, messageId, threadId, depth, chainCounter, sourceMessageId) {
  for (const targetChar of aiMentions) {
    if (chainCounter.count >= MAX_AI_CHAIN_CALLS) {
      emitSSE(sessionId, "system-notice", {
        text: `AI 互动已达上限（${MAX_AI_CHAIN_CALLS} 次），停止自动唤醒`,
        threadId,
      });
      break;
    }
    chainCounter.count++;

    const targetConfig = getRoleConfig(targetChar);
    if (!targetConfig) continue;
    const contextPrompt = buildContextPrompt(
      sessionId,
      `${fromCharacter} 在聊天中提到了你，请查看最近的聊天记录并回应。`,
      targetChar,
      { depth: depth + 1, fromCharacter }
    );

    // 通知前端：AI 发起了召唤
    emitSSE(sessionId, "ai-mention", {
      from: fromCharacter,
      to: targetChar,
      threadId,
      sourceMessageId,
    });

    emitSSE(sessionId, "thinking", { character: targetChar, messageId, threadId });
    activeThinking.set(`${sessionId}:${targetChar}`, messageId);

    // 等待被@角色的回复
    await new Promise((resolve) => {
      enqueueInvoke(sessionId, targetConfig.cli, contextPrompt, targetChar, async (targetResult) => {
        setCharStatus(sessionId, targetChar, "online");
        activeThinking.delete(`${sessionId}:${targetChar}`);
        removeThinking(sessionId, targetChar, messageId);
        await processAIChain(sessionId, targetChar, targetResult, messageId, threadId, depth + 1, chainCounter);
        resolve();
      }, (err) => {
        setCharStatus(sessionId, targetChar, "online");
        activeThinking.delete(`${sessionId}:${targetChar}`);
        removeThinking(sessionId, targetChar, messageId);
        emitSSE(sessionId, "error", { character: targetChar, messageId, error: err.message, threadId });
        appendToLog(sessionId, {
          id: crypto.randomUUID(),
          role: "error",
          character: targetChar,
          error: err.message,
          replyTo: messageId,
          timestamp: Date.now(),
          threadId,
          depth: depth + 1,
        });
        resolve();
      });
    });
  }

  // 所有被@的角色回复完后，原始角色做 follow-up（仅 depth=0 时）
  if (!ENFORCE_MCP_SENDMESSAGE && depth === 0 && aiMentions.length > 0 && chainCounter.count < MAX_AI_CHAIN_CALLS) {
    chainCounter.count++;
    const followUpPrompt = buildContextPrompt(
      sessionId,
      `你之前在回复中@了其他角色讨论，他们已经回复了。请查看最新的聊天记录，对他们的回复发表你的意见或总结下一步。不要再@其他角色。`,
      fromCharacter,
      { depth: 1 }
    );

    emitSSE(sessionId, "thinking", { character: fromCharacter, messageId, threadId });
    activeThinking.set(`${sessionId}:${fromCharacter}`, messageId);

    await new Promise((resolve) => {
      enqueueInvoke(sessionId, getRoleConfig(fromCharacter).cli, followUpPrompt, fromCharacter, (followResult) => {
        setCharStatus(sessionId, fromCharacter, "online");
        activeThinking.delete(`${sessionId}:${fromCharacter}`);
        removeThinking(sessionId, fromCharacter, messageId);
        const followId = crypto.randomUUID();
        appendToLog(sessionId, {
          id: followId,
          role: "assistant",
          character: fromCharacter,
          text: followResult.text,
          replyTo: messageId,
          timestamp: Date.now(),
          ...(followResult.verified !== undefined && { verified: followResult.verified }),
          threadId,
          depth: 1,
        });
        emitSSE(sessionId, "reply", {
          character: fromCharacter,
          messageId,
          replyId: followId,
          text: followResult.text,
          ...(followResult.verified !== undefined && { verified: followResult.verified }),
          threadId,
          depth: 1,
        });
        resolve();
      }, (err) => {
        setCharStatus(sessionId, fromCharacter, "online");
        activeThinking.delete(`${sessionId}:${fromCharacter}`);
        removeThinking(sessionId, fromCharacter, messageId);
        emitSSE(sessionId, "error", { character: fromCharacter, messageId, error: err.message, threadId });
        resolve();
      });
    });
  }
}

// ── AI 互@ 链式处理 ──────────────────────────────────────
async function processAIChain(sessionId, character, result, messageId, threadId, depth, chainCounter) {
  if (ENFORCE_MCP_SENDMESSAGE) {
    if (!result.usedMcpSendMessage) {
      const errorMsg = "协议违规：本轮未通过 mcp__permission__SendMessage 发送消息";
      emitSSE(sessionId, "error", { character, messageId, error: errorMsg, ...(threadId && { threadId }) });
      appendToLog(sessionId, {
        id: crypto.randomUUID(),
        role: "error",
        character,
        error: errorMsg,
        replyTo: messageId,
        timestamp: Date.now(),
        ...(threadId && { threadId }),
        ...(depth > 0 && { depth }),
      });
    }
    return;
  }

  // 保存 AI 回复
  const replyId = crypto.randomUUID();
  const aiMentions = depth < MAX_DEPTH ? parseAIMentions(result.text, sessionId, character) : [];

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

  // 委托统一调度函数处理召唤链
  await dispatchAIMentions(sessionId, character, aiMentions, messageId, activeThreadId, depth, chainCounter, replyId);
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

// ── API: MCP SendMessage（AI 主动向聊天室发消息）───────────
app.post("/api/mcp-send-message", (req, res) => {
  const { text, atTargets, threadId, requestId } = req.body;

  if (!text || !requestId) {
    return res.status(400).json({ error: "text 和 requestId 不能为空" });
  }

  if (text.length > 5000) {
    return res.status(400).json({ error: "消息长度不能超过 5000 字符" });
  }

  // 从已批准的审批记录中获取可信的身份信息（一次性消费 + toolName 绑定）
  const approval = consumeApproval(requestId, "SendMessage");
  if (!approval) {
    return res.status(403).json({ error: "无效、已过期或已使用的审批记录" });
  }

  const { browserSessionId, character } = approval;
  const replyToMessageId = activeThinking.get(`${browserSessionId}:${character}`) || null;
  markMcpSend(browserSessionId, character);
  // 验证角色合法性
  if (!getRoleConfig(character)) {
    return res.status(400).json({ error: `未知角色: ${character}` });
  }

  const messageId = crypto.randomUUID();

  // aiMentions 完全由 atTargets 决定，只允许当前会话成员
  const aiMentions = (atTargets || []).filter(
    (target) => target !== character && isMentionAllowedInSession(browserSessionId, target, { excludeCharacter: character })
  );

  // 确定线程 ID
  const activeThreadId = threadId || (aiMentions.length > 0 ? messageId : null);

  appendToLog(browserSessionId, {
    id: messageId,
    role: "assistant",
    character,
    text,
    ...(replyToMessageId && { replyTo: replyToMessageId }),
    timestamp: Date.now(),
    source: "mcp-tool",
    ...(activeThreadId && { threadId: activeThreadId }),
    ...(aiMentions.length > 0 && { aiMentions }),
  });

  emitSSE(browserSessionId, "reply", {
    character,
    ...(replyToMessageId && { messageId: replyToMessageId }),
    replyId: messageId,
    text,
    source: "mcp-tool",
    ...(activeThreadId && { threadId: activeThreadId }),
    ...(aiMentions.length > 0 && { aiMentions }),
  });

  res.json({ ok: true, messageId });

  // 如果有 atTargets，异步触发 AI 召唤链
  if (aiMentions.length > 0) {
    const chainCounter = { count: 0 };
    // depth=0 表示这是一个新的召唤起点（类似用户 @ 触发的 depth=0）
    dispatchAIMentions(browserSessionId, character, aiMentions, messageId, activeThreadId, 0, chainCounter, messageId)
      .catch(err => console.error(`[mcp-send-message] 召唤链错误: ${err.message}`));
  }
});

function closeServer() {
  cleanupMcpRegistrations();
  if (serverInstance) {
    serverInstance.close();
  }
}

// ── 启动服务 ──────────────────────────────────────────────
// 服务启动时统一注册 Trae / Codex 的 MCP permission 服务器
initMcpRegistrations(String(PORT));

// 进程退出时清理 MCP 注册
process.on("SIGINT", () => { closeServer(); process.exit(0); });
process.on("SIGTERM", () => { closeServer(); process.exit(0); });

const serverInstance = app.listen(PORT, () => {
  const address = serverInstance.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`AI Chat Arena 已启动: http://localhost:${actualPort}`);
});

module.exports = {
  app,
  closeServer,
  __test: {
    roleStore,
    getRoleConfig,
    parseMentions,
    parseAIMentions,
    isMentionAllowedInSession,
    ensureRoleSystemInitializedForTests() {
      ensureRoleSystemInitialized();
      return roleStore.listRoles({ includeArchived: true });
    },
    closeServer,
  },
};
