#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const projectRoot = path.join(__dirname, "..");

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

// ── Helper: get a fresh module reference ───────────────────────
function reloadModule() {
  delete require.cache[require.resolve("../lib/claude-metrics")];
  return require("../lib/claude-metrics");
}

// ── 测试 normalizeMetrics ──────────────────────────────────────

function testNormalizeMetricsWithValidData() {
  const { normalizeMetrics } = reloadModule();
  const input = {
    current_interval_total_count: 100,
    current_interval_usage_count: 25,
    current_weekly_total_count: 500,
    current_weekly_usage_count: 100,
    end_time: 1700000000000,
    weekly_end_time: 1700600000000,
  };
  const result = normalizeMetrics(input);
  assert(result.primaryUsedPercent === 25, "primaryUsedPercent = usage/total * 100");
  assert(result.secondaryUsedPercent === 20, "secondaryUsedPercent = weekly usage/total * 100");
  assert(result.primaryResetsAt === 1700000000000, "primaryResetsAt = end_time");
  assert(result.secondaryResetsAt === 1700600000000, "secondaryResetsAt = weekly_end_time");
  assert(result.supportsUsageWindows === true, "supportsUsageWindows = true");
  assert(result.supportsTokenUsage === false, "supportsTokenUsage = false");
  assert(result.contextTokens === null, "contextTokens = null");
  assert(result.totalTokens === null, "totalTokens = null");
}

function testNormalizeMetricsWithZeroDenominator() {
  const { normalizeMetrics } = reloadModule();
  const input = {
    current_interval_total_count: 0,
    current_interval_usage_count: 0,
    current_weekly_total_count: 0,
    current_weekly_usage_count: 0,
    end_time: null,
    weekly_end_time: null,
  };
  const result = normalizeMetrics(input);
  assert(result.primaryUsedPercent === null, "primaryUsedPercent = null when total = 0");
  assert(result.secondaryUsedPercent === null, "secondaryUsedPercent = null when total = 0");
}

function testNormalizeMetricsWithNullInput() {
  const { normalizeMetrics } = reloadModule();
  const result = normalizeMetrics(null);
  assert(result.supportsUsageWindows === false, "supportsUsageWindows = false when input is null");
  assert(result.supportsTokenUsage === false, "supportsTokenUsage = false when input is null");
}

// ── 测试 selectModelRemain ────────────────────────────────────

function testSelectModelRemainWithMatch() {
  const { selectModelRemain } = reloadModule();
  const modelRemains = [
    { model_name: "claude-3-5-sonnet", usage: 10 },
    { model_name: "claude-3-opus", usage: 20 },
  ];
  // roleModel takes priority over settingsModelName
  const result = selectModelRemain(modelRemains, "claude-3-opus", "claude-3-5-sonnet");
  assert(result.model_name === "claude-3-opus", "selectModelRemain matches roleModel");
}

function testSelectModelRemainNoMatchFallsBackToFirst() {
  const { selectModelRemain } = reloadModule();
  const modelRemains = [
    { model_name: "claude-3-5-sonnet", usage: 10 },
    { model_name: "claude-3-opus", usage: 20 },
  ];
  // roleModel does not match, settingsModelName does not match, fallback to first
  const result = selectModelRemain(modelRemains, null, "unknown-model");
  assert(result.model_name === "claude-3-5-sonnet", "selectModelRemain falls back to first when no roleModel match");
}

function testSelectModelRemainWithNullModelName() {
  const { selectModelRemain } = reloadModule();
  const modelRemains = [
    { model_name: "claude-3-5-sonnet", usage: 10 },
  ];
  // roleModel=null, settingsModelName=null, fallback to first
  const result = selectModelRemain(modelRemains, null, null);
  assert(result.model_name === "claude-3-5-sonnet", "selectModelRemain falls back to first when both are null");
}

function testSelectModelRemainRoleModelTakesPriority() {
  const { selectModelRemain } = reloadModule();
  const modelRemains = [
    { model_name: "claude-3-5-sonnet", usage: 10 },
    { model_name: "claude-3-opus", usage: 20 },
  ];
  // roleModel matches first entry, settingsModelName matches second - roleModel wins
  const result = selectModelRemain(modelRemains, "claude-3-5-sonnet", "claude-3-opus");
  assert(result.model_name === "claude-3-5-sonnet", "roleModel takes priority over settingsModelName");
}

function testSelectModelRemainWithEmptyArray() {
  const { selectModelRemain } = reloadModule();
  const result = selectModelRemain([], "claude-3-opus", "claude-3-5-sonnet");
  assert(result === null, "selectModelRemain returns null for empty array");
}

// ── 测试 getClaudeSettings ─────────────────────────────────────

function testGetClaudeSettingsReadsEnvPath() {
  const { getClaudeSettings } = reloadModule();
  // 这个测试依赖 ~/.claude/settings.json 的存在，在 CI 环境中可能不存在
  const result = getClaudeSettings();
  assert(typeof result === "object", "getClaudeSettings returns an object");
  assert("apiKey" in result, "getClaudeSettings returns object with apiKey");
  assert("modelName" in result, "getClaudeSettings returns object with modelName");
}

// ── 测试 getClaudeRoleCardMetrics（依赖注入方式）────────────────

async function testGetClaudeRoleCardMetricsSuccess() {
  const mod = reloadModule();

  const mockSettings = () => ({ apiKey: "test-key-123", modelName: "settings-model" });
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      model_remains: [
        {
          model_name: "role-model-from-api",
          current_interval_total_count: 200,
          current_interval_usage_count: 50,
          current_weekly_total_count: 1000,
          current_weekly_usage_count: 250,
          end_time: 1800000000000,
          weekly_end_time: 1800600000000,
        },
        {
          model_name: "settings-model",
          current_interval_total_count: 100,
          current_interval_usage_count: 10,
          current_weekly_total_count: 500,
          current_weekly_usage_count: 50,
          end_time: 1700000000000,
          weekly_end_time: 1700600000000,
        },
      ],
    }),
  });

  const result = await mod.getClaudeRoleCardMetrics("role-model-from-api", {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(result.supportsUsageWindows === true, "success: supportsUsageWindows = true");
  assert(result.supportsTokenUsage === false, "success: supportsTokenUsage = false");
  assert(result.primaryUsedPercent === 25, "success: primaryUsedPercent = 50/200*100 = 25");
  assert(result.secondaryUsedPercent === 25, "success: secondaryUsedPercent = 250/1000*100 = 25");
  assert(result.primaryResetsAt === 1800000000000, "success: primaryResetsAt = role-model's end_time");
  assert(result.secondaryResetsAt === 1800600000000, "success: secondaryResetsAt = role-model's weekly_end_time");
  assert(result.contextTokens === null, "success: contextTokens = null");
  assert(result.totalTokens === null, "success: totalTokens = null");
}

async function testGetClaudeRoleCardMetricsNoApiKey() {
  const mod = reloadModule();

  // readSettings 返回 null apiKey，函数应提前返回，不调用 fetch
  let fetchCalled = false;
  const mockSettings = () => ({ apiKey: null, modelName: null });
  const mockFetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  };

  const result = await mod.getClaudeRoleCardMetrics(null, {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(fetchCalled === false, "no-apikey: fetch should not be called");
  assert(result.supportsUsageWindows === false, "no-apikey: supportsUsageWindows = false");
  assert(result.supportsTokenUsage === false, "no-apikey: supportsTokenUsage = false");
}

async function testGetClaudeRoleCardMetricsFetchRejects() {
  const mod = reloadModule();

  const mockSettings = () => ({ apiKey: "test-key", modelName: null });
  const mockFetch = async () => { throw new Error("network error"); };

  const result = await mod.getClaudeRoleCardMetrics(null, {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(result.supportsUsageWindows === false, "fetch-reject: supportsUsageWindows = false");
  assert(result.supportsTokenUsage === false, "fetch-reject: supportsTokenUsage = false");
}

async function testGetClaudeRoleCardMetricsNonOkResponse() {
  const mod = reloadModule();

  const mockSettings = () => ({ apiKey: "test-key", modelName: null });
  const mockFetch = async () => ({ ok: false, status: 401 });

  const result = await mod.getClaudeRoleCardMetrics(null, {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(result.supportsUsageWindows === false, "non-ok: supportsUsageWindows = false");
  assert(result.supportsTokenUsage === false, "non-ok: supportsTokenUsage = false");
}

async function testGetClaudeRoleCardMetricsInvalidJson() {
  const mod = reloadModule();

  const mockSettings = () => ({ apiKey: "test-key", modelName: null });
  const mockFetch = async () => ({
    ok: true,
    json: async () => { throw new Error("invalid json"); },
  });

  const result = await mod.getClaudeRoleCardMetrics(null, {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(result.supportsUsageWindows === false, "invalid-json: supportsUsageWindows = false");
  assert(result.supportsTokenUsage === false, "invalid-json: supportsTokenUsage = false");
}

async function testGetClaudeRoleCardMetricsSettingsFallbackToFirst() {
  const mod = reloadModule();

  // roleModel doesn't match anything, settingsModelName also doesn't match, fallback to first
  const mockSettings = () => ({ apiKey: "test-key", modelName: "non-existent-model" });
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      model_remains: [
        { model_name: "first-model", current_interval_total_count: 100, current_interval_usage_count: 20, current_weekly_total_count: 500, current_weekly_usage_count: 100, end_time: 1700000000000, weekly_end_time: 1700600000000 },
        { model_name: "second-model", current_interval_total_count: 100, current_interval_usage_count: 30, current_weekly_total_count: 500, current_weekly_usage_count: 150, end_time: 1710000000000, weekly_end_time: 1710600000000 },
      ],
    }),
  });

  const result = await mod.getClaudeRoleCardMetrics("unknown-role-model", {
    readSettings: mockSettings,
    fetchImpl: mockFetch,
  });

  assert(result.primaryUsedPercent === 20, "fallback: uses first model's primary percent");
  assert(result.primaryResetsAt === 1700000000000, "fallback: uses first model's end_time");
}

// ── 主测试 ─────────────────────────────────────────────────────

async function main() {
  try {
    testNormalizeMetricsWithValidData();
    testNormalizeMetricsWithZeroDenominator();
    testNormalizeMetricsWithNullInput();
    testSelectModelRemainWithMatch();
    testSelectModelRemainNoMatchFallsBackToFirst();
    testSelectModelRemainWithNullModelName();
    testSelectModelRemainWithEmptyArray();
    testSelectModelRemainRoleModelTakesPriority();
    testGetClaudeSettingsReadsEnvPath();
    // getClaudeRoleCardMetrics async tests (with proper dependency injection)
    await testGetClaudeRoleCardMetricsSuccess();
    await testGetClaudeRoleCardMetricsNoApiKey();
    await testGetClaudeRoleCardMetricsFetchRejects();
    await testGetClaudeRoleCardMetricsNonOkResponse();
    await testGetClaudeRoleCardMetricsInvalidJson();
    await testGetClaudeRoleCardMetricsSettingsFallbackToFirst();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();