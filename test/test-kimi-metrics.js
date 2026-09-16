#!/usr/bin/env node

/**
 * 测试 lib/kimi-metrics.js：
 * kimi 账号额度来自 GET https://api.kimi.com/coding/v1/usages
 * 维度为 5h + month（没有 week）。
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }
  console.log(`FAIL ${label}`);
  failed += 1;
}

function eq(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function reload() {
  delete require.cache[require.resolve("../lib/kimi-metrics")];
  return require("../lib/kimi-metrics");
}

const REAL_BODY = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "31",
        remaining: "69",
        resetTime: "2026-09-16T08:43:06.334827Z",
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.308472, reset_time: "2026-09-16T08:43:05Z" },
    limit_month_total: { used_ratio: 0.0454, reset_time: "2026-10-16T00:00:00Z" },
    limit_month_code: { used_ratio: 0.0454, reset_time: "2026-10-16T00:00:00Z" },
  },
};

function testNormalizeRealBody() {
  const { normalizeKimiUsage } = reload();
  const result = normalizeKimiUsage(REAL_BODY);
  eq(result.supportsUsageWindows, true, "real body: supportsUsageWindows true");
  eq(result.supportsTokenUsage, false, "real body: supportsTokenUsage false");
  eq(result.usageWindows.length, 2, "real body: two windows (5h + month)");
  eq(result.usageWindows[0].key, "5h", "real body: window 1 key = 5h");
  eq(result.usageWindows[0].usedPercent, 69, "real body: 5h remaining = 1 - used/limit = 69%");
  eq(result.usageWindows[0].resetsAt, Date.parse("2026-09-16T08:43:06.334827Z"), "real body: 5h resetsAt from detail.resetTime");
  eq(result.usageWindows[1].key, "month", "real body: window 2 key = month");
  eq(result.usageWindows[1].label, "month", "real body: window 2 label = month (no week)");
  eq(result.usageWindows[1].usedPercent, 95, "real body: month remaining = 1 - 0.0454 -> 95%");
  eq(result.usageWindows[1].resetsAt, Date.parse("2026-10-16T00:00:00Z"), "real body: month resetsAt parsed");
  assert(!result.usageWindows.some((w) => w.key === "week"), "real body: no week window");
  eq(result.primaryUsedPercent, 69, "real body: legacy primary mirror");
  eq(result.secondaryUsedPercent, 95, "real body: legacy secondary mirror");
}

function testNormalizeFallsBackToUsagesLimit5h() {
  const { normalizeKimiUsage } = reload();
  const result = normalizeKimiUsage({
    usages: {
      limit_5h: { used_ratio: 0.5, reset_time: "2026-09-16T08:43:05Z" },
      limit_month_code: { used_ratio: 0.2, reset_time: "2026-10-16T00:00:00Z" },
    },
  });
  eq(result.usageWindows.length, 2, "fallback: two windows");
  eq(result.usageWindows[0].usedPercent, 50, "fallback: 5h uses limit_5h.used_ratio");
  eq(result.usageWindows[1].usedPercent, 80, "fallback: month remaining falls back to limit_month_code");
}

function testNormalizeMissingMonth() {
  const { normalizeKimiUsage } = reload();
  const result = normalizeKimiUsage({ usages: { limit_5h: { used_ratio: 0.1 } } });
  eq(result.usageWindows.length, 1, "missing month: only 5h window");
  eq(result.usageWindows[0].key, "5h", "missing month: remaining window is 5h");
}

function testNormalizeNullBody() {
  const { normalizeKimiUsage } = reload();
  const result = normalizeKimiUsage(null);
  eq(result.supportsUsageWindows, false, "null body: supportsUsageWindows false");
  eq(result.supportsTokenUsage, false, "null body: supportsTokenUsage false");
  eq(result.usageWindows.length, 0, "null body: no windows");
}

function testWindowDurationMinutes() {
  const { windowDurationMinutes } = reload();
  eq(windowDurationMinutes({ duration: 300, timeUnit: "TIME_UNIT_MINUTE" }), 300, "windowDurationMinutes minutes");
  eq(windowDurationMinutes({ duration: 5, timeUnit: "TIME_UNIT_HOUR" }), 300, "windowDurationMinutes hours");
  eq(windowDurationMinutes({ duration: 1, timeUnit: "TIME_UNIT_DAY" }), 1440, "windowDurationMinutes days");
  eq(windowDurationMinutes({ duration: 300, timeUnit: "UNKNOWN" }), null, "windowDurationMinutes unknown unit -> null");
}

async function testGetKimiRoleCardMetricsSuccess() {
  const mod = reload();
  let calledUrl = null;
  const result = await mod.getKimiRoleCardMetrics({
    readCredentials: () => ({ accessToken: "test-token" }),
    fetchImpl: async (url, options) => {
      calledUrl = url;
      assert(options.headers.Authorization === "Bearer test-token", "success: sends bearer token");
      return { ok: true, json: async () => REAL_BODY };
    },
  });
  eq(calledUrl, mod.KIMI_USAGES_URL, "success: calls usages endpoint");
  eq(result.usageWindows.length, 2, "success: two windows");
  eq(result.sources.usage, "kimi-usages-api", "success: source tagged");
}

async function testGetKimiRoleCardMetricsNoCredentials() {
  const mod = reload();
  let fetchCalled = false;
  const result = await mod.getKimiRoleCardMetrics({
    readCredentials: () => ({ accessToken: null }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    },
  });
  eq(fetchCalled, false, "no-credentials: fetch not called");
  eq(result.supportsUsageWindows, false, "no-credentials: supportsUsageWindows false");
  eq(result.sources.usage, "no-credentials", "no-credentials: source tagged");
}

async function testGetKimiRoleCardMetricsFetchRejects() {
  const mod = reload();
  const result = await mod.getKimiRoleCardMetrics({
    readCredentials: () => ({ accessToken: "t" }),
    fetchImpl: async () => { throw new Error("network error"); },
  });
  eq(result.supportsUsageWindows, false, "fetch-reject: supportsUsageWindows false");
}

async function testGetKimiRoleCardMetricsNonOk() {
  const mod = reload();
  const result = await mod.getKimiRoleCardMetrics({
    readCredentials: () => ({ accessToken: "t" }),
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  eq(result.supportsUsageWindows, false, "non-ok: supportsUsageWindows false");
}

async function testGetKimiRoleCardMetricsInvalidJson() {
  const mod = reload();
  const result = await mod.getKimiRoleCardMetrics({
    readCredentials: () => ({ accessToken: "t" }),
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
  });
  eq(result.supportsUsageWindows, false, "invalid-json: supportsUsageWindows false");
  eq(result.sources.usage, "invalid-json", "invalid-json: source tagged");
}

async function main() {
  try {
    testNormalizeRealBody();
    testNormalizeFallsBackToUsagesLimit5h();
    testNormalizeMissingMonth();
    testNormalizeNullBody();
    testWindowDurationMinutes();
    await testGetKimiRoleCardMetricsSuccess();
    await testGetKimiRoleCardMetricsNoCredentials();
    await testGetKimiRoleCardMetricsFetchRejects();
    await testGetKimiRoleCardMetricsNonOk();
    await testGetKimiRoleCardMetricsInvalidJson();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
