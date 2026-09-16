"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildUsageMetrics, parseResetsAt } = require("./usage-metrics");

/**
 * Kimi Code CLI 账号额度（managed usage）
 *
 * kimi 没有 `kimi usage` 子命令，额度由 CLI 内部服务从 HTTP 接口读取：
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer <access_token>（~/.kimi-code/credentials/kimi-code.json）
 *
 * 返回体示例：
 * {
 *   "limits": [{ "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                "detail": { "limit": "100", "used": "31", "remaining": "69",
 *                            "resetTime": "...Z" } }],
 *   "usages": {
 *     "limit_5h":          { "used_ratio": 0.308, "reset_time": "...Z" },
 *     "limit_month_total": { "used_ratio": 0.045, "reset_time": "...Z" },
 *     "limit_month_code":  { "used_ratio": 0.045, "reset_time": "...Z" }
 *   }
 * }
 *
 * kimi 没有 week 维度，月度为 `limit_month_total`（缺失时回退 `limit_month_code`）。
 */

const KIMI_CREDENTIALS_PATH =
  process.env.KIMI_CREDENTIALS_PATH ||
  path.join(os.homedir(), ".kimi-code", "credentials", "kimi-code.json");
const KIMI_USAGES_URL =
  process.env.KIMI_USAGES_URL || "https://api.kimi.com/coding/v1/usages";

// timeUnit -> 分钟
const TIME_UNIT_MINUTES = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
};

const FIVE_HOUR_MINUTES = 5 * 60;

function readKimiCredentials(credentialsPath = KIMI_CREDENTIALS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    return {
      accessToken: parsed?.access_token || null,
      refreshToken: parsed?.refresh_token || null,
      expiresAt: parsed?.expires_at || null,
    };
  } catch {
    return { accessToken: null, refreshToken: null, expiresAt: null };
  }
}

function windowDurationMinutes(win) {
  const duration = Number(win?.duration);
  if (!Number.isFinite(duration)) return null;
  const unit = TIME_UNIT_MINUTES[win?.timeUnit];
  if (!unit) return null;
  return duration * unit;
}

function pickFiveHourWindow(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  for (const entry of limits) {
    if (windowDurationMinutes(entry?.window) !== FIVE_HOUR_MINUTES) continue;
    const detail = entry?.detail;
    const limit = Number(detail?.limit);
    const used = Number(detail?.used);
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
      return {
        usedPercent: (used / limit) * 100,
        resetsAt: parseResetsAt(detail?.resetTime),
      };
    }
  }
  const fallback = body?.usages?.limit_5h;
  const ratio = Number(fallback?.used_ratio);
  if (fallback && Number.isFinite(ratio)) {
    return { usedPercent: ratio * 100, resetsAt: parseResetsAt(fallback.reset_time) };
  }
  return null;
}

function pickMonthWindow(body) {
  const usages = body?.usages || {};
  const entry = usages.limit_month_total || usages.limit_month_code;
  if (!entry) return null;
  const ratio = Number(entry.used_ratio);
  if (!Number.isFinite(ratio)) return null;
  return { usedPercent: ratio * 100, resetsAt: parseResetsAt(entry.reset_time) };
}

/**
 * 把 kimi usages 响应归一化成角色卡片 metrics。
 * @param {object|null} body
 * @returns {object}
 */
function normalizeKimiUsage(body) {
  const windows = [];
  const fiveHour = pickFiveHourWindow(body);
  if (fiveHour) {
    windows.push({ key: "5h", label: "5h", usedPercent: fiveHour.usedPercent, resetsAt: fiveHour.resetsAt });
  }
  const month = pickMonthWindow(body);
  if (month) {
    windows.push({ key: "month", label: "month", usedPercent: month.usedPercent, resetsAt: month.resetsAt });
  }

  return buildUsageMetrics(windows, {
    supportsUsageWindows: windows.length > 0,
    supportsTokenUsage: false,
    contextTokens: null,
    totalTokens: null,
    modelContextWindow: null,
    contextCompactedAt: null,
  });
}

/**
 * 获取 kimi 角色卡片 metrics。
 * @param {object} [options]
 * @param {function} [options.readCredentials] - 凭证读取函数（测试注入）
 * @param {function} [options.fetchImpl] - fetch 实现（测试注入）
 * @param {string} [options.credentialsPath] - 凭证文件路径覆盖
 * @returns {Promise<object>}
 */
async function getKimiRoleCardMetrics({
  readCredentials = readKimiCredentials,
  fetchImpl = fetch,
  credentialsPath = KIMI_CREDENTIALS_PATH,
} = {}) {
  const credentials = readCredentials(credentialsPath) || {};
  if (!credentials.accessToken) {
    return { ...normalizeKimiUsage(null), sources: { usage: "no-credentials" } };
  }

  let response;
  try {
    response = await fetchImpl(KIMI_USAGES_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ...normalizeKimiUsage(null), sources: { usage: "fetch-error" } };
  }

  if (!response || !response.ok) {
    return { ...normalizeKimiUsage(null), sources: { usage: "http-error" } };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ...normalizeKimiUsage(null), sources: { usage: "invalid-json" } };
  }

  return { ...normalizeKimiUsage(body), sources: { usage: "kimi-usages-api" } };
}

module.exports = {
  KIMI_CREDENTIALS_PATH,
  KIMI_USAGES_URL,
  readKimiCredentials,
  windowDurationMinutes,
  pickFiveHourWindow,
  pickMonthWindow,
  normalizeKimiUsage,
  getKimiRoleCardMetrics,
};
