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
 * 账号 Credits 汇总为「余额」剩余百分比；「ctx」展示上下文已用百分比，
 * 与其他角色的 ctx 一样从 0% 向上增长。
 */

const QODERCN_PROJECTS_DIR =
  process.env.QODERCN_PROJECTS_DIR || path.join(os.homedir(), ".qoder-cn", "projects");

const QODERCN_CTX_WINDOW = { key: "ctx", label: "ctx" };
const QODERCN_BALANCE_PLACEHOLDER = {
  key: "balance", label: "余额", usedPercent: null, resetsAt: null, detail: "账号额度暂不可用",
};

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

/** 将同单位的套餐、加购和组织 Credits 汇总为一条余额；缺少关键字段时不猜测。 */
function buildQodercnBalanceWindow(usageInfo) {
  if (!usageInfo || typeof usageInfo !== "object") return null;
  const buckets = [];
  for (const [bucket, totalKey] of [
    [usageInfo.userQuota, "total"],
    [usageInfo.addOnQuota, "total"],
    [usageInfo.orgResourcePackage, "cap"],
  ]) {
    if (!bucket || bucket.available === false) continue;
    if (bucket[totalKey] == null || bucket.remaining == null) return null;
    const total = Number(bucket[totalKey]);
    const remaining = Number(bucket.remaining);
    if (!Number.isFinite(total) || !Number.isFinite(remaining) || total < 0 || remaining < 0) return null;
    if (total === 0 && remaining === 0) continue;
    if (total === 0) return null;
    buckets.push({ total, remaining, unit: String(bucket.unit || "credits").toLowerCase() });
  }
  if (buckets.length === 0 || buckets.some((bucket) => bucket.unit !== buckets[0].unit)) return null;
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const remaining = buckets.reduce((sum, bucket) => sum + bucket.remaining, 0);
  return {
    key: "balance",
    label: "余额",
    // 非满额不能四舍五入成 100%，避免有消耗时仍显示满额。
    usedPercent: Math.max(0, Math.min(100, Math.floor((remaining / total) * 100))),
    resetsAt: null,
    detail: `剩余 ${remaining} / 总量 ${total} ${buckets[0].unit}`,
  };
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
  if (contextUsageRatio == null || contextUsageRatio === "") return emptyQodercnMetrics();
  const ratio = Number(contextUsageRatio);
  if (!Number.isFinite(ratio)) return emptyQodercnMetrics();
  const clamped = Math.max(0, Math.min(1, ratio));
  return buildUsageMetrics(
    [{ ...QODERCN_CTX_WINDOW, usedPercent: clamped * 100, resetsAt: null }],
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

/** 实时 ctx 事件只更新 ctx 窗口，不应抹掉先前查询到的账号额度。 */
function mergeQodercnContextMetrics(existing, patch) {
  const windows = patch?.usageWindows;
  if (patch?.sources || !Array.isArray(windows) || windows.length !== 1 || windows[0]?.key !== "ctx") {
    return patch;
  }
  const balanceWindow = existing?.usageWindows?.find((window) => window.key === "balance");
  if (!balanceWindow) return patch;
  return buildUsageMetrics([balanceWindow, ...windows], patch);
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
  let quotaError = null;
  try {
    usageInfo = await fetchUsageInfo();
  } catch (error) {
    // 只记录错误类型，避免 SDK 异常文本意外包含认证信息。
    quotaError = error?.code || error?.name || "unknown";
    console.warn(`[qodercn-metrics] account quota query failed (${quotaError})`);
  }
  const balanceWindow = buildQodercnBalanceWindow(usageInfo);
  const metrics = buildUsageMetrics(
    [balanceWindow || QODERCN_BALANCE_PLACEHOLDER, ...contextMetrics.usageWindows],
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
      quota: balanceWindow ? "qodercn-agent-sdk" : "unavailable",
      ...(quotaError && { quotaError }),
    },
  };
}

module.exports = {
  QODERCN_PROJECTS_DIR,
  QODERCN_CTX_WINDOW,
  QODERCN_BALANCE_PLACEHOLDER,
  emptyQodercnMetrics,
  buildQodercnContextMetrics,
  mergeQodercnContextMetrics,
  buildQodercnBalanceWindow,
  queryQodercnUsageInfo,
  findQodercnTranscriptPath,
  readQodercnContextUsageRatio,
  getQodercnRoleCardMetrics,
};
