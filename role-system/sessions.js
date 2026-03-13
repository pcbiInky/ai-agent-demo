/**
 * 会话成员 + 上下文管理（合并为单文件）
 * 数据文件: role-system/data/sessions/<sessionId>.json
 *
 * 结构:
 * {
 *   "sessionId": "...",
 *   "members": {
 *     "role_xxx": { "providerSessionId": null },
 *     "role_yyy": { "providerSessionId": "cli-session-1" }
 *   },
 *   "updatedAt": 0
 * }
 */
const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = path.join(__dirname, "data", "sessions");

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function readSession(sessionId) {
  ensureSessionsDir();
  const filePath = sessionFilePath(sessionId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeSession(data) {
  ensureSessionsDir();
  data.updatedAt = Date.now();
  fs.writeFileSync(sessionFilePath(data.sessionId), JSON.stringify(data, null, 2));
}

// ── 会话成员 ──

/**
 * 获取或创建会话数据
 * @param {string} sessionId
 * @param {string[]} [defaultMemberIds] - 首次创建时的默认成员 roleId 列表
 */
function getOrCreateSession(sessionId, defaultMemberIds = []) {
  let session = readSession(sessionId);
  if (!session) {
    session = {
      sessionId,
      members: {},
      updatedAt: Date.now(),
    };
    for (const roleId of defaultMemberIds) {
      session.members[roleId] = { providerSessionId: null };
    }
    writeSession(session);
  }
  return session;
}

function getSessionMembers(sessionId) {
  const session = readSession(sessionId);
  if (!session) return [];
  return Object.keys(session.members);
}

function inviteToSession(sessionId, roleId) {
  const session = readSession(sessionId) || {
    sessionId,
    members: {},
    updatedAt: Date.now(),
  };
  if (!session.members[roleId]) {
    session.members[roleId] = { providerSessionId: null };
  }
  writeSession(session);
  return session;
}

function removeFromSession(sessionId, roleId) {
  const session = readSession(sessionId);
  if (!session) return null;
  delete session.members[roleId];
  writeSession(session);
  return session;
}

// ── Provider Session（CLI 上下文）──

function getProviderSessionId(sessionId, roleId) {
  const session = readSession(sessionId);
  return session?.members[roleId]?.providerSessionId || null;
}

function setProviderSessionId(sessionId, roleId, providerSessionId) {
  const session = readSession(sessionId) || {
    sessionId,
    members: {},
    updatedAt: Date.now(),
  };
  if (!session.members[roleId]) {
    session.members[roleId] = {};
  }
  session.members[roleId].providerSessionId = providerSessionId;
  writeSession(session);
}

module.exports = {
  getOrCreateSession,
  getSessionMembers,
  inviteToSession,
  removeFromSession,
  getProviderSessionId,
  setProviderSessionId,
  readSession,
};
