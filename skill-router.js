const { getAllSkills, getBaseSkillsForCharacter, getSkillById, getSkillConfig } = require("./skill-loader");

const SCENE_MATCHERS = {
  code_review: /(code\s*review|review\s+code|代码审查|审查代码|review\b)/i,
  skill_creation: /(创建.*skill|新增.*skill|新建.*skill|create\s+.*skill|skill\s*模块|skill\s*系统|skill\s*机制)/i,
  file_ops: /(修改.*文件|编辑.*文件|读取.*文件|搜索.*文件|查看.*文件|代码实现|修复.*bug|重构|调试|写测试|\bgrep\b|\bglob\b|目录|路径|文件操作|代码.*修改|代码.*实现)/i,
};

function normalizeText(text) {
  return String(text || "").toLowerCase();
}

function detectScenes(prompt) {
  const raw = String(prompt || "");
  return Object.entries(SCENE_MATCHERS)
    .filter(([, pattern]) => pattern.test(raw))
    .map(([scene]) => scene);
}

function matchExplicitSkills(prompt) {
  const normalizedPrompt = normalizeText(prompt);
  return getAllSkills()
    .filter((skill) => normalizedPrompt.includes(skill.id.toLowerCase()) || normalizedPrompt.includes(skill.name.toLowerCase()))
    .map((skill) => skill.id);
}

function stableSortByPriority(skills) {
  return skills
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) => {
      const priorityDiff = (right.skill.meta?.priority || 0) - (left.skill.meta?.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    })
    .map(({ skill }) => skill);
}

function resolveRequestSkills({ prompt, character, model, supportsPermissionTool = true }) {
  const config = getSkillConfig();
  const baseSkills = getBaseSkillsForCharacter(character);
  const matchedScenes = detectScenes(prompt);
  const explicitSkillIds = matchExplicitSkills(prompt);
  const sceneSkillIds = matchedScenes.flatMap((scene) => config.scenes?.[scene] || []);

  const orderedSkillIds = [];
  for (const skill of baseSkills) orderedSkillIds.push(skill.id);
  for (const skillId of sceneSkillIds) orderedSkillIds.push(skillId);
  for (const skillId of explicitSkillIds) orderedSkillIds.push(skillId);

  const dedupedSkills = [];
  const seen = new Set();
  for (let index = orderedSkillIds.length - 1; index >= 0; index -= 1) {
    const skillId = orderedSkillIds[index];
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    const skill = getSkillById(skillId);
    if (skill) dedupedSkills.unshift(skill);
  }

  const hitSkills = [];
  const skipped = [];

  for (const skill of stableSortByPriority(dedupedSkills)) {
    if (skill.meta?.defaultEnabled === false) {
      skipped.push({ id: skill.id, reason: "disabled" });
      continue;
    }
    if (model && Array.isArray(skill.meta?.model_support) && skill.meta.model_support.length > 0) {
      if (!skill.meta.model_support.includes(model)) {
        skipped.push({ id: skill.id, reason: "model-unsupported" });
        continue;
      }
    }
    if (skill.type === "tooling" && !supportsPermissionTool) {
      skipped.push({ id: skill.id, reason: "tooling-unavailable" });
      continue;
    }
    hitSkills.push(skill);
  }

  return {
    matchedScenes,
    hitSkills,
    behaviorSkills: hitSkills.filter((skill) => skill.type === "behavior"),
    toolingSkills: hitSkills.filter((skill) => skill.type === "tooling"),
    globalConstraintSkills: hitSkills.filter((skill) => skill.type === "global_constraint"),
    skipped,
    trace: {
      promptPreview: String(prompt || "").slice(0, 160),
      matchedScenes,
      explicitSkillIds,
      hitSkillIds: hitSkills.map((skill) => skill.id),
      skipped: [...skipped],
    },
  };
}

module.exports = {
  detectScenes,
  resolveRequestSkills,
};
