const { spawn, execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_SQLITE_PATH = path.join(os.homedir(), ".codex", "state_5.sqlite");
const APP_SERVER_INIT_TIMEOUT_MS = 10_000;
const APP_SERVER_CALL_TIMEOUT_MS = 15_000;
const SQLITE_TIMEOUT_MS = 5_000;

function sqlQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function createAppServerChannel() {
  return new Promise((resolveChannel, rejectChannel) => {
    const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    let initialized = false;
    const pendingCalls = new Map();
    let buffer = "";

    const cleanup = () => {
      try {
        proc.kill();
      } catch {
        // ignore cleanup errors
      }
    };

    proc.on("error", (err) => {
      cleanup();
      rejectChannel(new Error(`app-server spawn failed: ${err.message}`));
    });

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || !pendingCalls.has(message.id)) continue;
        const { resolve, reject, timeoutId } = pendingCalls.get(message.id);
        clearTimeout(timeoutId);
        pendingCalls.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message || "app-server call failed"));
        } else {
          resolve(message.result);
        }
      }
    });

    proc.on("close", () => {
      for (const [, { reject, timeoutId }] of pendingCalls) {
        clearTimeout(timeoutId);
        reject(new Error("app-server closed"));
      }
      pendingCalls.clear();
    });

    const initId = randomUUID();
    const initTimeoutId = setTimeout(() => {
      pendingCalls.delete(initId);
      cleanup();
      rejectChannel(new Error("app-server init timeout"));
    }, APP_SERVER_INIT_TIMEOUT_MS);

    pendingCalls.set(initId, {
      resolve: () => {
        clearTimeout(initTimeoutId);
        initialized = true;
        resolveChannel({
          call(method, params = {}) {
            return new Promise((resolve, reject) => {
              if (!initialized) {
                reject(new Error("app-server not initialized"));
                return;
              }
              const id = randomUUID();
              const timeoutId = setTimeout(() => {
                pendingCalls.delete(id);
                reject(new Error(`app-server call ${method} timeout`));
              }, APP_SERVER_CALL_TIMEOUT_MS);
              pendingCalls.set(id, { resolve, reject, timeoutId });
              proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            });
          },
          close: cleanup,
        });
      },
      reject: (err) => {
        clearTimeout(initTimeoutId);
        rejectChannel(err);
      },
      timeoutId: initTimeoutId,
    });

    proc.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2.0",
        capabilities: {},
        clientInfo: { name: "ai-agent-demo", version: "1.0" },
      },
    })}\n`);
  });
}

async function getCodexAccountMetrics({ channel } = {}) {
  let ownChannel = false;
  const activeChannel = channel || await createAppServerChannel();
  ownChannel = !channel;
  try {
    const result = await activeChannel.call("account/rateLimits/read");
    const rateLimits = result?.rateLimits || null;
    const primaryResetsAt = rateLimits?.primary?.resetsAt != null ? Number(rateLimits.primary.resetsAt) * 1000 : null;
    const secondaryResetsAt = rateLimits?.secondary?.resetsAt != null ? Number(rateLimits.secondary.resetsAt) * 1000 : null;
    return {
      primaryUsedPercent: rateLimits?.primary?.usedPercent ?? null,
      secondaryUsedPercent: rateLimits?.secondary?.usedPercent ?? null,
      primaryResetsAt: Number.isFinite(primaryResetsAt) ? primaryResetsAt : null,
      secondaryResetsAt: Number.isFinite(secondaryResetsAt) ? secondaryResetsAt : null,
      rateLimits,
      source: "app-server",
    };
  } finally {
    if (ownChannel) activeChannel.close();
  }
}

function parseRolloutMetrics(rolloutPath) {
  const metrics = {};
  let contextCompactedAt = null;
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return { metrics, contextCompactedAt };
  }

  const lines = fs.readFileSync(rolloutPath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "event_msg") continue;
    const payload = entry.payload || {};
    if (payload.type === "token_count") {
      const info = payload.info || {};
      if (info.last_token_usage?.total_tokens != null) {
        metrics.contextTokens = info.last_token_usage.total_tokens;
      }
      if (info.total_token_usage?.total_tokens != null) {
        metrics.totalTokens = info.total_token_usage.total_tokens;
      }
      if (info.model_context_window != null) {
        metrics.modelContextWindow = info.model_context_window;
      }
    } else if (payload.type === "context_compacted" && entry.timestamp) {
      const compactedAt = new Date(entry.timestamp).getTime();
      if (!Number.isNaN(compactedAt)) contextCompactedAt = compactedAt;
    }
  }

  return { metrics, contextCompactedAt };
}

function getThreadPersistence(threadId) {
  if (!threadId) {
    return { rolloutPath: "", threadTotalTokens: null };
  }
  try {
    const query = `SELECT rollout_path, tokens_used FROM threads WHERE id = ${sqlQuote(threadId)};`;
    const output = execFileSync("sqlite3", ["-json", CODEX_SQLITE_PATH, query], {
      encoding: "utf-8",
      timeout: SQLITE_TIMEOUT_MS,
    }).trim();
    if (!output) return { rolloutPath: "", threadTotalTokens: null };
    const rows = JSON.parse(output);
    const row = Array.isArray(rows) ? rows[0] : null;
    const parsedTotal = row?.tokens_used == null ? null : Number(row.tokens_used);
    return {
      rolloutPath: typeof row?.rollout_path === "string" ? row.rollout_path : "",
      threadTotalTokens: Number.isFinite(parsedTotal) ? parsedTotal : null,
    };
  } catch {
    return { rolloutPath: "", threadTotalTokens: null };
  }
}

async function getCodexThreadMetrics(threadId) {
  const { rolloutPath, threadTotalTokens } = getThreadPersistence(threadId);
  const { metrics, contextCompactedAt } = parseRolloutMetrics(rolloutPath);
  if (metrics.totalTokens == null && threadTotalTokens != null) {
    metrics.totalTokens = threadTotalTokens;
  }
  return {
    ...metrics,
    contextCompactedAt,
    source: "local-fallback",
  };
}

async function getCodexRoleCardMetrics(threadId, { channel } = {}) {
  const [account, thread] = await Promise.all([
    getCodexAccountMetrics({ channel }).catch(() => ({ primaryUsedPercent: null, secondaryUsedPercent: null, source: "app-server" })),
    getCodexThreadMetrics(threadId).catch(() => ({ source: "local-fallback" })),
  ]);

  return {
    supportsUsageWindows: true,
    supportsTokenUsage: true,
    primaryUsedPercent: account.primaryUsedPercent ?? null,
    secondaryUsedPercent: account.secondaryUsedPercent ?? null,
    primaryResetsAt: account.primaryResetsAt ?? null,
    secondaryResetsAt: account.secondaryResetsAt ?? null,
    contextTokens: thread.contextTokens ?? null,
    totalTokens: thread.totalTokens ?? null,
    modelContextWindow: thread.modelContextWindow ?? null,
    contextCompactedAt: thread.contextCompactedAt ?? null,
    sources: {
      rateLimits: account.source || "app-server",
      tokenUsage: thread.source || "local-fallback",
    },
  };
}

module.exports = {
  CODEX_SQLITE_PATH,
  createAppServerChannel,
  getCodexAccountMetrics,
  parseRolloutMetrics,
  getThreadPersistence,
  getCodexThreadMetrics,
  getCodexRoleCardMetrics,
};
