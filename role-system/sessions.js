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
  return {
    sessionId,
    title: typeof session.title === "string" && session.title.trim() ? session.title.trim() : DEFAULT_TITLE,
    workingDirectory: typeof session.workingDirectory === "string" ? session.workingDirectory.trim() : "",
    members: session.members || {},
    updatedAt: session.updatedAt || Date.now(),
  };
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
    session.title = updates.title.trim() || DEFAULT_TITLE;
  }
  if (typeof updates.workingDirectory === "string") {
    session.workingDirectory = updates.workingDirectory.trim();
  }
  return writeSession(session);
}

module.exports = {
  DEFAULT_TITLE,
  getOrCreateSession,
  getSessionMembers,
  inviteToSession,
  removeFromSession,
  getProviderSessionId,
  setProviderSessionId,
  updateSessionMeta,
  readSession,
};
