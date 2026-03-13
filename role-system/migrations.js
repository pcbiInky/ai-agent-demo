/**
 * 迁移：首次启动时预创建 3 个基础角色，并补齐历史别名。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readRolesFile, writeRolesFile, ROLES_FILE } = require("./roles");

const LEGACY_ROLES = [
  { name: "Faker", cli: "claude", avatar: "F" },
  { name: "奇迹哥", cli: "trae", avatar: "奇" },
  { name: "YYF", cli: "codex", avatar: "Y" },
];

function findLegacyRole(roles, legacy) {
  return roles.find(
    (role) =>
      role.name === legacy.name ||
      role.aliases.includes(legacy.name) ||
      (role.cli === legacy.cli && role.avatar === legacy.avatar)
  );
}

function ensureLegacyAliases(data) {
  let changed = false;

  for (const legacy of LEGACY_ROLES) {
    const role = findLegacyRole(data.roles, legacy);
    if (!role) continue;
    if (!role.aliases.includes(legacy.name)) {
      role.aliases.push(legacy.name);
      role.aliases = [...new Set(role.aliases)];
      role.updatedAt = Date.now();
      changed = true;
    }
  }

  return changed;
}

function buildLegacyNameMap(roles) {
  return Object.fromEntries(
    LEGACY_ROLES.map((legacy) => {
      const role = findLegacyRole(roles, legacy);
      return [legacy.name, role ? role.id : null];
    }).filter(([, roleId]) => Boolean(roleId))
  );
}

function ensureRoleSystemInitialized() {
  const data = readRolesFile();

  if (data.roles.length === 0) {
    for (const legacy of LEGACY_ROLES) {
      data.roles.push({
        id: `role_${crypto.randomUUID().slice(0, 8)}`,
        name: legacy.name,
        aliases: [legacy.name],
        cli: legacy.cli,
        model: "",
        avatar: legacy.avatar,
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const dir = path.dirname(ROLES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeRolesFile(data);
    console.log("[角色系统] 已预创建 3 个基础角色: Faker, 奇迹哥, YYF");
    return buildLegacyNameMap(data.roles);
  }

  if (ensureLegacyAliases(data)) {
    writeRolesFile(data);
  }

  return buildLegacyNameMap(data.roles);
}

module.exports = { ensureRoleSystemInitialized, LEGACY_ROLES };
