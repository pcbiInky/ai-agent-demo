#!/usr/bin/env node

/**
 * 测试 lib/kimi-metrics.js：
 * kimi 账号额度来自 GET https://api.kimi.com/coding/v1/usages
 * 维度为 5h + month（没有 week）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

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

function testShouldRefreshCredentials() {
  const { shouldRefreshCredentials } = reload();
  const now = 1_000;
  eq(
    shouldRefreshCredentials({ accessToken: "a", refreshToken: "r", expiresAt: now + 200, expiresIn: 900 }, now),
    true,
    "refresh threshold: refreshes near expiry"
  );
  eq(
    shouldRefreshCredentials({ accessToken: "a", refreshToken: "r", expiresAt: now + 600, expiresIn: 900 }, now),
    false,
    "refresh threshold: keeps sufficiently fresh token"
  );
  eq(
    shouldRefreshCredentials({ accessToken: "a", refreshToken: null, expiresAt: now - 1, expiresIn: 900 }, now),
    false,
    "refresh threshold: cannot refresh without refresh token"
  );
}

function testCredentialsRoundTrip() {
  const mod = reload();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-credentials-"));
  const credentialsPath = path.join(tempDir, "credentials", "kimi-code.json");
  try {
    mod.writeKimiCredentials(credentialsPath, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 2_000,
      expiresIn: 900,
      scope: "kimi-code",
      tokenType: "Bearer",
    });
    const loaded = mod.readKimiCredentials(credentialsPath);
    eq(loaded.accessToken, "access", "credentials round trip: access token");
    eq(loaded.refreshToken, "refresh", "credentials round trip: refresh token");
    eq(loaded.expiresAt, 2_000, "credentials round trip: expiry");
    if (process.platform !== "win32") {
      eq(fs.statSync(credentialsPath).mode & 0o777, 0o600, "credentials round trip: private file mode");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testExpiredCredentialsRefreshBeforeUsage() {
  const mod = reload();
  let credentials = {
    accessToken: "expired-access",
    refreshToken: "old-refresh",
    expiresAt: 900,
    expiresIn: 900,
    scope: "kimi-code",
    tokenType: "Bearer",
  };
  let refreshCalls = 0;
  let usageCalls = 0;
  const result = await mod.getKimiRoleCardMetrics({
    credentialsPath: "/test/kimi-code.json",
    usagesUrl: "https://usage.test/usages",
    oauthTokenUrl: "https://auth.test/api/oauth/token",
    nowSeconds: () => 1_000,
    readCredentials: () => credentials,
    writeCredentials: (_path, next) => { credentials = next; },
    fetchImpl: async (url, options) => {
      if (url.includes("oauth/token")) {
        refreshCalls += 1;
        const form = new URLSearchParams(options.body);
        eq(form.get("grant_type"), "refresh_token", "expired refresh: refresh_token grant");
        eq(form.get("refresh_token"), "old-refresh", "expired refresh: sends stored refresh token");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            expires_in: 900,
            scope: "kimi-code",
            token_type: "Bearer",
          }),
        };
      }
      usageCalls += 1;
      eq(options.headers.Authorization, "Bearer fresh-access", "expired refresh: usage uses refreshed token");
      return { ok: true, status: 200, json: async () => REAL_BODY };
    },
  });
  eq(refreshCalls, 1, "expired refresh: token endpoint called once");
  eq(usageCalls, 1, "expired refresh: usage endpoint called once");
  eq(credentials.expiresAt, 1_900, "expired refresh: refreshed expiry persisted");
  eq(result.usageWindows.length, 2, "expired refresh: quota is visible immediately");
}

async function testUsage401ForcesRefreshAndRetry() {
  const mod = reload();
  let credentials = {
    accessToken: "rejected-access",
    refreshToken: "old-refresh",
    expiresAt: 10_000,
    expiresIn: 900,
  };
  let usageCalls = 0;
  let refreshCalls = 0;
  const result = await mod.getKimiRoleCardMetrics({
    credentialsPath: "/test/kimi-code-401.json",
    usagesUrl: "https://usage.test/usages",
    oauthTokenUrl: "https://auth.test/api/oauth/token",
    nowSeconds: () => 1_000,
    readCredentials: () => credentials,
    writeCredentials: (_path, next) => { credentials = next; },
    fetchImpl: async (url, options) => {
      if (url.includes("oauth/token")) {
        refreshCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fresh-after-401",
            refresh_token: "fresh-refresh",
            expires_in: 900,
          }),
        };
      }
      usageCalls += 1;
      if (usageCalls === 1) return { ok: false, status: 401 };
      eq(options.headers.Authorization, "Bearer fresh-after-401", "401 retry: uses refreshed token");
      return { ok: true, status: 200, json: async () => REAL_BODY };
    },
  });
  eq(refreshCalls, 1, "401 retry: refresh called once");
  eq(usageCalls, 2, "401 retry: usage called twice");
  eq(result.usageWindows.length, 2, "401 retry: quota recovered");
}

async function main() {
  try {
    testNormalizeRealBody();
    testNormalizeFallsBackToUsagesLimit5h();
    testNormalizeMissingMonth();
    testNormalizeNullBody();
    testWindowDurationMinutes();
    testShouldRefreshCredentials();
    testCredentialsRoundTrip();
    await testExpiredCredentialsRefreshBeforeUsage();
    await testUsage401ForcesRefreshAndRetry();
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
