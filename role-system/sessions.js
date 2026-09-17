/**
 * 会话成员 + 上下文管理（合并为单文件）
 * 数据文件: role-system/data/sessions/<sessionId>.json
 */
const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = path.join(__dirname, "data", "sessions");
const DEFAULT_TITLE = "新对话";

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function normalizeSession(sessionId, raw) {
  const session = raw || { sessionId, members: {}, updatedAt: Date.now() };
  const normalizedTitle = typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : DEFAULT_TITLE;
  const titleCustomized = typeof session.titleCustomized === "boolean"
    ? session.titleCustomized
    : normalizedTitle !== DEFAULT_TITLE;

  return {
    sessionId,
    title: normalizedTitle,
    titleCustomized,
    workingDirectory: typeof session.workingDirectory === "string" ? session.workingDirectory.trim() : "",
    members: session.members || {},
    updatedAt: session.updatedAt || Date.now(),
  };
}

// 去掉用户消息里的 @角色，让标题展示真正的第一句话。
// 只删除「可确认为召唤」的 token：@ 前必须是行首，或不是任意语言的字母/数字/下划线/@。
// 用 Unicode 属性类而非 \w（\w 只覆盖 ASCII），这样中文邮箱/标识符如 用户@YYF.com 也不会被误伤。
const MENTION_LEFT_BOUNDARY = "(^|[^\\p{L}\\p{N}_@])";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripNamedMentions(text, names) {
  // 长名优先，避免 @YY 把 @YYF 咬掉一半
  const sorted = names
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim())
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const name of sorted) {
    result = result.replace(
      new RegExp(`${MENTION_LEFT_BOUNDARY}@${escapeRegExp(name)}`, "gu"),
      "$1",
    );
  }
  return result;
}

// 旧记录既没有 mentions、又拿不到角色名单时的兜底：只删「后面有明确边界」的 ASCII @token。
// 中文角色名无法确定边界，宁可保留原文，也不能把正文一起吞掉。
const LEGACY_MENTION_PATTERN = /(^|[^\p{L}\p{N}_@])@[A-Za-z0-9_-]+(?=$|[\s，。！？、：:；;,!?）)】」』"'…—\-])/gu;

// 清理 mention 之后残留的紧邻分隔符/空白，避免标题以「：」或空格开头。
function normalizeTitleText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？、：；）】》」』…])/g, "$1")
    .replace(/([（【《「『])\s+/g, "$1")
    .replace(/^[\s，。！？、：；,.:;!?\-—]+/, "")
    .trim();
}

function resolveDisplayTitle(session, messages = [], roleNames = []) {
  if (session?.titleCustomized && session.title?.trim()) {
    return session.title.trim();
  }

  const knownNames = Array.isArray(roleNames)
    ? roleNames.filter((name) => typeof name === "string" && name.trim())
    : [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.text !== "string") continue;
    let cleaned;
    if (Array.isArray(message.mentions)) {
      cleaned = stripNamedMentions(message.text, message.mentions);
    } else if (knownNames.length > 0) {
      cleaned = stripNamedMentions(message.text, knownNames);
    } else {
      cleaned = message.text.replace(LEGACY_MENTION_PATTERN, "$1");
    }
    const title = normalizeTitleText(cleaned);
    if (title) return title;
  }
  return DEFAULT_TITLE;
}

function readSession(sessionId) {
  ensureSessionsDir();
  const filePath = sessionFilePath(sessionId);
  try {
    return normalizeSession(sessionId, JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return null;
  }
}

function writeSession(data) {
  ensureSessionsDir();
  const normalized = normalizeSession(data.sessionId, data);
  normalized.updatedAt = Date.now();
  fs.writeFileSync(sessionFilePath(normalized.sessionId), JSON.stringify(normalized, null, 2));
  return normalized;
}

function getOrCreateSession(sessionId, defaultMemberIds = []) {
  let session = readSession(sessionId);
  if (!session) {
    session = normalizeSession(sessionId, {
      sessionId,
      members: {},
      updatedAt: Date.now(),
    });
    for (const roleId of defaultMemberIds) {
      session.members[roleId] = { providerSessionId: null };
    }
    return writeSession(session);
  }
  return session;
}

function getSessionMembers(sessionId) {
  const session = readSession(sessionId);
  if (!session) return [];
  return Object.keys(session.members);
}

function inviteToSession(sessionId, roleId) {
  const session = getOrCreateSession(sessionId);
  if (!session.members[roleId]) {
    session.members[roleId] = { providerSessionId: null };
  }
  return writeSession(session);
}

function removeFromSession(sessionId, roleId) {
  const session = readSession(sessionId);
  if (!session) return null;
  delete session.members[roleId];
  return writeSession(session);
}

function getProviderSessionId(sessionId, roleId) {
  const session = readSession(sessionId);
  return session?.members[roleId]?.providerSessionId || null;
}

function setProviderSessionId(sessionId, roleId, providerSessionId) {
  const session = getOrCreateSession(sessionId);
  if (!session.members[roleId]) {
    session.members[roleId] = {};
  }
  session.members[roleId].providerSessionId = providerSessionId;
  return writeSession(session);
}

function updateSessionMeta(sessionId, updates = {}) {
  const session = getOrCreateSession(sessionId);
  if (typeof updates.title === "string") {
    const title = updates.title.trim();
    session.title = title || DEFAULT_TITLE;
    session.titleCustomized = Boolean(title);
  }
  if (typeof updates.workingDirectory === "string") {
    session.workingDirectory = updates.workingDirectory.trim();
  }
  return writeSession(session);
}

function getMemberRuntimeMetrics(sessionId, roleId) {
  const session = readSession(sessionId);
  return session?.members[roleId]?.runtimeMetrics || null;
}

function setMemberRuntimeMetrics(sessionId, roleId, metrics) {
  const session = getOrCreateSession(sessionId);
  if (!session.members[roleId]) {
    session.members[roleId] = {};
  }
  session.members[roleId].runtimeMetrics = {
    ...metrics,
    updatedAt: Date.now(),
  };
  return writeSession(session);
}

function patchMemberRuntimeMetrics(sessionId, roleId, patch) {
  const session = getOrCreateSession(sessionId);
  if (!session.members[roleId]) {
    session.members[roleId] = {};
  }
  if (!session.members[roleId].runtimeMetrics) {
    session.members[roleId].runtimeMetrics = {};
  }
  session.members[roleId].runtimeMetrics = {
    ...session.members[roleId].runtimeMetrics,
    ...patch,
    updatedAt: Date.now(),
  };
  return writeSession(session);
}

module.exports = {
  DEFAULT_TITLE,
  resolveDisplayTitle,
  getOrCreateSession,
  getSessionMembers,
  inviteToSession,
  removeFromSession,
  getProviderSessionId,
  setProviderSessionId,
  updateSessionMeta,
  readSession,
  getMemberRuntimeMetrics,
  setMemberRuntimeMetrics,
  patchMemberRuntimeMetrics,
};
