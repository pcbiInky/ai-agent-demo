"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildUsageMetrics } = require("./usage-metrics");

/**
 * DeepSeek Harness 账号余额。
 *
 * DSH 本身会从 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`
 * 读取 DeepSeek API key。这里复用同一个凭据调用官方余额接口，但只把余额
 * 映射为 0-100 的“余额充足度”；原始金额不会进入 role-card metrics。
 */

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DSH_CREDENTIALS_PATH =
  process.env.DSH_CREDENTIALS_PATH || path.join(DSH_HOME, ".credentials.yaml");
const DSH_BALANCE_URL =
  process.env.DSH_BALANCE_URL || "https://api.deepseek.com/user/balance";
const DSH_BALANCE_CURRENCY = process.env.DSH_BALANCE_CURRENCY || "CNY";

const configuredFullAmount = Number(process.env.DSH_BALANCE_FULL_AMOUNT);
const DSH_BALANCE_FULL_AMOUNT =
  Number.isFinite(configuredFullAmount) && configuredFullAmount > 0
    ? configuredFullAmount
    : 50;

function parseYamlScalar(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "null" || value === "~") return null;

  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" && parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return null;
    const parsed = value.slice(1, -1).replace(/''/g, "'");
    return parsed || null;
  }

  // YAML plain scalar 的注释必须由空白与 # 分隔；API key 本身不会包含空白。
  const parsed = value.replace(/\s+#.*$/, "").trim();
  return parsed || null;
}

/**
 * 读取 DSH 的 DeepSeek API key。启动环境优先级与 DSH 自身一致。
 * 这里只解析 credentials 文档中的 refs 段，避免误读 records/env 内同名字段。
 */
function readDshCredentials(credentialsPath = DSH_CREDENTIALS_PATH) {
  if (process.env.DEEPSEEK_API_KEY) {
    return { apiKey: process.env.DEEPSEEK_API_KEY };
  }

  let text;
  try {
    text = fs.readFileSync(credentialsPath, "utf8");
  } catch {
    return { apiKey: null };
  }

  let refsIndent = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    if (refsIndent === null) {
      const refs = line.match(/^(\s*)refs\s*:\s*(?:#.*)?$/);
      if (refs) refsIndent = refs[1].length;
      continue;
    }

    const indent = line.match(/^\s*/)[0].length;
    if (indent <= refsIndent) break;

    const entry = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$/);
    if (!entry) continue;
    return { apiKey: parseYamlScalar(entry[1]) };
  }

  return { apiKey: null };
}

function emptyDshMetrics() {
  return buildUsageMetrics([], {
    supportsUsageWindows: false,
    supportsTokenUsage: false,
    contextTokens: null,
    totalTokens: null,
    modelContextWindow: null,
    contextCompactedAt: null,
  });
}

/**
 * 把 DeepSeek balance 响应归一化为角色卡片的剩余百分比。
 * 真实余额只在本函数栈内参与计算，不会出现在返回对象中。
 */
function normalizeDshBalance(
  body,
  { fullAmount = DSH_BALANCE_FULL_AMOUNT, currency = DSH_BALANCE_CURRENCY } = {}
) {
  const target = Number(fullAmount);
  if (!Number.isFinite(target) || target <= 0) return emptyDshMetrics();

  const balances = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const entry = balances.find((item) => item?.currency === currency);
  const rawBalance = entry?.total_balance;
  if (rawBalance === null || rawBalance === undefined || String(rawBalance).trim() === "") {
    return emptyDshMetrics();
  }

  const balance = Number(rawBalance);
  if (!Number.isFinite(balance)) return emptyDshMetrics();

  return buildUsageMetrics(
    [
      {
        key: "balance",
        label: "余额",
        usedPercent: (balance / target) * 100,
        resetsAt: null,
      },
    ],
    {
      supportsUsageWindows: true,
      supportsTokenUsage: false,
      contextTokens: null,
      totalTokens: null,
      modelContextWindow: null,
      contextCompactedAt: null,
    }
  );
}

async function getDshRoleCardMetrics({
  readCredentials = readDshCredentials,
  fetchImpl = fetch,
  credentialsPath = DSH_CREDENTIALS_PATH,
  balanceUrl = DSH_BALANCE_URL,
  fullAmount = DSH_BALANCE_FULL_AMOUNT,
  currency = DSH_BALANCE_CURRENCY,
} = {}) {
  const credentials = readCredentials(credentialsPath) || {};
  if (!credentials.apiKey) {
    return { ...emptyDshMetrics(), sources: { usage: "no-credentials" } };
  }

  let response;
  try {
    response = await fetchImpl(balanceUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ...emptyDshMetrics(), sources: { usage: "fetch-error" } };
  }

  if (!response || !response.ok) {
    return { ...emptyDshMetrics(), sources: { usage: "http-error" } };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ...emptyDshMetrics(), sources: { usage: "invalid-json" } };
  }

  const metrics = normalizeDshBalance(body, { fullAmount, currency });
  return {
    ...metrics,
    sources: {
      usage: metrics.supportsUsageWindows ? "deepseek-balance-api" : "invalid-balance",
    },
  };
}

module.exports = {
  DSH_CREDENTIALS_PATH,
  DSH_BALANCE_URL,
  DSH_BALANCE_CURRENCY,
  DSH_BALANCE_FULL_AMOUNT,
  parseYamlScalar,
  readDshCredentials,
  normalizeDshBalance,
  getDshRoleCardMetrics,
};
