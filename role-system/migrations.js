/**
 * 迁移：首次启动时预创建 3 个基础角色
 */
const fs = require("fs");
const { readRolesFile, ROLES_FILE } = require("./roles");

// 硬编码的 3 个历史角色（迁移专用，不运行时持久化）
const LEGACY_ROLES = [
  { name: "Faker", cli: "claude", avatar: "F" },
  { name: "奇迹哥", cli: "trae", avatar: "奇" },
  { name: "YYF", cli: "codex", avatar: "Y" },
];

/**
 * 确保角色系统已初始化。
 * 如果 roles.json 不存在或为空，预创建 3 个基础角色。
 * 返回 legacyNameMap（角色名 -> roleId），供旧消息兼容。
 */
function ensureRoleSystemInitialized() {
  const data = readRolesFile();

  if (data.roles.length > 0) {
    // 已初始化，构建映射并返回
    return buildLegacyNameMap(data.roles);
  }

  // 首次初始化：预创建基础角色
  const crypto = require("crypto");
  for (const legacy of LEGACY_ROLES) {
    data.roles.push({
      id: `role_${crypto.randomUUID().slice(0, 8)}`,
      name: legacy.name,
      cli: legacy.cli,
      model: "",
      avatar: legacy.avatar,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const dir = require("path").dirname(ROLES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2));

  console.log("[角色系统] 已预创建 3 个基础角色: Faker, 奇迹哥, YYF");
  return buildLegacyNameMap(data.roles);
}

function buildLegacyNameMap(roles) {
  const map = {};
  for (const role of roles) {
    map[role.name] = role.id;
  }
  return map;
}

module.exports = { ensureRoleSystemInitialized };
