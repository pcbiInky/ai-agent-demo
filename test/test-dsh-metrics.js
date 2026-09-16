#!/usr/bin/env node

/**
 * 测试 lib/dsh-metrics.js：
 * DeepSeek 余额只在服务端归一化为 0-100 的余额充足度，不泄露真实金额。
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
  delete require.cache[require.resolve("../lib/dsh-metrics")];
  return require("../lib/dsh-metrics");
}

function balanceBody(totalBalance, currency = "CNY") {
  return {
    is_available: Number(totalBalance) > 0,
    balance_infos: [
      {
        currency,
        total_balance: String(totalBalance),
        granted_balance: "0.00",
        topped_up_balance: String(totalBalance),
      },
    ],
  };
}

function testNormalizeDshBalance() {
  const { normalizeDshBalance } = reload();

  const half = normalizeDshBalance(balanceBody("25.00"));
  eq(half.supportsUsageWindows, true, "25 CNY: usage window supported");
  eq(half.usageWindows.length, 1, "25 CNY: one balance window");
  eq(half.usageWindows[0].key, "balance", "25 CNY: balance window key");
  eq(half.usageWindows[0].label, "余额", "25 CNY: balance window label");
  eq(half.usageWindows[0].usedPercent, 50, "25 CNY: normalized to 50%");
  eq(half.usageWindows[0].resetsAt, null, "balance has no reset time");

  const full = normalizeDshBalance(balanceBody("50.46"));
  eq(full.usageWindows[0].usedPercent, 100, "balance above 50 CNY is capped at 100%");

  const empty = normalizeDshBalance(balanceBody("0"));
  eq(empty.usageWindows[0].usedPercent, 0, "zero balance maps to 0%");

  const missingCurrency = normalizeDshBalance(balanceBody("10", "USD"));
  eq(missingCurrency.supportsUsageWindows, false, "missing CNY balance is not guessed");
  eq(missingCurrency.usageWindows.length, 0, "missing CNY balance has no window");
}

function testNormalizeDoesNotExposeBalance() {
  const { normalizeDshBalance } = reload();
  const serialized = JSON.stringify(normalizeDshBalance(balanceBody("23.47")));
  assert(!serialized.includes("23.47"), "metrics do not expose the real balance value");
  assert(!serialized.includes("total_balance"), "metrics do not expose provider balance fields");
}

function testReadDshCredentials() {
  const previous = process.env.DEEPSEEK_API_KEY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-metrics-"));
  const credentialsPath = path.join(tempDir, ".credentials.yaml");

  try {
    delete process.env.DEEPSEEK_API_KEY;
    fs.writeFileSync(
      credentialsPath,
      "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'file-key'\nrecords:\n  owner/id:\n    kind: api-key\n    key: ignored\n"
    );
    const { readDshCredentials } = reload();
    eq(readDshCredentials(credentialsPath).apiKey, "file-key", "reads key from DSH refs section");

    process.env.DEEPSEEK_API_KEY = "env-key";
    eq(readDshCredentials(credentialsPath).apiKey, "env-key", "environment key has priority");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testGetDshRoleCardMetricsSuccess() {
  const mod = reload();
  let calledUrl = null;
  const result = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: "test-key" }),
    fetchImpl: async (url, options) => {
      calledUrl = url;
      eq(options.headers.Authorization, "Bearer test-key", "success: sends bearer token");
      return { ok: true, json: async () => balanceBody("20") };
    },
  });

  eq(calledUrl, mod.DSH_BALANCE_URL, "success: calls DeepSeek balance endpoint");
  eq(result.usageWindows[0].usedPercent, 40, "success: returns normalized remaining percent");
  eq(result.sources.usage, "deepseek-balance-api", "success: source tagged");
  assert(!JSON.stringify(result).includes('"20"'), "success: response does not expose real balance");
}

async function testGetDshRoleCardMetricsFailures() {
  const mod = reload();

  let fetchCalled = false;
  const noCredentials = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: null }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    },
  });
  eq(fetchCalled, false, "no credentials: fetch is not called");
  eq(noCredentials.sources.usage, "no-credentials", "no credentials: source tagged");

  const fetchError = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: "t" }),
    fetchImpl: async () => { throw new Error("network error"); },
  });
  eq(fetchError.sources.usage, "fetch-error", "fetch failure: source tagged");

  const httpError = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: "t" }),
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  eq(httpError.sources.usage, "http-error", "HTTP failure: source tagged");

  const invalidJson = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: "t" }),
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
  });
  eq(invalidJson.sources.usage, "invalid-json", "invalid JSON: source tagged");

  const invalidBalance = await mod.getDshRoleCardMetrics({
    readCredentials: () => ({ apiKey: "t" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ balance_infos: [] }) }),
  });
  eq(invalidBalance.sources.usage, "invalid-balance", "invalid balance body: source tagged");
  eq(invalidBalance.supportsUsageWindows, false, "invalid balance body: usage hidden");
}

async function main() {
  try {
    testNormalizeDshBalance();
    testNormalizeDoesNotExposeBalance();
    testReadDshCredentials();
    await testGetDshRoleCardMetricsSuccess();
    await testGetDshRoleCardMetricsFailures();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
