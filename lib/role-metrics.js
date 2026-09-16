"use strict";

const { getCodexRoleCardMetrics } = require("./codex-metrics");
const { getClaudeRoleCardMetrics } = require("./claude-metrics");
const { getKimiRoleCardMetrics } = require("./kimi-metrics");

/**
 * 角色卡片指标注册表（框架层）
 *
 * 每个 CLI 只需注册一个 provider：
 *   provider.get({ role, providerSessionId }) -> Promise<metrics>
 *   provider.fallback                          -> 拿不到数据时的兜底 metrics
 *
 * 新增 CLI / 新增额度维度时，只在这里加一条，server 与前端都无需改动：
 *  - server 侧统一调用 getRoleCardMetrics()
 *  - 前端统一按 metrics.usageWindows 渲染
 */

const EMPTY_METRICS = {
  supportsUsageWindows: false,
  supportsTokenUsage: false,
  usageWindows: [],
};

const PROVIDERS = {
  codex: {
    get: ({ providerSessionId }) => getCodexRoleCardMetrics(providerSessionId || null),
    // codex 即使拿不到 rate limit 也应保持额度区可见（展示 --）
    fallback: {
      supportsUsageWindows: true,
      supportsTokenUsage: true,
      usageWindows: [
        { key: "5h", label: "5h", usedPercent: null, resetsAt: null },
        { key: "week", label: "week", usedPercent: null, resetsAt: null },
      ],
    },
  },
  claude: {
    get: ({ role }) => getClaudeRoleCardMetrics(role?.model),
    fallback: EMPTY_METRICS,
  },
  kimi: {
    get: () => getKimiRoleCardMetrics(),
    fallback: EMPTY_METRICS,
  },
};

/**
 * 获取指定角色在当前 provider 会话下的卡片指标。
 * @param {object} role
 * @param {object} [context]
 * @param {string|null} [context.providerSessionId]
 * @returns {Promise<object>}
 */
async function getRoleCardMetrics(role, { providerSessionId = null } = {}) {
  const provider = role && role.cli ? PROVIDERS[role.cli] : null;
  if (!provider) return { ...EMPTY_METRICS };

  try {
    const metrics = await provider.get({ role, providerSessionId });
    return { ...EMPTY_METRICS, ...(metrics || {}) };
  } catch {
    return { ...(provider.fallback || EMPTY_METRICS) };
  }
}

module.exports = {
  EMPTY_METRICS,
  PROVIDERS,
  getRoleCardMetrics,
};
