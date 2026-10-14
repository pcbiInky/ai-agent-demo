/**
 * DeepSeek 原生网页搜索 provider（供 server.js 的 /api/web-search 使用）
 *
 * 调用链：permission-server WebSearch → /api/web-search → 本模块 → DeepSeek Messages API
 * （Anthropic 兼容端点 + web_search_20250305 服务端工具，搜索在 DeepSeek 云端执行）。
 *
 * 配置（只由主服务进程读取，调用者无法经 query 指定 endpoint/模型/密钥）：
 *   DEEPSEEK_API_KEY                  — 优先凭据，trim 后必须非空
 *   DEEPSEEK_SEARCH_CREDENTIALS_FILE  — 可选；显式配置时读取 dsh 格式 YAML 的
 *                                       refs.DEEPSEEK_API_KEY，不自动扫描用户目录
 *   DEEPSEEK_SEARCH_BASE_URL          — 默认 https://api.deepseek.com/anthropic/v1
 *   DEEPSEEK_SEARCH_MODEL             — 默认 deepseek-v4-flash
 *   DEEPSEEK_SEARCH_TIMEOUT_MS        — 默认 60000，有效整数范围 1000–120000
 *   DEEPSEEK_SEARCH_MAX_RESULTS       — 默认 8，有效整数范围 1–20
 *
 * 密钥只出现在请求头中，不写入日志、错误或返回值；错误以 WebSearchError(code, message)
 * 抛出，code 取 WEB_SEARCH_* 系列，供路由映射 HTTP 状态与 MCP 错误文本。
 */

const fs = require("fs");
const yaml = require("js-yaml");

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULTS = 8;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 20;
const MAX_QUERY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET_CHARS = 500;

class WebSearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
  }
}

// 规范化查询：trim 后非空且不超过长度上限；不合法返回 null
function normalizeQuery(query) {
  if (typeof query !== "string") return null;
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_LENGTH) return null;
  return trimmed;
}

function parseIntInRange(raw, fallback, min, max, name) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", `${name} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function normalizeBaseUrl(raw) {
  const value = (raw && String(raw).trim()) || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", "DEEPSEEK_SEARCH_BASE_URL 不是合法 URL");
  }
  if (url.protocol !== "https:") {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", "DEEPSEEK_SEARCH_BASE_URL 必须是 HTTPS URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", "DEEPSEEK_SEARCH_BASE_URL 不允许包含凭据、query 或 fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function loadConfig(env = process.env) {
  return {
    baseUrl: normalizeBaseUrl(env.DEEPSEEK_SEARCH_BASE_URL),
    model: (env.DEEPSEEK_SEARCH_MODEL && String(env.DEEPSEEK_SEARCH_MODEL).trim()) || DEFAULT_MODEL,
    timeoutMs: parseIntInRange(env.DEEPSEEK_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "DEEPSEEK_SEARCH_TIMEOUT_MS"),
    maxResults: parseIntInRange(env.DEEPSEEK_SEARCH_MAX_RESULTS, DEFAULT_MAX_RESULTS, MIN_MAX_RESULTS, MAX_MAX_RESULTS, "DEEPSEEK_SEARCH_MAX_RESULTS"),
  };
}

// 凭据优先级：DEEPSEEK_API_KEY > 显式配置的 dsh 凭据文件；每次调用重新解析，
// 允许 dsh 更新保存的 key 后下一次搜索即生效。任何失败都不输出文件内容或密钥。
function resolveApiKey(env = process.env) {
  const direct = typeof env.DEEPSEEK_API_KEY === "string" ? env.DEEPSEEK_API_KEY.trim() : "";
  if (direct) return { apiKey: direct, source: "env" };

  const file = typeof env.DEEPSEEK_SEARCH_CREDENTIALS_FILE === "string" ? env.DEEPSEEK_SEARCH_CREDENTIALS_FILE.trim() : "";
  if (!file) {
    throw new WebSearchError(
      "WEB_SEARCH_CREDENTIAL_MISSING",
      "未配置搜索凭据：请设置 DEEPSEEK_API_KEY 或 DEEPSEEK_SEARCH_CREDENTIALS_FILE"
    );
  }

  let content;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", "凭据文件不存在或不可读（DEEPSEEK_SEARCH_CREDENTIALS_FILE）");
  }

  let doc;
  try {
    doc = yaml.load(content);
  } catch {
    throw new WebSearchError("WEB_SEARCH_CONFIG_ERROR", "凭据文件不是合法 YAML（DEEPSEEK_SEARCH_CREDENTIALS_FILE）");
  }

  const key = doc && typeof doc === "object" && doc.refs && typeof doc.refs === "object"
    ? doc.refs.DEEPSEEK_API_KEY
    : undefined;
  if (typeof key !== "string" || !key.trim()) {
    throw new WebSearchError("WEB_SEARCH_CREDENTIAL_MISSING", "凭据文件缺少非空字符串 refs.DEEPSEEK_API_KEY");
  }
  return { apiKey: key.trim(), source: "file" };
}

function buildRequestBody(query, model) {
  return {
    model,
    max_tokens: 4096,
    messages: [
      { role: "user", content: `Perform a web search for the query: ${query}` },
    ],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    ],
  };
}

function isValidHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function pickNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// 从 text 块的 citations 中按 URL 收集 cited_text（去重拼接，每条最多 500 字符）
function collectSnippetsByUrl(contentBlocks) {
  const map = new Map();
  for (const block of contentBlocks) {
    if (!block || block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (!citation || typeof citation.url !== "string" || typeof citation.cited_text !== "string") continue;
      const text = citation.cited_text.trim();
      if (!text) continue;
      const list = map.get(citation.url) || [];
      if (!list.includes(text)) list.push(text);
      map.set(citation.url, list);
    }
  }
  return map;
}

// 解析 DeepSeek Messages 响应 → 标准化结果；任何协议异常都抛 WebSearchError
function parseUpstreamResponse(body, { query, model, maxResults, elapsedMs }) {
  const content = Array.isArray(body?.content) ? body.content : [];
  const resultBlocks = content.filter((block) => block && block.type === "web_search_tool_result");

  if (resultBlocks.length === 0) {
    throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "上游响应缺少 web_search_tool_result，模型未执行搜索");
  }

  const items = [];
  for (const block of resultBlocks) {
    const blockContent = block.content;
    // content 是对象：仅识别 web_search_tool_result_error，其余结构均属协议异常
    if (blockContent && typeof blockContent === "object" && !Array.isArray(blockContent)) {
      if (blockContent.type === "web_search_tool_result_error") {
        throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `搜索工具执行失败: ${blockContent.error_code || "未知错误"}`);
      }
      throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "结果块 content 结构无法识别（既不是条目数组也不是已知错误对象）");
    }
    if (!Array.isArray(blockContent)) {
      throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "结果块缺少 content 条目数组");
    }
    let blockResultCount = 0;
    for (const item of blockContent) {
      if (item && item.type === "web_search_tool_result_error") {
        throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `搜索工具执行失败: ${item.error_code || "未知错误"}`);
      }
      if (item && item.type === "web_search_result") {
        blockResultCount += 1;
        items.push(item);
      }
    }
    // 非空数组全部是不合法／未知条目：不能伪装成合法空结果
    if (blockContent.length > 0 && blockResultCount === 0) {
      throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "结果块 content 非空但没有任何可识别的搜索条目");
    }
  }

  const snippetsByUrl = collectSnippetsByUrl(content);
  const seen = new Set();
  const valid = [];
  for (const item of items) {
    if (!isValidHttpUrl(item.url)) continue; // 忽略损坏条目
    if (seen.has(item.url)) continue; // 按 URL 去重，保留首次出现
    seen.add(item.url);
    valid.push(item);
  }

  if (items.length > 0 && valid.length === 0) {
    throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "搜索结果条目全部损坏（无有效 http/https URL）");
  }

  const truncated = valid.length > maxResults;
  const sources = valid.slice(0, maxResults).map((item) => {
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url;
    const source = { title, url: item.url };
    const snippet = (snippetsByUrl.get(item.url) || []).join(" ").slice(0, MAX_SNIPPET_CHARS);
    if (snippet) source.snippet = snippet;
    if (typeof item.page_age === "string" && item.page_age.trim()) {
      source.publishedAt = item.page_age.trim();
    }
    return source;
  });

  const usageRaw = body?.usage && typeof body.usage === "object" ? body.usage : {};
  const usage = {};
  const inputTokens = pickNonNegativeNumber(usageRaw.input_tokens);
  const outputTokens = pickNonNegativeNumber(usageRaw.output_tokens);
  const webSearchRequests = pickNonNegativeNumber(usageRaw.server_tool_use?.web_search_requests);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (webSearchRequests !== undefined) usage.webSearchRequests = webSearchRequests;

  return {
    provider: "deepseek",
    query,
    model,
    sources,
    truncated,
    elapsedMs,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

// 流式读取响应体并强制 2 MiB 上限，超限及时取消
async function readLimitedBody(res) {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value || new Uint8Array(0);
        total += bytes.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游响应超过 ${MAX_RESPONSE_BYTES} 字节上限`);
        }
        chunks.push(bytes);
      }
    } catch (err) {
      // 提前放弃响应（超限、上游流错误等）：取消底层流，释放上游连接资源
      try { await reader.cancel(); } catch { /* ignore */ }
      throw err;
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  }
  // 注入的测试 fake 可能没有流式 body
  const text = typeof res.text === "function" ? await res.text() : "";
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游响应超过 ${MAX_RESPONSE_BYTES} 字节上限`);
  }
  return text;
}

// 非 2xx / 重定向等提前拒绝路径：取消尚未读取的响应体，释放底层连接
async function discardBody(res) {
  const body = res?.body;
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch { /* ignore */ }
}

function upstreamStatusError(status) {
  if (status === 401 || status === 403) {
    return new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游拒绝请求（HTTP ${status}）：搜索凭据无效或没有权限`);
  }
  if (status === 429) {
    return new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游限流（HTTP 429）：搜索额度不足或请求过于频繁`);
  }
  if (status >= 500) {
    return new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游服务不可用（HTTP ${status}）`);
  }
  return new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游返回非预期状态（HTTP ${status}）`);
}

/**
 * 执行一次网页搜索。
 * @param {string} query 查询词（内部会 trim 并校验长度）
 * @param {object} [options]
 * @param {object} [options.env] 配置来源，默认 process.env
 * @param {Function} [options.fetchImpl] 可注入 fetch，便于离线测试
 * @param {AbortSignal} [options.signal] 调用方取消信号（如客户端断开）
 * @returns {Promise<object>} 标准化结果（见 parseUpstreamResponse）
 */
async function searchDeepSeekWeb(query, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const callerSignal = options.signal;

  const normalized = normalizeQuery(query);
  if (normalized === null) {
    throw new WebSearchError("WEB_SEARCH_INVALID_INPUT", `query 必须是 trim 后非空且不超过 ${MAX_QUERY_LENGTH} 字符的字符串`);
  }

  const config = loadConfig(env);
  const { apiKey } = resolveApiKey(env); // 无凭据时在此抛错，绝不发起上游请求

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  // 不 unref：调用方正在 await 本次搜索，定时器必须能撑住事件循环直到超时触发
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(normalized, config.model)),
      redirect: "manual", // 拒绝带密钥跳转到其他目标
      signal: controller.signal,
    });

    const status = res?.status ?? 0;
    if (status >= 300 && status < 400) {
      await discardBody(res);
      throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `上游返回重定向（HTTP ${status}），已拒绝跟随`);
    }
    if (status < 200 || status >= 300) {
      await discardBody(res);
      throw upstreamStatusError(status);
    }

    const text = await readLimitedBody(res);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new WebSearchError("WEB_SEARCH_PROTOCOL_ERROR", "上游响应不是合法 JSON");
    }
    return parseUpstreamResponse(body, {
      query: normalized,
      model: config.model,
      maxResults: config.maxResults,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    if (timedOut) {
      throw new WebSearchError("WEB_SEARCH_TIMEOUT", `搜索超时（${config.timeoutMs}ms）`);
    }
    if (callerSignal?.aborted) {
      throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", "调用方已取消本次搜索");
    }
    if (err?.name === "AbortError") {
      throw new WebSearchError("WEB_SEARCH_TIMEOUT", `搜索请求被中止（${config.timeoutMs}ms）`);
    }
    // 网络层失败：只保留异常类型信息，不透传可能含秘密的底层细节
    throw new WebSearchError("WEB_SEARCH_UPSTREAM_ERROR", `无法连接搜索服务: ${err?.code || err?.name || "网络错误"}`);
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener?.("abort", onCallerAbort);
  }
}

module.exports = {
  WebSearchError,
  normalizeQuery,
  loadConfig,
  resolveApiKey,
  buildRequestBody,
  parseUpstreamResponse,
  searchDeepSeekWeb,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_RESULTS,
  MAX_RESPONSE_BYTES,
  MAX_QUERY_LENGTH,
};
