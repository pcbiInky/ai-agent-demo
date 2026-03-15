/**
 * Skill Loader - File-based Skill V1
 * 负责加载、校验、缓存 .ai_agent_demo_skill/ 目录中的 Skill 文件
 * 不负责 prompt 拼接（拼接逻辑在 server.js / invoke.js）
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SKILL_DIR = path.join(__dirname, ".ai_agent_demo_skill");
const SKILLS_DIR = path.join(SKILL_DIR, "skills");
const CONFIG_FILE = path.join(SKILL_DIR, "use_ai_agent_demo_skills.json");

// frontmatter 必填字段
const REQUIRED_FRONTMATTER = ["name", "description", "type"];
// 合法的 type 值
const VALID_TYPES = ["behavior", "tooling", "global_constraint"];
// 单 Skill 内容上限（字符数）
const MAX_SKILL_CHARS = 2000;
// 一次请求注入的 Skill 总量上限（字符数）
const MAX_TOTAL_CHARS = 8000;

// ── 内存 Registry ─────────────────────────────────────────
let skillRegistry = new Map();   // skill_id -> { id, name, description, type, content, meta, filePath }
let skillConfig = null;          // use_ai_agent_demo_skills.json 解析结果
let loadErrors = [];             // Error 级别的问题
let loadWarnings = [];           // Warning 级别的问题

/**
 * 解析 SKILL.md 的 YAML frontmatter
 * @param {string} raw - 文件原始内容
 * @returns {{ frontmatter: object, content: string }}
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      frontmatter[key] = val;
    }
  }
  return { frontmatter, content: match[2].trim() };
}

/**
 * 从 SKILL.md 内容中提取声明的 MCP 工具列表
 * 格式: "Required MCP Tools: Read, Write, Glob"
 */
function extractRequiredTools(content) {
  const match = content.match(/Required MCP Tools:\s*(.+)/i);
  if (!match) return [];
  return match[1].split(",").map(t => t.trim()).filter(Boolean);
}

/**
 * 获取当前 git commit hash（短格式）
 */
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

/**
 * 启动时加载所有 Skill
 * @param {string[]} knownMcpTools - 已知的 MCP 工具名列表（用于校验 tooling 类 Skill 的工具引用）
 * @returns {{ errors: string[], warnings: string[] }}
 */
function loadSkills(knownMcpTools = []) {
  skillRegistry = new Map();
  loadErrors = [];
  loadWarnings = [];

  // 1. 读取配置文件
  if (!fs.existsSync(CONFIG_FILE)) {
    loadWarnings.push(`配置文件不存在: ${CONFIG_FILE}，将使用空配置`);
    skillConfig = { global: [], roles: {}, loadOrder: "global-first" };
  } else {
    try {
      skillConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (err) {
      loadErrors.push(`配置文件解析失败: ${CONFIG_FILE} - ${err.message}`);
      return { errors: loadErrors, warnings: loadWarnings };
    }
  }

  // 2. 扫描 skills 目录
  if (!fs.existsSync(SKILLS_DIR)) {
    loadWarnings.push(`Skills 目录不存在: ${SKILLS_DIR}`);
    return { errors: loadErrors, warnings: loadWarnings };
  }

  const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  // 提取 MCP 工具短名用于校验（mcp__permission__Read -> Read）
  const mcpToolShortNames = knownMcpTools.map(t => {
    const parts = t.split("__");
    return parts[parts.length - 1];
  });

  for (const skillId of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, skillId);
    const skillMdPath = path.join(skillPath, "SKILL.md");
    const metaPath = path.join(skillPath, "meta.json");

    // Error: 缺少 SKILL.md
    if (!fs.existsSync(skillMdPath)) {
      loadErrors.push(`[${skillId}] 缺少 SKILL.md: ${skillMdPath}`);
      continue;
    }

    // 读取并解析 SKILL.md
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);

    // Error: frontmatter 缺少必填字段
    for (const field of REQUIRED_FRONTMATTER) {
      if (!frontmatter[field]) {
        loadErrors.push(`[${skillId}] SKILL.md frontmatter 缺少必填字段: ${field}`);
      }
    }

    // Error: type 值不合法
    if (frontmatter.type && !VALID_TYPES.includes(frontmatter.type)) {
      loadErrors.push(`[${skillId}] SKILL.md type 值不合法: "${frontmatter.type}"，合法值: ${VALID_TYPES.join(", ")}`);
    }

    // Error: skill_id 重复
    if (skillRegistry.has(skillId)) {
      loadErrors.push(`[${skillId}] skill_id 重复`);
      continue;
    }

    // Warning: 内容超过长度限制
    if (content.length > MAX_SKILL_CHARS) {
      loadWarnings.push(`[${skillId}] SKILL.md 内容超过 ${MAX_SKILL_CHARS} 字符限制 (${content.length} 字符)，将被截断`);
    }

    // 校验 tooling 类 Skill 引用的 MCP 工具是否存在
    if (frontmatter.type === "tooling" && mcpToolShortNames.length > 0) {
      const requiredTools = extractRequiredTools(content);
      for (const tool of requiredTools) {
        if (!mcpToolShortNames.includes(tool)) {
          loadErrors.push(`[${skillId}] 引用了不存在的 MCP 工具: ${tool}`);
        }
      }
    }

    // 读取可选 meta.json
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      } catch (err) {
        loadWarnings.push(`[${skillId}] meta.json 解析失败: ${err.message}`);
      }
    } else {
      loadWarnings.push(`[${skillId}] 缺少可选 meta.json`);
    }

    // 注册到 registry
    skillRegistry.set(skillId, {
      id: skillId,
      name: frontmatter.name || skillId,
      description: frontmatter.description || "",
      type: frontmatter.type || "behavior",
      content: content.slice(0, MAX_SKILL_CHARS),
      meta,
      filePath: skillMdPath,
    });
  }

  // 3. 校验配置中引用的 skill_id 是否都存在
  const allConfiguredIds = [
    ...(skillConfig.global || []),
    ...Object.values(skillConfig.roles || {}).flat(),
  ];
  for (const id of allConfiguredIds) {
    if (!skillRegistry.has(id)) {
      loadErrors.push(`配置中引用了不存在的 skill_id: "${id}"`);
    }
  }

  return { errors: loadErrors, warnings: loadWarnings };
}

/**
 * 打印启动日志
 */
function printSkillStartupLog() {
  const commitHash = getGitCommitHash();
  const skillCount = skillRegistry.size;
  const skillIds = [...skillRegistry.keys()];

  console.log(`\n[Skill] ── 加载完成 ──`);
  console.log(`[Skill] 数量: ${skillCount}`);
  console.log(`[Skill] 列表: ${skillIds.join(", ") || "(无)"}`);
  console.log(`[Skill] Git Commit: ${commitHash}`);

  if (loadWarnings.length > 0) {
    for (const w of loadWarnings) {
      console.warn(`[Skill][Warning] ${w}`);
    }
  }
  if (loadErrors.length > 0) {
    for (const e of loadErrors) {
      console.error(`[Skill][Error] ${e}`);
    }
  }
  console.log(`[Skill] ──────────────\n`);
}

/**
 * 根据角色获取应注入的 Skill 列表
 * @param {string} [character] - 角色名（可选）
 * @returns {object[]} 按 loadOrder 排列的 Skill 对象数组
 */
function getSkillsForCharacter(character) {
  if (!skillConfig) return [];

  const globalIds = skillConfig.global || [];
  const roleIds = (character && skillConfig.roles?.[character]) || [];

  let orderedIds;
  if (skillConfig.loadOrder === "global-first") {
    orderedIds = [...globalIds, ...roleIds];
  } else {
    orderedIds = [...roleIds, ...globalIds];
  }

  // 去重，保留后出现的（后加载覆盖前加载）
  const seen = new Set();
  const deduped = [];
  for (let i = orderedIds.length - 1; i >= 0; i--) {
    if (!seen.has(orderedIds[i])) {
      seen.add(orderedIds[i]);
      deduped.unshift(orderedIds[i]);
    }
  }

  return deduped
    .map(id => skillRegistry.get(id))
    .filter(Boolean);
}

/**
 * 按类型筛选 Skill 并拼接内容，遵守总量上限
 * @param {object[]} skills - Skill 对象数组
 * @param {string} type - Skill 类型
 * @returns {string} 拼接后的 Skill 内容
 */
function getSkillContentByType(skills, type) {
  const filtered = skills.filter(s => s.type === type);
  if (filtered.length === 0) return "";

  let totalChars = 0;
  const parts = [];
  for (const skill of filtered) {
    if (totalChars + skill.content.length > MAX_TOTAL_CHARS) {
      console.warn(`[Skill] 注入总量超过 ${MAX_TOTAL_CHARS} 字符限制，跳过: ${skill.id}`);
      break;
    }
    parts.push(`\n\n【技能: ${skill.name}】\n${skill.content}`);
    totalChars += skill.content.length;
  }
  return parts.join("");
}

/**
 * 获取所有已加载的 Skill（用于 API）
 */
function getAllSkills() {
  return [...skillRegistry.values()].map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    type: s.type,
    meta: s.meta,
  }));
}

/**
 * 获取单个 Skill 详情（用于 API）
 */
function getSkillById(id) {
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
  getSkillsForCharacter,
  getSkillContentByType,
  getAllSkills,
  getSkillById,
  // 导出常量供 CI 脚本复用
  SKILL_DIR,
  SKILLS_DIR,
  CONFIG_FILE,
  MAX_SKILL_CHARS,
  MAX_TOTAL_CHARS,
};
