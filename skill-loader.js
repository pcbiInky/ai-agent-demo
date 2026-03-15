/**
 * Skill Loader - File-based Skill V1
 * 负责加载、校验、缓存 .ai_agent_demo_skill/ 目录中的 Skill 文件。
 * 请求级命中选择由 skill-router.js 负责。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { z } = require("zod");

const SKILL_DIR = path.join(__dirname, ".ai_agent_demo_skill");
const SKILLS_DIR = path.join(SKILL_DIR, "skills");
const CONFIG_FILE = path.join(SKILL_DIR, "use_ai_agent_demo_skills.json");

const REQUIRED_FRONTMATTER = ["name", "description", "type"];
const VALID_TYPES = ["behavior", "tooling", "global_constraint"];
const VALID_MODELS = ["claude", "trae", "codex"];
const VALID_LOAD_ORDERS = ["global-first", "role-first"];
const MAX_SKILL_CHARS = 2000;
const MAX_TOTAL_CHARS = 8000;

const skillMetaSchema = z.object({
  owner: z.string().optional(),
  model_support: z.array(z.enum(VALID_MODELS)).default(VALID_MODELS),
  priority: z.number().int().min(0).max(1000).default(0),
  requireTools: z.array(z.string()).default([]),
  defaultEnabled: z.boolean().default(true),
  max_chars: z.number().int().positive().max(MAX_SKILL_CHARS).optional(),
}).strict();

const skillConfigSchema = z.object({
  global: z.array(z.string()).default([]),
  roles: z.record(z.string(), z.array(z.string())).default({}),
  scenes: z.record(z.string(), z.array(z.string())).default({}),
  loadOrder: z.enum(VALID_LOAD_ORDERS).default("global-first"),
}).strict();

let skillRegistry = new Map();
let skillConfig = { global: [], roles: {}, scenes: {}, loadOrder: "global-first" };
let loadErrors = [];
let loadWarnings = [];

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw.trim() };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    frontmatter[key] = val;
  }
  return { frontmatter, content: match[2].trim() };
}

function extractRequiredTools(content) {
  const match = content.match(/Required MCP Tools:\s*(.+)/i);
  if (!match) return [];
  return match[1].split(",").map((tool) => tool.trim()).filter(Boolean);
}

function getGitCommitHash() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: __dirname,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function normalizeLoadOptions(optionsOrKnownTools = {}) {
  if (Array.isArray(optionsOrKnownTools)) {
    return { knownMcpTools: optionsOrKnownTools, knownRoles: [] };
  }
  return {
    knownMcpTools: optionsOrKnownTools.knownMcpTools || [],
    knownRoles: optionsOrKnownTools.knownRoles || [],
  };
}

function loadSkills(optionsOrKnownTools = {}) {
  const { knownMcpTools, knownRoles } = normalizeLoadOptions(optionsOrKnownTools);

  skillRegistry = new Map();
  loadErrors = [];
  loadWarnings = [];
  skillConfig = { global: [], roles: {}, scenes: {}, loadOrder: "global-first" };

  if (!fs.existsSync(CONFIG_FILE)) {
    loadWarnings.push(`配置文件不存在: ${CONFIG_FILE}，将使用空配置`);
  } else {
    try {
      const parsedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const configResult = skillConfigSchema.safeParse(parsedConfig);
      if (!configResult.success) {
        for (const issue of configResult.error.issues) {
          loadErrors.push(`配置文件字段非法: ${issue.path.join(".") || "(root)"} - ${issue.message}`);
        }
        return { errors: loadErrors, warnings: loadWarnings };
      }
      skillConfig = configResult.data;
    } catch (err) {
      loadErrors.push(`配置文件解析失败: ${CONFIG_FILE} - ${err.message}`);
      return { errors: loadErrors, warnings: loadWarnings };
    }
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    loadWarnings.push(`Skills 目录不存在: ${SKILLS_DIR}`);
    return { errors: loadErrors, warnings: loadWarnings };
  }

  const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const mcpToolShortNames = knownMcpTools.map((toolName) => {
    const parts = toolName.split("__");
    return parts[parts.length - 1];
  });

  for (const skillId of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, skillId);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    const metaPath = path.join(skillPath, "meta.json");

    if (!fs.existsSync(skillMdPath)) {
      loadErrors.push(`[${skillId}] 缺少 SKILL.md: ${skillMdPath}`);
      continue;
    }

    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);

    for (const field of REQUIRED_FRONTMATTER) {
      if (!frontmatter[field]) {
        loadErrors.push(`[${skillId}] SKILL.md frontmatter 缺少必填字段: ${field}`);
      }
    }

    if (frontmatter.type && !VALID_TYPES.includes(frontmatter.type)) {
      loadErrors.push(
        `[${skillId}] SKILL.md type 值不合法: "${frontmatter.type}"，合法值: ${VALID_TYPES.join(", ")}`
      );
    }

    if (skillRegistry.has(skillId)) {
      loadErrors.push(`[${skillId}] skill_id 重复`);
      continue;
    }

    const requiredToolsFromContent = frontmatter.type === "tooling"
      ? extractRequiredTools(content)
      : [];

    let meta = {
      model_support: [...VALID_MODELS],
      priority: 0,
      requireTools: requiredToolsFromContent,
      defaultEnabled: true,
    };

    if (fs.existsSync(metaPath)) {
      try {
        const parsedMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const metaResult = skillMetaSchema.safeParse(parsedMeta);
        if (!metaResult.success) {
          for (const issue of metaResult.error.issues) {
            loadErrors.push(`[${skillId}] meta.json 字段非法: ${issue.path.join(".") || "(root)"} - ${issue.message}`);
          }
        } else {
          meta = {
            ...meta,
            ...metaResult.data,
            requireTools: metaResult.data.requireTools.length > 0
              ? metaResult.data.requireTools
              : requiredToolsFromContent,
          };
        }
      } catch (err) {
        loadWarnings.push(`[${skillId}] meta.json 解析失败: ${err.message}`);
      }
    } else {
      loadWarnings.push(`[${skillId}] 缺少可选 meta.json`);
    }

    if (content.length > MAX_SKILL_CHARS) {
      loadWarnings.push(`[${skillId}] SKILL.md 内容超过 ${MAX_SKILL_CHARS} 字符限制 (${content.length} 字符)，将被截断`);
    }

    if (frontmatter.type === "tooling" && mcpToolShortNames.length > 0) {
      for (const toolName of meta.requireTools) {
        if (!mcpToolShortNames.includes(toolName)) {
          loadErrors.push(`[${skillId}] 引用了不存在的 MCP 工具: ${toolName}`);
        }
      }
    }

    const maxChars = Math.min(meta.max_chars || MAX_SKILL_CHARS, MAX_SKILL_CHARS);

    skillRegistry.set(skillId, {
      id: skillId,
      name: frontmatter.name || skillId,
      description: frontmatter.description || "",
      type: frontmatter.type || "behavior",
      content: content.slice(0, maxChars),
      meta,
      filePath: skillMdPath,
    });
  }

  const configuredRoleNames = Object.keys(skillConfig.roles || {});
  if (knownRoles.length > 0) {
    for (const roleName of configuredRoleNames) {
      if (!knownRoles.includes(roleName)) {
        loadErrors.push(`配置中引用了不存在的角色名: "${roleName}"`);
      }
    }
  }

  const allConfiguredIds = [
    ...(skillConfig.global || []),
    ...Object.values(skillConfig.roles || {}).flat(),
    ...Object.values(skillConfig.scenes || {}).flat(),
  ];
  for (const id of allConfiguredIds) {
    if (!skillRegistry.has(id)) {
      loadErrors.push(`配置中引用了不存在的 skill_id: "${id}"`);
    }
  }

  return { errors: loadErrors, warnings: loadWarnings };
}

function printSkillStartupLog() {
  const commitHash = getGitCommitHash();
  const skillCount = skillRegistry.size;
  const skillIds = [...skillRegistry.keys()];

  console.log(`\n[Skill] ── 加载完成 ──`);
  console.log(`[Skill] 数量: ${skillCount}`);
  console.log(`[Skill] 列表: ${skillIds.join(", ") || "(无)"}`);
  console.log(`[Skill] Git Commit: ${commitHash}`);

  if (loadWarnings.length > 0) {
    for (const warning of loadWarnings) {
      console.warn(`[Skill][Warning] ${warning}`);
    }
  }
  if (loadErrors.length > 0) {
    for (const error of loadErrors) {
      console.error(`[Skill][Error] ${error}`);
    }
  }
  console.log(`[Skill] ──────────────\n`);
}

function getSkillById(id) {
  return skillRegistry.get(id) || null;
}

function getSkillConfig() {
  return skillConfig;
}

function getBaseSkillsForCharacter(character) {
  if (!skillConfig) return [];

  const globalIds = skillConfig.global || [];
  const roleIds = (character && skillConfig.roles?.[character]) || [];
  const orderedIds = skillConfig.loadOrder === "role-first"
    ? [...roleIds, ...globalIds]
    : [...globalIds, ...roleIds];

  const seen = new Set();
  const deduped = [];
  for (let index = orderedIds.length - 1; index >= 0; index -= 1) {
    const skillId = orderedIds[index];
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    deduped.unshift(skillId);
  }

  return deduped.map((id) => skillRegistry.get(id)).filter(Boolean);
}

function buildSkillTypeInjection(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) {
    return { content: "", injected: [], skipped: [], totalChars: 0 };
  }

  let totalChars = 0;
  const parts = [];
  const injected = [];
  const skipped = [];

  for (const skill of skills) {
    if (totalChars + skill.content.length > MAX_TOTAL_CHARS) {
      skipped.push({ id: skill.id, reason: "char-budget" });
      continue;
    }
    parts.push(`\n\n【技能: ${skill.name}】\n${skill.content}`);
    totalChars += skill.content.length;
    injected.push(skill.id);
  }

  return {
    content: parts.join(""),
    injected,
    skipped,
    totalChars,
  };
}

function getAllSkills() {
  return [...skillRegistry.values()].map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    type: skill.type,
    meta: skill.meta,
    filePath: skill.filePath,
  }));
}

function getSkillDetailById(id) {
  const skill = skillRegistry.get(id);
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    type: skill.type,
    content: skill.content,
    meta: skill.meta,
    filePath: skill.filePath,
  };
}

module.exports = {
  loadSkills,
  printSkillStartupLog,
  getSkillConfig,
  getBaseSkillsForCharacter,
  getSkillById,
  getAllSkills,
  getSkillDetailById,
  buildSkillTypeInjection,
  parseFrontmatter,
  extractRequiredTools,
  SKILL_DIR,
  SKILLS_DIR,
  CONFIG_FILE,
  MAX_SKILL_CHARS,
  MAX_TOTAL_CHARS,
  VALID_TYPES,
  VALID_MODELS,
};
