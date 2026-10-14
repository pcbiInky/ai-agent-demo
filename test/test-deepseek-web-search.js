#!/usr/bin/env node

/**
 * lib/deepseek-web-search.js 离线测试
 *
 * 全部通过注入的 fetchImpl 运行，不连接付费 API。覆盖：
 * 1. 请求 endpoint / headers / 工具声明 / JSON 编码（含引号与换行的 query）
 * 2. 多块合并、去重、截断、空标题 / null 日期、引用摘要、合法空结果
 * 3. 无结果块（即使文本含链接）、工具错误块、损坏 JSON、全部损坏来源都失败
 * 4. 凭据优先级、显式 YAML 文件、无凭据（上游调用数为 0）、坏文件、无效配置
 * 5. 401 / 429 / 5xx / 超时 / 超大响应 / 调用方取消都正确失败；密钥不出现在错误中
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  WebSearchError,
  normalizeQuery,
  loadConfig,
  resolveApiKey,
  searchDeepSeekWeb,
} = require("../lib/deepseek-web-search");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}

async function expectError(promise, code, label) {
  try {
    await promise;
    console.error(`FAIL ${label}（未抛错）`);
    failed += 1;
    return null;
  } catch (err) {
    const ok = err instanceof WebSearchError && err.code === code;
    if (ok) {
      console.log(`PASS ${label}`);
      passed += 1;
    } else {
      console.error(`FAIL ${label}（实际 ${err?.code || err?.name}: ${err?.message}）`);
      failed += 1;
    }
    return err;
  }
}

const KEY = "test-api-key-secret";

function makeResponse(payload, status = 200) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function okFetch(body, status = 200) {
  return recordingFetch(async () => makeResponse(body, status)).fetchImpl;
}

function resultBlock(items) {
  return { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: items };
}

function searchItem(url, title, pageAge) {
  return { type: "web_search_result", url, title, page_age: pageAge, encrypted_content: "enc" };
}

const ENV = { DEEPSEEK_API_KEY: KEY };

async function main() {
  // ── 1. 请求结构与 JSON 编码 ─────────────────────────────
  {
    const { calls, fetchImpl } = recordingFetch(async () =>
      makeResponse({ content: [resultBlock([])], usage: { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 1 } } })
    );
    const trickyQuery = '带"引号"与\n换行的 query';
    const result = await searchDeepSeekWeb(`  ${trickyQuery}  `, { env: ENV, fetchImpl });

    assert(calls.length === 1, "一次 WebSearch 只发一次上游请求");
    const { url, init } = calls[0];
    assert(url === "https://api.deepseek.com/anthropic/v1/messages", "默认 endpoint 追加 /messages");
    assert(init.method === "POST", "请求方法是 POST");
    assert(init.headers["Content-Type"] === "application/json", "Content-Type 正确");
    assert(init.headers["anthropic-version"] === "2023-06-01", "anthropic-version 头正确");
    assert(init.headers["x-api-key"] === KEY, "x-api-key 头携带密钥");
    assert(init.headers["Authorization"] === `Bearer ${KEY}`, "Authorization 头携带同一密钥");
    assert(init.redirect === "manual", "拒绝 HTTP 重定向");

    const body = JSON.parse(init.body);
    assert(body.model === "deepseek-v4-flash", "默认模型 deepseek-v4-flash");
    assert(body.max_tokens === 4096, "max_tokens 4096");
    assert(body.tools.length === 1 && body.tools[0].type === "web_search_20250305", "工具声明 type=web_search_20250305");
    assert(body.tools[0].name === "web_search" && body.tools[0].max_uses === 1, "工具 name=web_search 且 max_uses=1");
    assert(body.messages[0].role === "user" && body.messages[0].content.includes(trickyQuery), "含引号/换行的 query 不改变请求结构");
    assert(result.query === trickyQuery, "返回的 query 是 trim 后的原查询");
    assert(result.provider === "deepseek" && result.truncated === false, "结果携带 provider 与 truncated");
    assert(result.usage.inputTokens === 1 && result.usage.outputTokens === 2 && result.usage.webSearchRequests === 1, "usage 字段被正确选取");
    assert(typeof result.elapsedMs === "number" && result.elapsedMs >= 0, "结果携带耗时");
  }

  // 自定义 base URL 的尾部斜杠归一
  {
    const { calls, fetchImpl } = recordingFetch(async () => makeResponse({ content: [resultBlock([])] }));
    await searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_BASE_URL: "https://ds.example.com/anthropic/v1/" }, fetchImpl });
    assert(calls[0].url === "https://ds.example.com/anthropic/v1/messages", "base URL 尾部斜杠被归一后再追加 /messages");
  }

  // ── 2. 结果解析：合并 / 去重 / 截断 / 空标题 / 引用摘要 ──
  {
    const body = {
      content: [
        { type: "text", text: "答案文本，不作为来源", citations: [
          { type: "web_search_result_citation", url: "https://a.com/1", cited_text: "摘录一" },
          { type: "web_search_result_citation", url: "https://a.com/1", cited_text: "摘录二" },
          { type: "web_search_result_citation", url: "https://a.com/1", cited_text: "摘录一" },
          { type: "web_search_result_citation", url: "https://b.com/2", cited_text: "B 摘录" },
        ] },
        resultBlock([
          searchItem("https://a.com/1", "标题A", "2025-01-01"),
          searchItem("https://b.com/2", "   ", null),
          searchItem("https://a.com/1", "重复条目", "2025-02-02"),
          { type: "web_search_result", url: "notaurl", title: "坏条目" },
        ]),
        resultBlock([
          searchItem("https://c.com/3", "标题C", ""),
        ]),
      ],
    };
    const result = await searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch(body) });
    assert(result.sources.length === 3, "多块合并并按 URL 去重");
    assert(result.sources[0].url === "https://a.com/1" && result.sources[0].title === "标题A", "保留首次出现顺序");
    assert(result.sources[0].publishedAt === "2025-01-01", "有效 page_age 保留为 publishedAt");
    assert(result.sources[0].snippet === "摘录一 摘录二", "cited_text 去重拼接为 snippet");
    assert(result.sources[1].title === "https://b.com/2", "空标题回落为 URL");
    assert(!("publishedAt" in result.sources[1]), "null page_age 不制造日期");
    assert(result.sources[1].snippet === "B 摘录", "第二条引用摘要正确");
    assert(result.sources[2].url === "https://c.com/3" && !("snippet" in result.sources[2]), "无引用时省略 snippet");
    assert(!("publishedAt" in result.sources[2]), "空字符串 page_age 不制造日期");
  }

  // 截断与 truncated 语义
  {
    const items = [1, 2, 3, 4, 5].map((i) => searchItem(`https://s.com/${i}`, `T${i}`, null));
    const env = { ...ENV, DEEPSEEK_SEARCH_MAX_RESULTS: "3" };
    const result = await searchDeepSeekWeb("q", { env, fetchImpl: okFetch({ content: [resultBlock(items)] }) });
    assert(result.sources.length === 3 && result.truncated === true, "超过 MAX_RESULTS 时截断且 truncated=true");
    const exact = await searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_MAX_RESULTS: "5" }, fetchImpl: okFetch({ content: [resultBlock(items)] }) });
    assert(exact.sources.length === 5 && exact.truncated === false, "恰好等于 MAX_RESULTS 不算截断");
  }

  // 合法空结果块
  {
    const result = await searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock([])] }) });
    assert(result.sources.length === 0 && result.truncated === false, "合法空结果块返回 sources: []");
  }

  // snippet 超长截断到 500 字符
  {
    const longText = "长".repeat(600);
    const body = {
      content: [
        { type: "text", text: "t", citations: [{ type: "web_search_result_citation", url: "https://a.com", cited_text: longText }] },
        resultBlock([searchItem("https://a.com", "A", null)]),
      ],
    };
    const result = await searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch(body) });
    assert(result.sources[0].snippet.length === 500, "snippet 截断到 500 字符");
  }

  // usage 缺失/非法时省略
  {
    const noUsage = await searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock([])] }) });
    assert(!("usage" in noUsage), "无 usage 时省略该字段");
    const badUsage = await searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock([])], usage: { input_tokens: -1, output_tokens: "x" } }) });
    assert(!("usage" in badUsage), "usage 字段非有效非负数时省略");
  }

  // ── 3. 不能伪装成功的响应 ────────────────────────────────
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [{ type: "text", text: "见 https://a.com" }] }) }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "文本含链接但无结果块不算搜索成功"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock({ type: "web_search_tool_result_error", error_code: "unavailable" })] }) }),
    "WEB_SEARCH_UPSTREAM_ERROR",
    "结果块内的 web_search_tool_result_error 必须报错"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock([{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }])] }) }),
    "WEB_SEARCH_UPSTREAM_ERROR",
    "数组形式的工具错误条目同样报错"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [resultBlock([{ type: "web_search_result", url: "javascript:x" }])] }) }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "有结果条目但全部损坏时返回协议错误"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch("这不是 JSON") }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "损坏 JSON 返回协议错误"
  );

  // 畸形结果块不能伪装成合法空结果（验收 F2 回归）
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [{ type: "web_search_tool_result" }] }) }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "结果块缺失 content 报协议错误"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [{ type: "web_search_tool_result", content: {} }] }) }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "结果块 content 为未知对象报协议错误"
  );
  await expectError(
    searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({ content: [{ type: "web_search_tool_result", content: [null, { type: "unexpected" }] }] }) }),
    "WEB_SEARCH_PROTOCOL_ERROR",
    "非空数组全是未知条目报协议错误"
  );
  {
    // 混合有效与损坏条目：保留有效来源
    const mixed = await searchDeepSeekWeb("q", {
      env: ENV,
      fetchImpl: okFetch({ content: [resultBlock([null, { type: "unexpected" }, searchItem("https://ok.com", "OK", null)])] }),
    });
    assert(mixed.sources.length === 1 && mixed.sources[0].url === "https://ok.com", "混合条目时保留有效来源");
  }

  // ── 4. 凭据与配置 ────────────────────────────────────────
  {
    // 无凭据：上游调用数为 0
    const { calls, fetchImpl } = recordingFetch(async () => makeResponse({}));
    await expectError(searchDeepSeekWeb("q", { env: {}, fetchImpl }), "WEB_SEARCH_CREDENTIAL_MISSING", "无凭据时报 CREDENTIAL_MISSING");
    assert(calls.length === 0, "无凭据时上游调用数为 0");

    // 显式 YAML 凭据文件
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-cred-"));
    const credFile = path.join(dir, "credentials.yaml");
    fs.writeFileSync(credFile, "refs:\n  DEEPSEEK_API_KEY: file-key-456\n");
    const resolved = resolveApiKey({ DEEPSEEK_SEARCH_CREDENTIALS_FILE: credFile });
    assert(resolved.apiKey === "file-key-456" && resolved.source === "file", "显式 YAML 凭据文件读取 refs.DEEPSEEK_API_KEY");

    // env 优先：即使文件不存在也不读文件
    const envWins = resolveApiKey({ DEEPSEEK_API_KEY: " env-key ", DEEPSEEK_SEARCH_CREDENTIALS_FILE: path.join(dir, "missing.yaml") });
    assert(envWins.apiKey === "env-key" && envWins.source === "env", "DEEPSEEK_API_KEY 优先且去首尾空白，不存在的凭据文件被忽略");

    // 坏文件 / 缺 key 的文件
    await expectError(
      searchDeepSeekWeb("q", { env: { DEEPSEEK_SEARCH_CREDENTIALS_FILE: path.join(dir, "missing.yaml") }, fetchImpl: okFetch({}) }),
      "WEB_SEARCH_CONFIG_ERROR",
      "凭据文件不存在报 CONFIG_ERROR"
    );
    fs.writeFileSync(path.join(dir, "bad.yaml"), "refs: [unclosed\n");
    await expectError(
      searchDeepSeekWeb("q", { env: { DEEPSEEK_SEARCH_CREDENTIALS_FILE: path.join(dir, "bad.yaml") }, fetchImpl: okFetch({}) }),
      "WEB_SEARCH_CONFIG_ERROR",
      "非法 YAML 报 CONFIG_ERROR"
    );
    fs.writeFileSync(path.join(dir, "nokey.yaml"), "refs:\n  OTHER: 1\n");
    await expectError(
      searchDeepSeekWeb("q", { env: { DEEPSEEK_SEARCH_CREDENTIALS_FILE: path.join(dir, "nokey.yaml") }, fetchImpl: okFetch({}) }),
      "WEB_SEARCH_CREDENTIAL_MISSING",
      "YAML 合法但缺少目标 key 报 CREDENTIAL_MISSING"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 配置校验
  {
    assert(loadConfig({}).timeoutMs === 60000 && loadConfig({}).maxResults === 8, "默认 timeout 60000 / maxResults 8");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_BASE_URL: "http://api.deepseek.com" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "非 HTTPS base URL 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_BASE_URL: "https://user:pw@api.deepseek.com" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "带凭据的 base URL 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_BASE_URL: "https://api.deepseek.com/v1?x=1" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "带 query 的 base URL 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_BASE_URL: "not a url" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "非法 base URL 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_TIMEOUT_MS: "abc" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "非整数 timeout 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_TIMEOUT_MS: "100" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "低于下限的 timeout 被拒绝");
    await expectError(searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_MAX_RESULTS: "0" }, fetchImpl: okFetch({}) }), "WEB_SEARCH_CONFIG_ERROR", "越界 maxResults 被拒绝");
  }

  // query 输入校验
  {
    assert(normalizeQuery("  hi ") === "hi", "normalizeQuery trim");
    assert(normalizeQuery("") === null && normalizeQuery("   ") === null, "空 query 不合法");
    assert(normalizeQuery(123) === null, "非字符串 query 不合法");
    assert(normalizeQuery("x".repeat(4097)) === null, "超长 query 不合法");
    assert(normalizeQuery("x".repeat(4096)) !== null, "恰好 4096 字符合法");
    await expectError(searchDeepSeekWeb("  ", { env: ENV, fetchImpl: okFetch({}) }), "WEB_SEARCH_INVALID_INPUT", "空 query 报 INVALID_INPUT");
  }

  // ── 5. 失败路径：状态码 / 超时 / 超大响应 / 取消 ──────────
  {
    const err401 = await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({}, 401) }), "WEB_SEARCH_UPSTREAM_ERROR", "401 正确失败");
    assert(err401 && err401.message.includes("凭据"), "401 提示凭据或权限问题");
    const err429 = await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({}, 429) }), "WEB_SEARCH_UPSTREAM_ERROR", "429 正确失败");
    assert(err429 && err429.message.includes("429"), "429 提示额度/限流");
    await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({}, 503) }), "WEB_SEARCH_UPSTREAM_ERROR", "5xx 正确失败");
    await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl: okFetch({}, 302) }), "WEB_SEARCH_UPSTREAM_ERROR", "重定向被拒绝");
    await expectError(
      searchDeepSeekWeb("q", { env: ENV, fetchImpl: async () => { throw new Error("socket hangup"); } }),
      "WEB_SEARCH_UPSTREAM_ERROR",
      "网络失败正确失败"
    );

    // 错误信息不泄露密钥
    const errSecret = await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl: async () => { throw new Error("connect failed"); } }), "WEB_SEARCH_UPSTREAM_ERROR", "网络失败路径");
    assert(errSecret && !errSecret.message.includes(KEY), "错误信息不包含密钥");

    // 没有自动重试
    const { calls, fetchImpl } = recordingFetch(async () => makeResponse({}, 500));
    await expectError(searchDeepSeekWeb("q", { env: ENV, fetchImpl }), "WEB_SEARCH_UPSTREAM_ERROR", "5xx 失败路径");
    assert(calls.length === 1, "失败时不自动重试");

    // 超时
    const slowFetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
    });
    const errTimeout = await expectError(
      searchDeepSeekWeb("q", { env: { ...ENV, DEEPSEEK_SEARCH_TIMEOUT_MS: "1000" }, fetchImpl: slowFetch }),
      "WEB_SEARCH_TIMEOUT",
      "超时返回 WEB_SEARCH_TIMEOUT"
    );
    assert(errTimeout && !errTimeout.message.includes(KEY), "超时错误不包含密钥");

    // 超大响应（流式累计并及时取消）
    const bigChunk = Buffer.alloc(1024 * 1024, "x");
    const bigStream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.enqueue(bigChunk);
        controller.enqueue(bigChunk); // 3 MiB > 2 MiB 上限
        controller.close();
      },
    });
    await expectError(
      searchDeepSeekWeb("q", { env: ENV, fetchImpl: async () => new Response(bigStream, { status: 200 }) }),
      "WEB_SEARCH_UPSTREAM_ERROR",
      "超过 2 MiB 的响应正确失败"
    );

    // 未关闭的持续流：超限报错之外还必须真正取消底层流（验收 F3 回归）
    let streamCancelled = false;
    const neverEnding = new ReadableStream({
      pull(controller) {
        controller.enqueue(Buffer.alloc(1024 * 1024, "y")); // 持续产生 1 MiB，永不结束
      },
      cancel() {
        streamCancelled = true;
      },
    });
    await expectError(
      searchDeepSeekWeb("q", { env: ENV, fetchImpl: async () => new Response(neverEnding, { status: 200 }) }),
      "WEB_SEARCH_UPSTREAM_ERROR",
      "未关闭流超过上限正确失败"
    );
    assert(streamCancelled === true, "超限后底层流的 cancel 确实被触发");

    // 非 2xx 提前拒绝时也取消未读取的响应体
    let errorBodyCancelled = false;
    const unreadBody = new ReadableStream({
      pull() { /* 永不产出也永不结束 */ },
      cancel() { errorBodyCancelled = true; },
    });
    await expectError(
      searchDeepSeekWeb("q", { env: ENV, fetchImpl: async () => new Response(unreadBody, { status: 500 }) }),
      "WEB_SEARCH_UPSTREAM_ERROR",
      "5xx 且响应体未读取时正确失败"
    );
    assert(errorBodyCancelled === true, "非 2xx 路径取消未读取的响应体");

    // 调用方取消
    const callerAbort = new AbortController();
    const cancelFetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
    });
    const pending = searchDeepSeekWeb("q", { env: ENV, fetchImpl: cancelFetch, signal: callerAbort.signal });
    callerAbort.abort();
    const errCancel = await expectError(pending, "WEB_SEARCH_UPSTREAM_ERROR", "调用方取消时正确失败");
    assert(errCancel && errCancel.message.includes("取消"), "取消原因可辨识");
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
