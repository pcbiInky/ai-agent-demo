#!/usr/bin/env node

/**
 * 测试 lib/usage-metrics.js 通用额度窗口框架，
 * 以及 claude-metrics 迁移到 usageWindows 后的兼容性。
 */

const usage = require("../lib/usage-metrics");
const claudeMetrics = require("../lib/claude-metrics");

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

function testParseResetsAt() {
  eq(usage.parseResetsAt(1700000000000), 1700000000000, "parseResetsAt keeps ms timestamp");
  eq(usage.parseResetsAt(1700000000), 1700000000000, "parseResetsAt converts seconds to ms");
  eq(usage.parseResetsAt("2026-09-16T08:43:06.334827Z"), Date.parse("2026-09-16T08:43:06.334827Z"), "parseResetsAt parses ISO string");
  eq(usage.parseResetsAt(null), null, "parseResetsAt null -> null");
  eq(usage.parseResetsAt(""), null, "parseResetsAt empty -> null");
  eq(usage.parseResetsAt("not-a-date"), null, "parseResetsAt invalid -> null");
}

function testNormalizeUsageWindows() {
  const windows = usage.normalizeUsageWindows([
    { key: "5h", label: "5h", usedPercent: 30.8, resetsAt: 1700000000000 },
    { key: "month", label: "month", usedPercent: 4.54, resetsAt: "2026-10-16T00:00:00Z" },
    { key: "5h", label: "dup", usedPercent: 99 },
    { label: "no-key", usedPercent: 50 },
    null,
  ]);
  eq(windows.length, 2, "normalizeUsageWindows drops dup/invalid entries");
  eq(windows[0].usedPercent, 31, "normalizeUsageWindows rounds percent");
  eq(windows[1].label, "month", "normalizeUsageWindows keeps label");
  eq(windows[1].resetsAt, Date.parse("2026-10-16T00:00:00Z"), "normalizeUsageWindows parses ISO resetsAt");
}

function testWindowsFromLegacy() {
  const none = usage.windowsFromLegacy({ primaryUsedPercent: null, primaryResetsAt: null });
  eq(none.length, 0, "windowsFromLegacy skips empty dimensions");

  const both = usage.windowsFromLegacy(
    { primaryUsedPercent: 25, secondaryUsedPercent: 20, primaryResetsAt: 1, secondaryResetsAt: 2 },
    { primaryLabel: "5h", secondaryLabel: "week" }
  );
  eq(both.length, 2, "windowsFromLegacy builds two windows");
  eq(both[0].label, "5h", "windowsFromLegacy primary label");
  eq(both[1].label, "week", "windowsFromLegacy secondary label");
}

function testBuildUsageMetrics() {
  const metrics = usage.buildUsageMetrics(
    [
      { key: "5h", label: "5h", usedPercent: 31, resetsAt: 1700000000000 },
      { key: "month", label: "month", usedPercent: 5, resetsAt: 1800000000000 },
    ],
    { supportsTokenUsage: false }
  );
  eq(metrics.supportsUsageWindows, true, "buildUsageMetrics supportsUsageWindows true with windows");
  eq(metrics.usageWindows.length, 2, "buildUsageMetrics keeps usageWindows");
  eq(metrics.primaryUsedPercent, 31, "buildUsageMetrics mirrors primaryUsedPercent");
  eq(metrics.secondaryUsedPercent, 5, "buildUsageMetrics mirrors secondaryUsedPercent");
  eq(metrics.primaryResetsAt, 1700000000000, "buildUsageMetrics mirrors primaryResetsAt");

  const empty = usage.buildUsageMetrics([], { supportsUsageWindows: false, supportsTokenUsage: false });
  eq(empty.supportsUsageWindows, false, "buildUsageMetrics empty supportsUsageWindows false");
  eq(empty.usageWindows.length, 0, "buildUsageMetrics empty usageWindows");
  eq(empty.primaryUsedPercent, null, "buildUsageMetrics empty primaryUsedPercent null");

  const forced = usage.buildUsageMetrics([], { supportsUsageWindows: true });
  eq(forced.supportsUsageWindows, true, "buildUsageMetrics honors explicit supportsUsageWindows");
}

function testClaudeMigrationKeepsLegacyAndAddsWindows() {
  const result = claudeMetrics.normalizeMetrics({
    current_interval_total_count: 100,
    current_interval_usage_count: 25,
    current_weekly_total_count: 500,
    current_weekly_usage_count: 100,
    end_time: 1700000000000,
    weekly_end_time: 1700600000000,
  });
  eq(result.primaryUsedPercent, 25, "claude legacy primaryUsedPercent preserved");
  eq(result.secondaryUsedPercent, 20, "claude legacy secondaryUsedPercent preserved");
  eq(result.usageWindows.length, 2, "claude exposes usageWindows");
  eq(result.usageWindows[0].label, "5h", "claude window 1 = 5h");
  eq(result.usageWindows[1].label, "week", "claude window 2 = week");

  const none = claudeMetrics.normalizeMetrics(null);
  eq(none.supportsUsageWindows, false, "claude null input keeps supportsUsageWindows false");
}

function main() {
  try {
    testParseResetsAt();
    testNormalizeUsageWindows();
    testWindowsFromLegacy();
    testBuildUsageMetrics();
    testClaudeMigrationKeepsLegacyAndAddsWindows();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
