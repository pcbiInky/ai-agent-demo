"use strict";

const crypto = require("crypto");
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
const KIMI_OAUTH_TOKEN_URL = `${(
  process.env.KIMI_CODE_OAUTH_HOST ||
  process.env.KIMI_OAUTH_HOST ||
  "https://auth.kimi.com"
).replace(/\/+$/, "")}/api/oauth/token`;
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;
const inflightRefreshes = new Map();

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
      expiresAt: Number(parsed?.expires_at) || 0,
      expiresIn: Number(parsed?.expires_in) || 0,
      scope: typeof parsed?.scope === "string" ? parsed.scope : "",
      tokenType: typeof parsed?.token_type === "string" ? parsed.token_type : "Bearer",
    };
  } catch {
    return {
      accessToken: null,
      refreshToken: null,
      expiresAt: 0,
      expiresIn: 0,
      scope: "",
      tokenType: "Bearer",
    };
  }
}

function writeKimiCredentials(credentialsPath, credentials) {
  const dir = path.dirname(credentialsPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort on platforms/filesystems without POSIX modes
  }

  const wire = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_at: credentials.expiresAt,
    scope: credentials.scope || "",
    token_type: credentials.tokenType || "Bearer",
    expires_in: credentials.expiresIn || 0,
  };
  const tempPath = `${credentialsPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    const data = Buffer.from(`${JSON.stringify(wire, null, 2)}\n`, "utf-8");
    let written = 0;
    while (written < data.length) {
      written += fs.writeSync(fd, data, written, data.length - written);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, credentialsPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

function shouldRefreshCredentials(credentials, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!credentials?.accessToken || !credentials?.refreshToken) return false;
  const expiresAt = Number(credentials.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  const expiresIn = Number(credentials.expiresIn);
  const threshold = Number.isFinite(expiresIn) && expiresIn > 0
    ? Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO)
    : MIN_REFRESH_THRESHOLD_SECONDS;
  return expiresAt - nowSeconds < threshold;
}

async function refreshKimiCredentials(credentials, {
  fetchImpl = fetch,
  oauthTokenUrl = KIMI_OAUTH_TOKEN_URL,
  clientId = KIMI_OAUTH_CLIENT_ID,
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!credentials?.refreshToken) return null;

  let response;
  try {
    response = await fetchImpl(oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!response?.ok) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const expiresIn = Number(body?.expires_in);
  if (
    typeof body?.access_token !== "string" || !body.access_token ||
    typeof body?.refresh_token !== "string" || !body.refresh_token ||
    !Number.isFinite(expiresIn) || expiresIn <= 0
  ) {
    return null;
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: nowSeconds() + expiresIn,
    expiresIn,
    scope: typeof body.scope === "string" ? body.scope : "",
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
  };
}

async function ensureFreshKimiCredentials({
  readCredentials = readKimiCredentials,
  writeCredentials = writeKimiCredentials,
  fetchImpl = fetch,
  credentialsPath = KIMI_CREDENTIALS_PATH,
  oauthTokenUrl = KIMI_OAUTH_TOKEN_URL,
  clientId = KIMI_OAUTH_CLIENT_ID,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  force = false,
} = {}) {
  const initial = readCredentials(credentialsPath) || {};
  if (!initial.accessToken || !initial.refreshToken) return initial;
  if (!force && !shouldRefreshCredentials(initial, nowSeconds())) return initial;

  const existing = inflightRefreshes.get(credentialsPath);
  if (existing) return existing;

  const refreshPromise = (async () => {
    // Another process (for example kimi ACP) may have refreshed after our first read.
    const latest = readCredentials(credentialsPath) || initial;
    if (!force && !shouldRefreshCredentials(latest, nowSeconds())) return latest;
    if (
      force &&
      latest.accessToken !== initial.accessToken &&
      !shouldRefreshCredentials(latest, nowSeconds())
    ) {
      return latest;
    }

    const refreshed = await refreshKimiCredentials(latest, {
      fetchImpl,
      oauthTokenUrl,
      clientId,
      nowSeconds,
    });
    if (!refreshed) return latest;
    writeCredentials(credentialsPath, refreshed);
    return refreshed;
  })().finally(() => {
    if (inflightRefreshes.get(credentialsPath) === refreshPromise) {
      inflightRefreshes.delete(credentialsPath);
    }
  });

  inflightRefreshes.set(credentialsPath, refreshPromise);
  return refreshPromise;
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
        usedPercent: (1 - used / limit) * 100,
        resetsAt: parseResetsAt(detail?.resetTime),
      };
    }
  }
  const fallback = body?.usages?.limit_5h;
  const ratio = Number(fallback?.used_ratio);
  if (fallback && Number.isFinite(ratio)) {
    return { usedPercent: (1 - ratio) * 100, resetsAt: parseResetsAt(fallback.reset_time) };
  }
  return null;
}

function pickMonthWindow(body) {
  const usages = body?.usages || {};
  const entry = usages.limit_month_total || usages.limit_month_code;
  if (!entry) return null;
  const ratio = Number(entry.used_ratio);
  if (!Number.isFinite(ratio)) return null;
  return { usedPercent: (1 - ratio) * 100, resetsAt: parseResetsAt(entry.reset_time) };
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
  writeCredentials = writeKimiCredentials,
  fetchImpl = fetch,
  credentialsPath = KIMI_CREDENTIALS_PATH,
  usagesUrl = KIMI_USAGES_URL,
  oauthTokenUrl = KIMI_OAUTH_TOKEN_URL,
  clientId = KIMI_OAUTH_CLIENT_ID,
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  const credentialOptions = {
    readCredentials,
    writeCredentials,
    fetchImpl,
    credentialsPath,
    oauthTokenUrl,
    clientId,
    nowSeconds,
  };
  let credentials = await ensureFreshKimiCredentials(credentialOptions);
  if (!credentials.accessToken) {
    return { ...normalizeKimiUsage(null), sources: { usage: "no-credentials" } };
  }

  const fetchUsage = (accessToken) => fetchImpl(usagesUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  let response;
  try {
    response = await fetchUsage(credentials.accessToken);
    // expires_at may lag reality (revocation/clock drift). Refresh once on 401,
    // then retry the quota request with the newly persisted token.
    if (response?.status === 401 && credentials.refreshToken) {
      credentials = await ensureFreshKimiCredentials({ ...credentialOptions, force: true });
      response = await fetchUsage(credentials.accessToken);
    }
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
  KIMI_OAUTH_TOKEN_URL,
  KIMI_OAUTH_CLIENT_ID,
  readKimiCredentials,
  writeKimiCredentials,
  shouldRefreshCredentials,
  refreshKimiCredentials,
  ensureFreshKimiCredentials,
  windowDurationMinutes,
  pickFiveHourWindow,
  pickMonthWindow,
  normalizeKimiUsage,
  getKimiRoleCardMetrics,
};
