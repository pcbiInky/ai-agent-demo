/**
 * 角色存储：CRUD + 归档/恢复
 * 数据文件: role-system/data/roles.json
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const ROLES_FILE = path.join(DATA_DIR, "roles.json");

// 简单的写锁，防止并发写竞争
let _writeLock = Promise.resolve();

// 默认最大上下文长度：256k tokens（可在设置中按角色调整）
const DEFAULT_CONTEXT_WINDOW = 262144;

function normalizeContextWindow(value) {
  const n = Number(value);
  return { contextWindow: Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW };
}

function withLock(fn) {
  const next = _writeLock.then(fn, fn);
  _writeLock = next.catch(() => {});
  return next;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeRole(role) {
  const contextWindow = Number(role.contextWindow);
  return {
    ...role,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    aliases: Array.isArray(role.aliases) ? [...new Set(role.aliases.filter(Boolean))] : [],
  };
}

function normalizeRolesData(data) {
  return {
    version: data.version || 2,
    roles: Array.isArray(data.roles) ? data.roles.map(normalizeRole) : [],
  };
}

function readRolesFile() {
  ensureDataDir();
  try {
    return normalizeRolesData(JSON.parse(fs.readFileSync(ROLES_FILE, "utf-8")));
  } catch {
    return { version: 2, roles: [] };
  }
}

function writeRolesFile(data) {
  ensureDataDir();
  fs.writeFileSync(ROLES_FILE, JSON.stringify(normalizeRolesData(data), null, 2));
}

// ── 查询 ──

function listRoles({ includeArchived = false } = {}) {
  const data = readRolesFile();
  if (includeArchived) return data.roles;
  return data.roles.filter((r) => !r.archived);
}

function getRoleById(id) {
  const data = readRolesFile();
  return data.roles.find((r) => r.id === id) || null;
}

function getRoleByName(name) {
  const data = readRolesFile();
  return data.roles.find((r) => r.name === name) || null;
}

function getRoleByAlias(name) {
  const data = readRolesFile();
  return data.roles.find((r) => r.aliases.includes(name)) || null;
}

// ── 创建 ──

function createRole({ name, cli, model = "", avatar = "", contextWindow }) {
  return withLock(() => {
    const data = readRolesFile();

    if (data.roles.some((r) => r.name === name)) {
      throw new Error(`角色名 "${name}" 已存在`);
    }

    const validClis = ["claude", "trae", "codex", "dsh", "kimi"];
    if (!validClis.includes(cli)) {
      throw new Error(`不支持的 CLI: ${cli}，可选: ${validClis.join(", ")}`);
    }

    const role = {
      id: `role_${crypto.randomUUID().slice(0, 8)}`,
      name,
      aliases: [],
      cli,
      model,
      avatar: avatar || name[0] || "?",
      ...normalizeContextWindow(contextWindow),
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    data.roles.push(role);
    writeRolesFile(data);
    return role;
  });
}

// ── 更新 ──

function updateRole(id, updates) {
  return withLock(() => {
    const data = readRolesFile();
    const role = data.roles.find((r) => r.id === id);
    if (!role) throw new Error(`角色不存在: ${id}`);

    if (updates.name && updates.name !== role.name) {
      if (data.roles.some((r) => r.name === updates.name && r.id !== id)) {
        throw new Error(`角色名 "${updates.name}" 已存在`);
      }
      role.aliases = [...new Set([...(role.aliases || []), role.name])];
    }

    const allowed = ["name", "cli", "model", "avatar", "contextWindow"];
    for (const key of allowed) {
      if (updates[key] !== undefined) role[key] = updates[key];
    }
    role.updatedAt = Date.now();

    writeRolesFile(data);
    return normalizeRole(role);
  });
}

// ── 归档/恢复 ──

function archiveRole(id) {
  return withLock(() => {
    const data = readRolesFile();
    const role = data.roles.find((r) => r.id === id);
    if (!role) throw new Error(`角色不存在: ${id}`);
    role.archived = true;
    role.updatedAt = Date.now();
    writeRolesFile(data);
    return normalizeRole(role);
  });
}

function restoreRole(id) {
  return withLock(() => {
    const data = readRolesFile();
    const role = data.roles.find((r) => r.id === id);
    if (!role) throw new Error(`角色不存在: ${id}`);
    role.archived = false;
    role.updatedAt = Date.now();
    writeRolesFile(data);
    return normalizeRole(role);
  });
}

module.exports = {
  listRoles,
  getRoleById,
  getRoleByName,
  getRoleByAlias,
  createRole,
  updateRole,
  archiveRole,
  restoreRole,
  readRolesFile,
  writeRolesFile,
  ROLES_FILE,
};
