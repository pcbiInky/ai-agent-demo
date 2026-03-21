const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MINIMAXI_API_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";

/**
 * 读取 claude settings.json，提取 env.ANTHROPIC_AUTH_TOKEN
 * @returns {{ apiKey: string|null, modelName: string|null }}
 */
function getClaudeSettings() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return { apiKey: null, modelName: null };
    }
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(content);
    const apiKey = settings?.env?.ANTHROPIC_AUTH_TOKEN || null;
    const modelName = settings?.env?.ANTHROPIC_MODEL || null;
    return { apiKey, modelName };
  } catch {
    return { apiKey: null, modelName: null };
  }
}

/**
 * 从 model_remains 数组中选择一条记录
 * 优先匹配 roleModel，其次 settingsModelName，最后 fallback 到第一条
 * @param {Array} modelRemains
 * @param {string|null} roleModel - 角色配置中的模型名（优先级最高）
 * @param {string|null} settingsModelName - settings.json 中的模型名（次优先级）
 * @returns {object|null}
 */
function selectModelRemain(modelRemains, roleModel, settingsModelName) {
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
    return null;
  }
  if (roleModel) {
    const matched = modelRemains.find((r) => r.model_name === roleModel);
    if (matched) return matched;
  }
  if (settingsModelName) {
    const matched = modelRemains.find((r) => r.model_name === settingsModelName);
    if (matched) return matched;
  }
  return modelRemains[0];
}

/**
 * 归一化 minimaxi response -> role card metrics
 * @param {object} remain
 * @returns {object}
 */
function normalizeMetrics(remain) {
  if (!remain) {
    return {
      supportsUsageWindows: false,
      supportsTokenUsage: false,
    };
  }

  const primaryUsedPercent =
    remain.current_interval_total_count > 0
      ? Math.round((1 - remain.current_interval_usage_count / remain.current_interval_total_count) * 100)
      : null;

  const secondaryUsedPercent =
    remain.current_weekly_total_count > 0
      ? Math.round((1 - remain.current_weekly_usage_count / remain.current_weekly_total_count) * 100)
      : null;

  return {
    supportsUsageWindows: true,
    supportsTokenUsage: false,
    primaryUsedPercent,
    secondaryUsedPercent,
    primaryResetsAt: remain.end_time || null,
    secondaryResetsAt: remain.weekly_end_time || null,
    contextTokens: null,
    totalTokens: null,
    modelContextWindow: null,
    contextCompactedAt: null,
  };
}

/**
 * 获取 claude 角色卡片的 metrics
 * @param {string|null} roleModel - 角色配置中的模型名（优先用于选择 model_remains 条目）
 * @param {object} [options]
 * @param {function} [options.readSettings] - settings 读取函数，默认 getClaudeSettings（用于测试注入）
 * @param {function} [options.fetchImpl] - fetch 实现，默认全局 fetch（用于测试注入）
 * @returns {Promise<object>}
 */
async function getClaudeRoleCardMetrics(roleModel, { readSettings = getClaudeSettings, fetchImpl = fetch } = {}) {
  const { apiKey, modelName: settingsModelName } = readSettings();

  if (!apiKey) {
    return {
      supportsUsageWindows: false,
      supportsTokenUsage: false,
    };
  }

  let response;
  try {
    response = await fetchImpl(MINIMAXI_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    return {
      supportsUsageWindows: false,
      supportsTokenUsage: false,
    };
  }

  if (!response.ok) {
    return {
      supportsUsageWindows: false,
      supportsTokenUsage: false,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return {
      supportsUsageWindows: false,
      supportsTokenUsage: false,
    };
  }

  const selected = selectModelRemain(body?.model_remains, roleModel, settingsModelName);
  return normalizeMetrics(selected);
}

module.exports = {
  getClaudeSettings,
  selectModelRemain,
  normalizeMetrics,
  getClaudeRoleCardMetrics,
};