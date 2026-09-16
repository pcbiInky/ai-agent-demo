#!/usr/bin/env node

/**
 * 测试 lib/role-metrics.js 指标注册表框架：
 * 新增 CLI 只需注册 provider，server 端调用方式不变。
 */

const mod = require("../lib/role-metrics");

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

async function testUnknownCliReturnsEmpty() {
  const result = await mod.getRoleCardMetrics({ cli: "does-not-exist" });
  eq(result.supportsUsageWindows, false, "unknown cli: supportsUsageWindows false");
  eq(result.supportsTokenUsage, false, "unknown cli: supportsTokenUsage false");
  eq(result.usageWindows.length, 0, "unknown cli: no windows");
}

async function testRegisteredProviderIsUsed() {
  mod.PROVIDERS.unit = {
    get: async ({ providerSessionId }) => ({
      supportsUsageWindows: true,
      supportsTokenUsage: false,
      usageWindows: [{ key: "5h", label: "5h", usedPercent: 10, resetsAt: null }],
      providerSessionId,
    }),
    fallback: mod.EMPTY_METRICS,
  };
  const result = await mod.getRoleCardMetrics(
    { cli: "unit", model: "m" },
    { providerSessionId: "sess-1" }
  );
  eq(result.supportsUsageWindows, true, "registered provider: supportsUsageWindows from provider");
  eq(result.usageWindows.length, 1, "registered provider: windows from provider");
  eq(result.providerSessionId, "sess-1", "registered provider: receives providerSessionId");
  delete mod.PROVIDERS.unit;
}

async function testProviderThrowsUsesFallback() {
  mod.PROVIDERS.boom = {
    get: async () => { throw new Error("provider failed"); },
    fallback: {
      supportsUsageWindows: true,
      supportsTokenUsage: true,
      usageWindows: [{ key: "5h", label: "5h", usedPercent: null, resetsAt: null }],
    },
  };
  const result = await mod.getRoleCardMetrics({ cli: "boom" });
  eq(result.supportsUsageWindows, true, "throwing provider: uses fallback supportsUsageWindows");
  eq(result.usageWindows.length, 1, "throwing provider: uses fallback windows");
  delete mod.PROVIDERS.boom;
}

async function testProviderWithoutFallbackReturnsEmpty() {
  mod.PROVIDERS.bare = { get: async () => { throw new Error("no fallback"); } };
  const result = await mod.getRoleCardMetrics({ cli: "bare" });
  eq(result.supportsUsageWindows, false, "no fallback: empty metrics");
  eq(result.usageWindows.length, 0, "no fallback: no windows");
  delete mod.PROVIDERS.bare;
}

function testBuiltinProvidersRegistered() {
  assert(typeof mod.PROVIDERS.codex?.get === "function", "codex provider registered");
  assert(typeof mod.PROVIDERS.claude?.get === "function", "claude provider registered");
  assert(typeof mod.PROVIDERS.dsh?.get === "function", "dsh provider registered");
  assert(typeof mod.PROVIDERS.kimi?.get === "function", "kimi provider registered");
  assert(mod.PROVIDERS.codex.fallback.supportsUsageWindows === true, "codex fallback keeps usage section visible");
  assert(mod.PROVIDERS.kimi.fallback.supportsUsageWindows === false, "kimi fallback hides usage section");
}

async function main() {
  try {
    await testUnknownCliReturnsEmpty();
    await testRegisteredProviderIsUsed();
    await testProviderThrowsUsesFallback();
    await testProviderWithoutFallbackReturnsEmpty();
    testBuiltinProvidersRegistered();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
