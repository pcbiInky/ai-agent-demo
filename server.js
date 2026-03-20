const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { invoke, initMcpRegistrations, cleanupMcpRegistrations } = require("./invoke");
const roleStore = require("./role-system/roles");
const sessionStore = require("./role-system/sessions");
const { ensureRoleSystemInitialized } = require("./role-system/migrations");
const {
  loadSkills,
  printSkillStartupLog,
  getSkillConfig,
  getAllSkills,
  getSkillDetailById,
  buildSkillTypeInjection,
} = require("./skill-loader");
const { resolveRequestSkills } = require("./skill-router");

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
function normalizeWorkingDirectory(input) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  const resolved = path.resolve(trimmed);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error("工作目录不存在");
  }
  if (!stat.isDirectory()) throw new Error("工作目录必须是目录");
  return resolved;
}

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
// 所有 CLI 统一走 MCP SendMessage 发消息（不再支持非 MCP fallback 的旧路径）

// ── 状态管理 ──────────────────────────────────────────────
// browserSessionId:roleId -> Promise 链（串行队列）
const invokeQueues = new Map();
// browserSessionId -> Set<Response>（SSE 客户端）
const sseClients = new Map();
// requestId -> { resolve, timer, data }（等待用户审批的权限请求）
const pendingPermissions = new Map();
// browserSessionId:character -> messageId（当前正在思考的消息 ID，用于关联权限卡片）
const activeThinking = new Map();
// requestId -> { browserSessionId, character, toolName, replyToMessageId, expireAt }（已批准的权限请求，一次性消费）
const approvedRequests = new Map();
// browserSessionId:roleId -> AbortController（当前 invoke 的提前终止控制器）
const invokeAbortControllers = new Map();
// browserSessionId:character -> number（该角色在当前会话通过 MCP SendMessage 成功发消息次数）
const mcpSendCounts = new Map();
// browserSessionId:character -> messageId（当前 invoke 期间最近一次通过 MCP SendMessage 发出的消息）
const pendingMcpReplies = new Map();
// browserSessionId:character -> { depth, threadId, lineage }
// 当前 invoke 的链路上下文：所在线程、当前深度，以及从主线到当前节点的角色路径
const invokeChainCallers = new Map();
// browserSessionId:character（当前 invoke 是否已成功使用过一次 SendMessage）
const invokeSendGuards = new Set();
// sessionId:parentCharacter -> queued child return events waiting to re-invoke parent
const parentReturnQueues = new Map();
// sessionId:parentCharacter -> active drain promise
const parentReturnProcessors = new Map();
// sessionId -> 最近的 Skill 路由命中记录
const recentSkillTraces = new Map();
const MAX_SKILL_TRACE_PER_SESSION = 20;

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

function getPendingMcpReplyKey(sessionId, character) {
  return `${sessionId}:${character}`;
}

function getInvokeSendGuardKey(sessionId, character) {
  return `${sessionId}:${character}`;
}

function resetInvokeSendGuard(sessionId, character) {
  invokeSendGuards.delete(getInvokeSendGuardKey(sessionId, character));
}

function consumeInvokeSendQuota(sessionId, character) {
  const key = getInvokeSendGuardKey(sessionId, character);
  if (invokeSendGuards.has(key)) return false;
  invokeSendGuards.add(key);
  return true;
}

function releaseInvokeSendQuota(sessionId, character) {
  invokeSendGuards.delete(getInvokeSendGuardKey(sessionId, character));
}

function getActiveThinkingKey(sessionId, character) {
  return `${sessionId}:${character}`;
}

function setActiveThinking(sessionId, character, messageId, threadId = null) {
  if (!messageId) return;
  emitSSE(sessionId, "thinking", {
    character,
    messageId,
    ...(threadId && { threadId }),
  });
  activeThinking.set(getActiveThinkingKey(sessionId, character), messageId);
}

function clearActiveThinking(sessionId, character, messageId = null) {
  const key = getActiveThinkingKey(sessionId, character);
  if (messageId && activeThinking.get(key) !== messageId) return;
  activeThinking.delete(key);
}

function registerPendingMcpReply(sessionId, character, messageId) {
  pendingMcpReplies.set(getPendingMcpReplyKey(sessionId, character), messageId);
}

function clearPendingMcpReply(sessionId, character) {
  pendingMcpReplies.delete(getPendingMcpReplyKey(sessionId, character));
}

function extractVerifyMeta(text) {
  const rawText = typeof text === "string" ? text : String(text || "");
  const matched = /\n?VERIFY:(\w+)\s*$/.test(rawText);
  if (!matched) {
    return { text: rawText, verified: undefined };
  }

  return {
    text: rawText.replace(/\n?VERIFY:\w+\s*$/, "").trimEnd(),
    verified: true,
  };
}

function finalizePendingMcpVerification(sessionId, character, verified) {
  if (verified === undefined) return;

  const key = getPendingMcpReplyKey(sessionId, character);
  const messageId = pendingMcpReplies.get(key);
  if (!messageId) return;

  let effectiveVerified = verified;
  const filePath = path.join(LOG_DIR, `${sessionId}.json`);
  try {
    const log = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const msg = log.messages.find((item) => item.id === messageId);
    if (msg?.verified === true && verified === false) {
      effectiveVerified = true;
    }
  } catch {
    // ignore and fall back to invoke result
  }

  updateMessageInLog(sessionId, messageId, { verified: effectiveVerified });
  emitSSE(sessionId, "message-meta", { messageId, verified: effectiveVerified });
  pendingMcpReplies.delete(key);
}

// ── 审批记录管理（一次性消费 + TTL）────────────────────────
const APPROVAL_TTL_MS = 30_000; // 30 秒过期

function storeApproval(requestId, browserSessionId, character, toolName, replyToMessageId) {
  approvedRequests.set(requestId, {
    browserSessionId,
    character,
    toolName,
    replyToMessageId,
    expireAt: Date.now() + APPROVAL_TTL_MS,
  });
  // 自动清理过期记录
  setTimeout(() => approvedRequests.delete(requestId), APPROVAL_TTL_MS);
}

function buildPermissionLogEntry({
  requestId,
  character,
  toolName,
  input,
  timestamp,
  messageId,
  status = "pending",
  resolutionMessage,
}) {
  return {
    id: requestId,
    role: "permission",
    requestId,
    character: character || "unknown",
    toolName,
    input,
    timestamp: timestamp || Date.now(),
    messageId: messageId || null,
    status,
    ...(resolutionMessage ? { resolutionMessage } : {}),
  };
}

function appendPermissionToLog(sessionId, payload) {
  appendToLog(sessionId, buildPermissionLogEntry(payload));
}

function updatePermissionInLog(sessionId, requestId, updates) {
  updateMessageInLog(sessionId, requestId, updates);
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

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessionStore.getOrCreateSession(req.params.sessionId);
  const memberIds = sessionStore.getSessionMembers(req.params.sessionId);
  const members = memberIds.map(id => roleStore.getRoleById(id)).filter(Boolean);
  res.json({ session, members });
});

app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const updates = {};
    if (typeof req.body.title === "string") updates.title = req.body.title;
    if (typeof req.body.workingDirectory === "string") {
      updates.workingDirectory = normalizeWorkingDirectory(req.body.workingDirectory);
    }
    const session = sessionStore.updateSessionMeta(req.params.sessionId, updates);
    res.json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/system/select-directory", (req, res) => {
  if (process.platform !== "darwin") {
    return res.status(501).json({ error: "当前系统不支持原生目录选择，请手动输入路径" });
  }
  try {
    const { execFileSync } = require("child_process");
    const selected = execFileSync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择工作目录")',
    ], { encoding: "utf-8" }).trim();
    const workingDirectory = normalizeWorkingDirectory(selected);
    res.json({ workingDirectory });
  } catch (err) {
    const message = String(err.message || "");
    if (message.includes("User canceled") || message.includes("(-128)")) {
      return res.status(400).json({ error: "用户取消了目录选择" });
    }
    res.status(500).json({ error: "打开系统目录选择失败" });
  }
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
  const thinkingMessageId = activeThinking.get(getActiveThinkingKey(browserSessionId, character)) || null;

  console.log(`[权限请求] ${character || "unknown"} → ${toolName} (${requestId}) messageId=${thinkingMessageId}`);

  const permContext = {
    isChatMember: isSessionMember(browserSessionId, character),
    workingDirectory: sessionStore.readSession(browserSessionId)?.workingDirectory || "",
  };

  if (shouldAutoAllowPermission(toolName, input, permContext)) {
    console.log(`[权限自动通过] ${toolName} (${requestId})`);
    // 存储审批记录（供 /api/mcp-send-message 校验身份）
    storeApproval(requestId, browserSessionId, character, toolName, thinkingMessageId);
    appendPermissionToLog(browserSessionId, {
      requestId,
      character,
      toolName,
      input,
      timestamp,
      messageId: thinkingMessageId,
      status: "allow",
      resolutionMessage: "安全命令默认授权",
    });
    // 先发 permission 事件让前端创建卡片（用户能看到 AI 在做什么）
    emitSSE(browserSessionId, "permission", {
      requestId,
      character: character || "unknown",
      toolName,
      input,
      timestamp: timestamp || Date.now(),
      messageId: thinkingMessageId,
      status: "allow",
      resolutionMessage: "安全命令默认授权",
    });
    // 紧接着发 resolved 事件，前端会将卡片标记为自动通过的极简样式
    emitSSE(browserSessionId, "permission-resolved", {
      requestId,
      behavior: "allow",
      message: "安全命令默认授权",
    });
    return res.json({ behavior: "allow", message: "安全命令默认授权", requestId });
  }

  appendPermissionToLog(browserSessionId, {
    requestId,
    character,
    toolName,
    input,
    timestamp,
    messageId: thinkingMessageId,
  });

  // 通过 SSE 通知前端
  emitSSE(browserSessionId, "permission", {
    requestId,
    character: character || "unknown",
    toolName,
    input,
    timestamp: timestamp || Date.now(),
    messageId: thinkingMessageId,
    status: "pending",
  });

  // 创建一个 Promise，等待前端用户响应
  const permissionPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时自动拒绝
      pendingPermissions.delete(requestId);
      console.log(`[权限超时] ${toolName} (${requestId}) — 自动拒绝`);
      updatePermissionInLog(browserSessionId, requestId, {
        status: "deny",
        resolutionMessage: "用户未在时限内响应，自动拒绝",
      });
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

  const resolutionMessage = message || (behavior === "allow" ? "已允许" : "已拒绝");
  updatePermissionInLog(pending.browserSessionId, requestId, {
    status: behavior,
    resolutionMessage,
  });

  // 通知前端权限已处理
  emitSSE(pending.browserSessionId, "permission-resolved", {
    requestId,
    behavior,
    message: resolutionMessage,
  });

  // 如果批准，存储审批记录（供 /api/mcp-send-message 等后续调用校验身份）
  if (behavior === "allow" && pending.toolName) {
    const thinkingMsgId = activeThinking.get(getActiveThinkingKey(pending.browserSessionId, pending.character)) || null;
    storeApproval(requestId, pending.browserSessionId, pending.character, pending.toolName, thinkingMsgId);
  }

  // 返回给 MCP server
  pending.resolve({
    behavior,
    ...(resolutionMessage && { message: resolutionMessage }),
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
  const userTimestamp = Date.now();

  // 保存用户消息
  appendToLog(sessionId, {
    id: messageId,
    role: "user",
    text,
    mentions: mentions.map((m) => m.character),
    timestamp: userTimestamp,
  });

  // 立即返回，后台异步处理
  res.json({ messageId, mentions, timestamp: userTimestamp });

  // 串行处理每个 @mention，带共享记忆 + AI 互@ 链式唤醒
  const chainCounter = { count: 0 };

  (async () => {
    for (const { character, prompt } of mentions) {
      const config = getRoleConfig(character);
      if (!config) continue;
      const skillDecision = buildSkillDecision(sessionId, prompt, character);
      const contextPrompt = buildContextPrompt(sessionId, prompt, character, {
        depth: 0,
        skillDecision,
      });

      await new Promise((resolve) => {
        enqueueInvoke(sessionId, config.cli, contextPrompt, character, async (result) => {
          setCharStatus(sessionId, character, "online");
          await processAIChain(sessionId, character, result, messageId, null, 0, chainCounter);
          resolve();
        }, (err) => {
          setCharStatus(sessionId, character, "online");
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
        }, {
          skillDecision,
          thinkingMessageId: messageId,
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
      const sessionMeta = sessionStore.readSession(log.sessionId);
        return {
          sessionId: log.sessionId,
          title: sessionMeta?.title || "新对话",
          workingDirectory: sessionMeta?.workingDirectory || "",
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
function enqueueInvoke(browserSessionId, cli, prompt, character, onResult, onError, options = {}) {
  const {
    skillDecision = null,
    invokeContext = null,
    thinkingMessageId = null,
    thinkingThreadId = null,
  } = options;
  const roleConfig = getRoleConfig(character);
  const roleId = roleConfig?.id || character;
  const key = `${browserSessionId}:${roleId}`;
  const prev = invokeQueues.get(key) || Promise.resolve();

  // 模型从角色配置读取
  const model = roleConfig?.model || undefined;
  // 注意：roleStore.getRoleByName 返回完整 role 对象（含 model）
  const fullRole = roleStore.getRoleByName(character);
  const roleModel = fullRole?.model || model;

  const abortController = new AbortController();
  invokeAbortControllers.set(key, abortController);

  const next = prev.then(async () => {
    // 从落盘的 session-context 读取 provider sessionId
    const cliSessionId = sessionStore.getProviderSessionId(browserSessionId, roleId);
    const sendCountBefore = getMcpSendCount(browserSessionId, character);
    clearPendingMcpReply(browserSessionId, character);
    resetInvokeSendGuard(browserSessionId, character);
    setActiveThinking(browserSessionId, character, thinkingMessageId, thinkingThreadId);
    // 在串行队列内绑定 invoke 上下文，确保不会被并发覆盖
    const chainKey = `${browserSessionId}:${character}`;
    if (invokeContext) {
      invokeChainCallers.set(chainKey, invokeContext);
    } else {
      invokeChainCallers.delete(chainKey);
    }
    try {
      const workingDirectory = sessionStore.readSession(browserSessionId)?.workingDirectory || "";
      const result = await invoke(cli, prompt, cliSessionId || undefined, {
        verify: true,
        browserSessionId,
        character,
        model: roleModel,
        permissionServerPort: String(PORT),
        workingDirectory,
        signal: abortController.signal,
        skillDecision,
      });
      const sendCountAfter = getMcpSendCount(browserSessionId, character);
      result.usedMcpSendMessage = sendCountAfter > sendCountBefore;
      if (result.usedMcpSendMessage) {
        finalizePendingMcpVerification(browserSessionId, character, result.verified);
      }
      // 落盘 provider sessionId
      sessionStore.setProviderSessionId(browserSessionId, roleId, result.sessionId);
      recordSkillTrace(browserSessionId, skillDecision, "ok");
      clearActiveThinking(browserSessionId, character, thinkingMessageId);
      onResult(result);
      resetInvokeSendGuard(browserSessionId, character);
    } catch (err) {
      clearPendingMcpReply(browserSessionId, character);
      recordSkillTrace(browserSessionId, skillDecision, "error");
      resetInvokeSendGuard(browserSessionId, character);
      clearActiveThinking(browserSessionId, character, thinkingMessageId);
      onError(err);
    } finally {
      invokeAbortControllers.delete(key);
      invokeChainCallers.delete(chainKey);
    }
  });

  invokeQueues.set(key, next);
}

function buildInvokeContext(character, threadId, depth, lineage) {
  return {
    depth,
    threadId,
    lineage: Array.isArray(lineage) && lineage.length > 0 ? lineage : [character],
  };
}

function getParentFrame(invokeContext) {
  const lineage = Array.isArray(invokeContext?.lineage) ? invokeContext.lineage : [];
  if (lineage.length <= 1) return null;
  return {
    character: lineage[lineage.length - 2],
    depth: Math.max(0, Number(invokeContext?.depth || 0) - 1),
    lineage: lineage.slice(0, -1),
    threadId: invokeContext?.threadId || null,
  };
}

function getParentReturnQueueKey(sessionId, parentCharacter) {
  const parentRole = getRoleConfig(parentCharacter);
  return `${sessionId}:${parentRole?.id || parentCharacter}`;
}

function enqueueParentReturnEvent(event) {
  if (!event?.sessionId || !event?.parentCharacter || !event?.childMessageId) return;

  const normalizedEvent = {
    sessionId: event.sessionId,
    parentCharacter: event.parentCharacter,
    fromCharacter: event.fromCharacter,
    threadId: event.threadId || null,
    parentMessageId: event.parentMessageId || null,
    childMessageId: event.childMessageId,
    depth: Number(event.depth || 0),
    lineage: Array.isArray(event.lineage) ? [...event.lineage] : [event.parentCharacter],
  };

  const key = getParentReturnQueueKey(
    normalizedEvent.sessionId,
    normalizedEvent.parentCharacter
  );
  const queue = parentReturnQueues.get(key) || [];
  queue.push(normalizedEvent);
  parentReturnQueues.set(key, queue);

  if (!parentReturnProcessors.has(key)) {
    const drainPromise = drainParentReturnQueue(
      normalizedEvent.sessionId,
      normalizedEvent.parentCharacter
    ).catch((err) => {
      console.error(`[parent-return-queue] ${normalizedEvent.parentCharacter}: ${err.message}`);
    }).finally(() => {
      parentReturnProcessors.delete(key);
    });

    parentReturnProcessors.set(key, drainPromise);
  }
}

function shiftParentReturnEvent(sessionId, parentCharacter) {
  const key = getParentReturnQueueKey(sessionId, parentCharacter);
  const queue = parentReturnQueues.get(key) || [];
  const event = queue.shift() || null;
  if (queue.length > 0) {
    parentReturnQueues.set(key, queue);
  } else {
    parentReturnQueues.delete(key);
  }
  return event;
}

function buildParentReturnSourcePrompt(event) {
  return [
    "【回归事件】",
    `来自: ${event.fromCharacter}`,
    `threadId: ${event.threadId || "(none)"}`,
    `childMessageId: ${event.childMessageId}`,
    `parentMessageId: ${event.parentMessageId || "(none)"}`,
    "请优先查看这次子回复，再继续主线。",
  ].join("\n");
}

async function dispatchParentFollowUpFromEvent(event) {
  if (!event) return;

  const parentConfig = getRoleConfig(event.parentCharacter);
  if (!parentConfig) return;

  const followUpSourcePrompt = buildParentReturnSourcePrompt(event);
  const followUpSkillDecision = buildSkillDecision(event.sessionId, followUpSourcePrompt, event.parentCharacter);
  const followUpPrompt = buildContextPrompt(
    event.sessionId,
    followUpSourcePrompt,
    event.parentCharacter,
    {
      depth: event.depth,
      fromCharacter: event.fromCharacter,
      skillDecision: followUpSkillDecision,
    }
  );

  await new Promise((resolve) => {
    enqueueInvoke(event.sessionId, parentConfig.cli, followUpPrompt, event.parentCharacter, async (followResult) => {
      setCharStatus(event.sessionId, event.parentCharacter, "online");
      removeThinking(event.sessionId, event.parentCharacter, event.childMessageId);
      await processAIChain(event.sessionId, event.parentCharacter, followResult, event.childMessageId, event.threadId, event.depth, { count: 0 });
      resolve();
    }, (err) => {
      setCharStatus(event.sessionId, event.parentCharacter, "online");
      removeThinking(event.sessionId, event.parentCharacter, event.childMessageId);
      emitSSE(event.sessionId, "error", { character: event.parentCharacter, messageId: event.childMessageId, error: err.message, threadId: event.threadId });
      appendToLog(event.sessionId, {
        id: crypto.randomUUID(),
        role: "error",
        character: event.parentCharacter,
        error: err.message,
        replyTo: event.childMessageId,
        timestamp: Date.now(),
        ...(event.threadId && { threadId: event.threadId }),
        ...(event.depth > 0 && { depth: event.depth }),
      });
      resolve();
    }, {
      skillDecision: followUpSkillDecision,
      thinkingMessageId: event.childMessageId,
      thinkingThreadId: event.threadId,
      invokeContext: buildInvokeContext(event.parentCharacter, event.threadId, event.depth, event.lineage),
    });
  });
}

async function drainParentReturnQueue(sessionId, parentCharacter) {
  while (true) {
    const event = shiftParentReturnEvent(sessionId, parentCharacter);
    if (!event) return;
    await dispatchParentFollowUpFromEvent(event);
  }
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

function getSkillBindings(skillId) {
  const config = getSkillConfig();
  const roles = Object.entries(config.roles || {})
    .filter(([, skillIds]) => skillIds.includes(skillId))
    .map(([roleName]) => roleName);
  const scenes = Object.entries(config.scenes || {})
    .filter(([, skillIds]) => skillIds.includes(skillId))
    .map(([sceneName]) => sceneName);

  return {
    global: (config.global || []).includes(skillId),
    roles,
    scenes,
  };
}

function buildSkillDecision(sessionId, prompt, character) {
  const roleConfig = getRoleConfig(character);
  const supportsPermissionTool = ["claude", "trae", "codex"].includes(roleConfig?.cli || "");
  const skillDecision = resolveRequestSkills({
    prompt,
    character,
    model: roleConfig?.cli || undefined,  // model_support は CLI タイプ名で比較
    supportsPermissionTool,
  });

  skillDecision.trace = {
    ...skillDecision.trace,
    sessionId,
    character,
    model: roleConfig?.model || "",
    injectedByType: {},
  };

  return skillDecision;
}

function recordSkillTrace(browserSessionId, skillDecision, status) {
  if (!skillDecision?.trace) return;

  const trace = {
    ...skillDecision.trace,
    status,
    timestamp: Date.now(),
    hitSkills: skillDecision.hitSkills.map((skill) => skill.id),
  };

  // trace.sessionId 是聊天会话 ID，前端查询时也用这个 key
  const key = skillDecision.trace.sessionId || browserSessionId;
  const traces = recentSkillTraces.get(key) || [];
  traces.unshift(trace);
  if (traces.length > MAX_SKILL_TRACE_PER_SESSION) {
    traces.length = MAX_SKILL_TRACE_PER_SESSION;
  }
  recentSkillTraces.set(key, traces);

  console.log(
    `[SkillTrace] character=${trace.character} scenes=${trace.matchedScenes.join(",") || "(none)"} hits=${trace.hitSkills.join(",") || "(none)"}`
  );
}

function getSkillTraces(sessionId, limit = MAX_SKILL_TRACE_PER_SESSION) {
  const traces = recentSkillTraces.get(sessionId) || [];
  return traces.slice(0, Math.max(0, limit));
}

// ── 共享记忆：为 AI 构建带上下文的 prompt ─────────────────
function buildContextPrompt(sessionId, prompt, character, { depth = 0, fromCharacter = null, skillDecision = null } = {}) {
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

  // AI 召唤规则提示
  let mentionRules = "";
  if (depth < MAX_DEPTH) {
    mentionRules = `\n\n【AI 召唤规则】
如果你认为需要向其他角色提问、求证或讨论，请通过 mcp__permission__SendMessage 的 atTargets 显式召唤。一轮只能Send一次，请不要重复尝试。收到回复之后会重新召唤你，视作新的一轮。
可用角色: ${characterInfo}
注意: 只在确实有必要时才召唤其他角色；正文里可以提到对方的角色名方便理解。一轮只能Send一次。`;
  } else {
    mentionRules = `\n\n【注意】你是被其他 AI 角色召唤的，请直接回答问题；如无必要，不要再次通过 SendMessage 的 atTargets 召唤其他角色。`;
  }

  // 被 AI 唤醒时的额外说明
  let invokeContext = "";
  if (fromCharacter) {
    invokeContext = depth > 0
      ? `\n\n【召唤上下文】${fromCharacter} 通过 SendMessage 的 atTargets 召唤了你，请结合聊天记录上下文回答。若你想继续召唤下一级角色，请显式填写 atTargets；若你只是回复上一层，请将 atTargets 留空，系统会把消息返回给 ${fromCharacter}。`
      : `\n\n【回归主线】${fromCharacter} 已经回复了你。你现在回到了主线层级：如需继续召唤其他角色，请显式填写 atTargets；若只是继续主线回复，可将 atTargets 留空。`;
  }

  const myConfig = getRoleConfig(character);
  const myCliName = myConfig?.cli || "unknown";
  const sessionMeta = sessionStore.getOrCreateSession(sessionId);
  const workdirNotice = sessionMeta.workingDirectory
    ? `- 会话名称: ${sessionMeta.title}\n- 当前工作目录: ${sessionMeta.workingDirectory}\n- 开发、扫描和文件修改应限制在该目录内\n- 调用 Bash 工具时优先传 cwd 参数，不要使用 cd /path && command\n- 注意：如果系统级 CurrentDirectory 与此处的"当前工作目录"不一致，请以此处的"当前工作目录"为准`
    : `- 会话名称: ${sessionMeta.title}\n- 当前工作目录: (未设置)`;

  // 行为类 Skill 注入
  const behaviorInjection = buildSkillTypeInjection(skillDecision?.behaviorSkills || []);
  if (skillDecision?.trace) {
    skillDecision.trace.injectedByType.behavior = {
      ids: behaviorInjection.injected,
      totalChars: behaviorInjection.totalChars,
    };
    skillDecision.trace.skipped.push(...behaviorInjection.skipped);
  }

  return `${prompt}

---
【你的身份】
你是 ${character}，使用 ${myCliName} CLI。请牢记你的角色名是「${character}」，不要与其他角色混淆。

【共享聊天记录】
- 聊天记录文件: ${logPath}
- 格式: JSON { sessionId, createdAt, messages: [{ id, role, character, text, timestamp, threadId?, replyToThread?, aiMentions? }] }
- 参与角色: ${characterInfo}
- 用户昵称: 铲屎官
- 会话信息:
${workdirNotice}
- 最近消息:
${recentSummary}
如需更早的上下文，可读取上述文件。${mentionRules}${invokeContext}${behaviorInjection.content}`;
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
async function dispatchAIMentions(sessionId, fromCharacter, aiMentions, messageId, threadId, depth, chainCounter, sourceMessageId, lineage = [fromCharacter]) {
  if (depth >= MAX_DEPTH) return;

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
    const targetPrompt = `${fromCharacter} 通过 SendMessage 的 atTargets 召唤了你，请查看最近的聊天记录并回应。`;
    const targetSkillDecision = buildSkillDecision(sessionId, targetPrompt, targetChar);
    const contextPrompt = buildContextPrompt(
      sessionId,
      targetPrompt,
      targetChar,
      { depth: depth + 1, fromCharacter, skillDecision: targetSkillDecision }
    );

    // 通知前端：AI 发起了召唤
    emitSSE(sessionId, "ai-mention", {
      from: fromCharacter,
      to: targetChar,
      threadId,
      sourceMessageId,
    });

    // 等待被@角色的回复（invoke 上下文在队列内绑定，不会被并发覆盖）
    await new Promise((resolve) => {
      enqueueInvoke(sessionId, targetConfig.cli, contextPrompt, targetChar, async (targetResult) => {
        setCharStatus(sessionId, targetChar, "online");
        removeThinking(sessionId, targetChar, messageId);
        await processAIChain(sessionId, targetChar, targetResult, messageId, threadId, depth + 1, chainCounter);
        resolve();
      }, (err) => {
        setCharStatus(sessionId, targetChar, "online");
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
      }, {
        skillDecision: targetSkillDecision,
        thinkingMessageId: messageId,
        thinkingThreadId: threadId,
        invokeContext: buildInvokeContext(targetChar, threadId, depth + 1, [...lineage, targetChar]),
      });
    });
  }
}

async function dispatchReturnToParent(sessionId, fromCharacter, parentFrame, messageId, threadId) {
  if (!parentFrame?.character) return;
  enqueueParentReturnEvent({
    sessionId,
    parentCharacter: parentFrame.character,
    fromCharacter,
    threadId,
    parentMessageId: parentFrame.threadId || threadId,
    childMessageId: messageId,
    depth: parentFrame.depth,
    lineage: parentFrame.lineage,
  });
}

// ── AI 互@ 链式处理 ──────────────────────────────────────
async function processAIChain(sessionId, character, result, messageId, threadId, depth, chainCounter) {
  // 所有 CLI 统一走 MCP SendMessage，invoke 返回后只需校验是否合规
  if (!result.usedMcpSendMessage) {
    const errorMsg = "协议违规：本轮未通过 mcp__permission__SendMessage 发送消息";
    if (result.text) {
      console.error(`[${character}] 协议违规，Invoke 原始输出:\n${result.text}`);
    }
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

  const { browserSessionId, character, replyToMessageId } = approval;
  if (!replyToMessageId) {
    return res.status(409).json({ error: "当前不在可发送的 invoke 上下文" });
  }

  const verifyMeta = extractVerifyMeta(text);
  if (!getRoleConfig(character)) {
    return res.status(400).json({ error: `未知角色: ${character}` });
  }
  if (!consumeInvokeSendQuota(browserSessionId, character)) {
    return res.status(409).json({ error: "同一轮 invoke 只能成功发送一条消息；若首次发送失败，可根据错误原因修正后重试" });
  }

  try {
    markMcpSend(browserSessionId, character);
    const messageId = crypto.randomUUID();
    const mcpTimestamp = Date.now();

    // 链式上下文：
    // - 非空 atTargets: 向下一层召唤（最多 depth=2）
    // - 空 atTargets: 返回上一层父节点
    const chainContext = invokeChainCallers.get(`${browserSessionId}:${character}`) || null;
    const currentDepth = chainContext?.depth || 0;
    const currentLineage = Array.isArray(chainContext?.lineage) ? chainContext.lineage : [character];
    const contextThreadId = threadId || chainContext?.threadId || null;
    const explicitTargets = Array.isArray(atTargets) ? atTargets : [];
    const parentFrame = getParentFrame({
      depth: currentDepth,
      lineage: currentLineage,
      threadId: contextThreadId,
    });
    const shouldReturnToParent = Boolean(parentFrame) && (explicitTargets.length === 0 || currentDepth >= MAX_DEPTH);
    const canDispatchChildren = explicitTargets.length > 0 && currentDepth < MAX_DEPTH;
    const aiMentions = explicitTargets.filter(
      (target) => target !== character && isMentionAllowedInSession(browserSessionId, target, { excludeCharacter: character })
    );
    const effectiveAiMentions = canDispatchChildren ? aiMentions : [];
    const effectiveThreadId = contextThreadId || (effectiveAiMentions.length > 0 ? messageId : null);
    const effectiveDepth = currentDepth;

    appendToLog(browserSessionId, {
      id: messageId,
      role: "assistant",
      character,
      text: verifyMeta.text,
      ...(replyToMessageId && { replyTo: replyToMessageId }),
      timestamp: mcpTimestamp,
      source: "mcp-tool",
      ...(verifyMeta.verified !== undefined && { verified: verifyMeta.verified }),
      ...(effectiveThreadId && { threadId: effectiveThreadId }),
      ...(effectiveDepth > 0 && { depth: effectiveDepth }),
      ...(effectiveAiMentions.length > 0 && { aiMentions: effectiveAiMentions }),
    });

    if (replyToMessageId) {
      registerPendingMcpReply(browserSessionId, character, messageId);
    }

    emitSSE(browserSessionId, "reply", {
      character,
      ...(replyToMessageId && { messageId: replyToMessageId }),
      replyId: messageId,
      text: verifyMeta.text,
      timestamp: mcpTimestamp,
      source: "mcp-tool",
      ...(verifyMeta.verified !== undefined && { verified: verifyMeta.verified }),
      ...(effectiveThreadId && { threadId: effectiveThreadId }),
      ...(effectiveDepth > 0 && { depth: effectiveDepth }),
      ...(effectiveAiMentions.length > 0 && { aiMentions: effectiveAiMentions }),
    });

    res.json({ ok: true, messageId });

    if (canDispatchChildren && effectiveAiMentions.length > 0) {
      const chainCounter = { count: 0 };
      dispatchAIMentions(browserSessionId, character, effectiveAiMentions, messageId, effectiveThreadId, effectiveDepth, chainCounter, messageId, currentLineage)
        .catch(err => console.error(`[mcp-send-message] 召唤链错误: ${err.message}`));
    } else if (shouldReturnToParent) {
      dispatchReturnToParent(browserSessionId, character, parentFrame, messageId, effectiveThreadId)
        .catch(err => console.error(`[mcp-send-message] 父节点回退错误: ${err.message}`));
    }
  } catch (err) {
    releaseInvokeSendQuota(browserSessionId, character);
    return res.status(500).json({ error: `发送失败: ${err.message}` });
  }
});

// ── API: 用户主动终止 AI 角色执行 ─────────────────────────
app.post("/api/abort-invoke", (req, res) => {
  const { browserSessionId, character } = req.body;
  if (!browserSessionId || !character) {
    return res.status(400).json({ error: "缺少 browserSessionId 或 character" });
  }
  const roleConfig = getRoleConfig(character);
  if (!roleConfig) {
    return res.status(400).json({ error: `未知角色: ${character}` });
  }
  const roleId = roleConfig.id || character;
  const abortKey = `${browserSessionId}:${roleId}`;
  const controller = invokeAbortControllers.get(abortKey);
  if (!controller) {
    return res.json({ ok: true, aborted: false, reason: "该角色当前没有活跃的 invoke" });
  }
  controller.abort();
  console.log(`[用户终止] ${character} (${abortKey})`);
  clearActiveThinking(browserSessionId, character);
  emitSSE(browserSessionId, "abort", { character });
  res.json({ ok: true, aborted: true });
});

// ── Skill API（只读）────────────────────────────────────────
app.get("/api/skills", (_req, res) => {
  const skills = getAllSkills().map((skill) => ({
    ...skill,
    bindings: getSkillBindings(skill.id),
  }));
  res.json({ skills, config: getSkillConfig() });
});

app.get("/api/skills/:id", (req, res) => {
  const skill = getSkillDetailById(req.params.id);
  if (!skill) {
    return res.status(404).json({ error: `Skill not found: ${req.params.id}` });
  }
  res.json({
    skill: {
      ...skill,
      bindings: getSkillBindings(skill.id),
    },
  });
});

app.get("/api/sessions/:sessionId/skill-traces", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || MAX_SKILL_TRACE_PER_SESSION), 10);
  res.json({ traces: getSkillTraces(req.params.sessionId, Number.isNaN(limit) ? MAX_SKILL_TRACE_PER_SESSION : limit) });
});

function closeServer() {
  cleanupMcpRegistrations();
  if (serverInstance) {
    serverInstance.close();
  }
}

// ── 启动服务 ──────────────────────────────────────────────
// 加载 Skill 系统
const MCP_TOOL_NAMES = [
  "mcp__permission__Bash", "mcp__permission__Read", "mcp__permission__Edit",
  "mcp__permission__Write", "mcp__permission__Glob", "mcp__permission__Grep",
  "mcp__permission__WebFetch", "mcp__permission__WebSearch", "mcp__permission__NotebookEdit",
];
const { errors: skillErrors } = loadSkills({
  knownMcpTools: MCP_TOOL_NAMES,
  knownRoles: roleStore.listRoles({ includeArchived: true }).map((role) => role.name),
});
printSkillStartupLog();

// Skill Error 级别问题阻断启动
if (skillErrors.length > 0) {
  console.error(`[Skill] 存在 ${skillErrors.length} 个 Error 级别问题，服务启动中止。`);
  process.exit(1);
}

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
    buildContextPrompt,
    buildSkillDecision,
    getSkillBindings,
    getSkillTraces,
    isMentionAllowedInSession,
    appendToLog,
    extractVerifyMeta,
    storeApproval,
    registerPendingMcpReply,
    finalizePendingMcpVerification,
    invokeChainCallers,
    ensureRoleSystemInitializedForTests() {
      ensureRoleSystemInitialized();
      return roleStore.listRoles({ includeArchived: true });
    },
    closeServer,
  },
};
