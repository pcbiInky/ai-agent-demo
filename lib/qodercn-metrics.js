"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildUsageMetrics } = require("./usage-metrics");

/**
 * Qoder CN 角色卡片指标。
 *
 * 账号 Credits 通过官方 Qoder Agent SDK 的 getUsageInfo() 查询；
 * qodercliAuth() 复用本机 qoderclicn 登录态，无需读取或解密凭据。
 * 会话上下文用量来自每次 invoke 落盘的 transcript：
 *   ~/.qoder-cn/projects/<cwd-slug>/<sessionId>.jsonl
 *   - assistant/result 事件的 usage.context_usage_ratio（上下文占用比例 0-1）
 *   - result 事件的 total_credits（本次会话消耗，非账号余额，不做百分比）
 *
 * 与其他 CLI 的约定一致：usageWindows[].usedPercent 存“剩余”百分比，
 * 前端在低于 20% 时标红。账号额度与上下文用量分别展示。
 */

const QODERCN_PROJECTS_DIR =
  process.env.QODERCN_PROJECTS_DIR || path.join(os.homedir(), ".qoder-cn", "projects");

const QODERCN_CTX_WINDOW = { key: "ctx", label: "上下文剩余" };

async function queryQodercnUsageInfo({
  command = process.env.QODERCN_CLI_COMMAND || "qoderclicn",
  timeoutMs = 12000,
} = {}) {
  const { query, qodercliAuth } = await import("@qodercn-ai/qodercn-agent-sdk");
  let releaseInput;
  async function* noPrompt() {
    await new Promise((resolve) => { releaseInput = resolve; });
  }

  const abortController = new AbortController();
  const q = query({
    prompt: noPrompt(),
    options: {
      auth: qodercliAuth(),
      cwd: process.cwd(),
      pathToQoderCLIExecutable: command,
      abortController,
    },
  });
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    await q.initializationResult();
    return await q.getUsageInfo();
  } finally {
    clearTimeout(timer);
    releaseInput?.();
    await q.close().catch(() => {});
  }
}

function remainingPercent(bucket, totalKey = "total") {
  if (!bucket || typeof bucket !== "object") return undefined;
  const total = bucket[totalKey];
  const remaining = bucket.remaining;
  if (total != null && remaining != null && Number(total) > 0 && Number.isFinite(Number(remaining))) {
    return (Number(remaining) / Number(total)) * 100;
  }
  if (bucket.percentage != null && Number.isFinite(Number(bucket.percentage))) {
    return 100 - Number(bucket.percentage);
  }
  return undefined;
}

function quotaWindow(bucket, key, label, totalKey = "total") {
  if (!bucket || typeof bucket !== "object") return null;
  const total = bucket[totalKey];
  const remaining = bucket.remaining;
  const unit = bucket.unit || "Credits";
  const detail = total != null && remaining != null
    ? `剩余 ${remaining} / 总量 ${total} ${unit}`
    : undefined;
  return {
    key,
    label,
    usedPercent: remainingPercent(bucket, totalKey),
    resetsAt: null,
    detail,
  };
}

function buildQodercnQuotaWindows(usageInfo) {
  if (!usageInfo || typeof usageInfo !== "object") return [];
  return [
    quotaWindow(usageInfo.userQuota, "plan", "套餐剩余"),
    quotaWindow(usageInfo.addOnQuota, "addon", "加购剩余"),
    usageInfo.orgResourcePackage?.available === false
      ? null
      : quotaWindow(usageInfo.orgResourcePackage, "org", "组织资源包", "cap"),
  ].filter(Boolean);
}

function emptyQodercnMetrics() {
  // usedPercent 必须是 undefined 而非 null：buildUsageMetrics 的 normalizeWindow
  // 会把 null 经 Number(null) 归一化成 0%，空状态应渲染为 "--" 而不是红色的 0%。
  return buildUsageMetrics([{ ...QODERCN_CTX_WINDOW, usedPercent: undefined, resetsAt: null }], {
    supportsUsageWindows: true,
    supportsTokenUsage: false,
    contextTokens: null,
    totalTokens: null,
    modelContextWindow: null,
    contextCompactedAt: null,
  });
}

/**
 * 由 context_usage_ratio（已用比例 0-1）构造角色卡片 metrics。
 * invoke 的 result 事件与 transcript 兜底共用同一份归一化逻辑。
 */
function buildQodercnContextMetrics(contextUsageRatio) {
  const ratio = Number(contextUsageRatio);
  if (!Number.isFinite(ratio)) return emptyQodercnMetrics();
  const clamped = Math.max(0, Math.min(1, ratio));
  return buildUsageMetrics(
    [{ ...QODERCN_CTX_WINDOW, usedPercent: (1 - clamped) * 100, resetsAt: null }],
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

/**
 * 在 projects 目录下定位指定 session 的 transcript；
 * 同一 sessionId 理论上只属于一个项目目录，重名时取最近修改的。
 */
function findQodercnTranscriptPath(sessionId, projectsDir = QODERCN_PROJECTS_DIR) {
  if (!sessionId) return null;
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(candidate);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { filePath: candidate, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // 该项目目录下没有这个 session
    }
  }
  return best ? best.filePath : null;
}

/**
 * 从 transcript 末尾向前找最近的 context_usage_ratio。
 * assistant 事件在 message.usage 上，result 事件在 usage 上。
 */
function readQodercnContextUsageRatio(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("context_usage_ratio")) continue;
    try {
      const event = JSON.parse(line);
      const ratio = event?.type === "assistant"
        ? event?.message?.usage?.context_usage_ratio
        : event?.usage?.context_usage_ratio;
      if (Number.isFinite(Number(ratio))) return Number(ratio);
    } catch {
      // 跳过无法解析的行
    }
  }
  return null;
}

/**
 * 获取 qodercn 角色卡片 metrics。
 * @param {string|null} providerSessionId - qoderclicn 的 session_id（system/init 事件上报）
 * @param {object} [options]
 * @param {string} [options.projectsDir] - transcript 根目录覆盖（测试注入）
 * @param {Function} [options.fetchUsageInfo] - SDK 查询覆盖（测试注入）
 * @returns {Promise<object>}
 */
async function getQodercnRoleCardMetrics(providerSessionId, {
  projectsDir = QODERCN_PROJECTS_DIR,
  fetchUsageInfo = queryQodercnUsageInfo,
} = {}) {
  let contextMetrics = emptyQodercnMetrics();
  let contextSource = "no-session";
  if (providerSessionId) {
    const transcriptPath = findQodercnTranscriptPath(providerSessionId, projectsDir);
    contextSource = transcriptPath ? "no-usage-data" : "no-transcript";
    if (transcriptPath) {
      const ratio = readQodercnContextUsageRatio(transcriptPath);
      if (ratio !== null) {
        contextMetrics = buildQodercnContextMetrics(ratio);
        contextSource = "transcript";
      }
    }
  }

  let usageInfo = null;
  try {
    usageInfo = await fetchUsageInfo();
  } catch {
    // 账号额度暂时不可用时保留会话上下文指标
  }
  const quotaWindows = buildQodercnQuotaWindows(usageInfo);
  const metrics = buildUsageMetrics(
    [...quotaWindows, ...contextMetrics.usageWindows],
    {
      supportsUsageWindows: true,
      supportsTokenUsage: false,
      contextTokens: null,
      totalTokens: null,
      modelContextWindow: null,
      contextCompactedAt: null,
    }
  );
  return {
    ...metrics,
    sources: {
      usage: contextSource,
      quota: quotaWindows.length > 0 ? "qodercn-agent-sdk" : "unavailable",
    },
  };
}

module.exports = {
  QODERCN_PROJECTS_DIR,
  QODERCN_CTX_WINDOW,
  emptyQodercnMetrics,
  buildQodercnContextMetrics,
  buildQodercnQuotaWindows,
  queryQodercnUsageInfo,
  findQodercnTranscriptPath,
  readQodercnContextUsageRatio,
  getQodercnRoleCardMetrics,
};
