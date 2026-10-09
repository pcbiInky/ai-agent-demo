#!/usr/bin/env node

/**
 * 测试 lib/qodercn-metrics.js：
 * qodercn 的账号 Credits 来自官方 SDK，会话上下文来自 transcript。
 * usageWindows 展示各额度的剩余比例及「上下文剩余」，不暴露 token 绝对值。
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
  delete require.cache[require.resolve("../lib/qodercn-metrics")];
  return require("../lib/qodercn-metrics");
}

function assistantEvent(ratio) {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", usage: { context_usage_ratio: ratio } },
  });
}

function resultEvent(ratio) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    usage: { context_usage_ratio: ratio },
  });
}

function writeTranscript(projectsDir, projectSlug, sessionId, lines) {
  const dir = path.join(projectsDir, projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function testBuildContextMetrics() {
  const { buildQodercnContextMetrics } = reload();

  const half = buildQodercnContextMetrics(0.5);
  eq(half.supportsUsageWindows, true, "ratio 0.5: usage window supported");
  eq(half.usageWindows.length, 1, "ratio 0.5: one ctx window");
  eq(half.usageWindows[0].key, "ctx", "ratio 0.5: window key");
  eq(half.usageWindows[0].usedPercent, 50, "ratio 0.5: remaining 50%");
  eq(half.usageWindows[0].resetsAt, null, "ctx window has no reset time");
  eq(half.supportsTokenUsage, false, "no absolute token counts");

  const full = buildQodercnContextMetrics(0.9966);
  eq(full.usageWindows[0].usedPercent, 0, "ratio near 1: remaining rounds to 0%");

  const over = buildQodercnContextMetrics(1.5);
  eq(over.usageWindows[0].usedPercent, 0, "ratio above 1 is clamped to 0%");

  const invalid = buildQodercnContextMetrics("not-a-number");
  eq(invalid.usageWindows[0].usedPercent, null, "invalid ratio: null percent placeholder");
}

function testBuildQuotaWindows() {
  const { buildQodercnQuotaWindows } = reload();
  const windows = buildQodercnQuotaWindows({
    userQuota: { total: 2000, used: 500, remaining: 1500, percentage: 25, unit: "credits" },
    addOnQuota: { total: 283, used: 2, remaining: 281, percentage: 1, unit: "credits" },
    orgResourcePackage: { cap: 100, used: 20, remaining: 80, available: true, unit: "credits" },
  });
  eq(windows.length, 3, "account usage: plan, add-on and organization windows");
  eq(Math.round(windows[0].usedPercent), 75, "plan remaining comes from remaining/total");
  eq(Math.round(windows[1].usedPercent), 99, "add-on remaining comes from remaining/total");
  eq(Math.round(windows[2].usedPercent), 80, "organization remaining comes from remaining/cap");
  assert(windows[0].detail.includes("1500 / 总量 2000"), "plan detail exposes raw Credits");
  eq(buildQodercnQuotaWindows({}).length, 0, "missing account quota creates no fake window");
  eq(buildQodercnQuotaWindows({ userQuota: { percentage: 40 } })[0].usedPercent, 60, "percentage fallback uses remaining percent");
}

function testFindTranscriptPath() {
  const { findQodercnTranscriptPath } = reload();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-metrics-"));
  try {
    const expected = writeTranscript(tempDir, "-Users-x-code-a", "sess-1", [assistantEvent(0.1)]);
    writeTranscript(tempDir, "-Users-x-code-b", "sess-2", [assistantEvent(0.2)]);

    eq(findQodercnTranscriptPath("sess-1", tempDir), expected, "finds transcript across project dirs");
    eq(findQodercnTranscriptPath("missing", tempDir), null, "unknown session: null");
    eq(findQodercnTranscriptPath(null, tempDir), null, "no session: null");
    eq(findQodercnTranscriptPath("sess-1", path.join(tempDir, "nope")), null, "missing projects dir: null");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testReadContextUsageRatio() {
  const { readQodercnContextUsageRatio } = reload();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-metrics-"));
  try {
    const filePath = writeTranscript(tempDir, "p", "sess-1", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      assistantEvent(0.0966),
      "not-json-line",
      assistantEvent(0.25),
      resultEvent(0.25),
    ]);
    eq(readQodercnContextUsageRatio(filePath), 0.25, "takes the latest ratio from the tail");

    const noUsage = writeTranscript(tempDir, "p", "sess-2", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" }),
    ]);
    eq(readQodercnContextUsageRatio(noUsage), null, "no usage events: null");
    eq(readQodercnContextUsageRatio(path.join(tempDir, "nope.jsonl")), null, "missing file: null");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testGetQodercnRoleCardMetrics() {
  const mod = reload();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qodercn-metrics-"));
  try {
    writeTranscript(tempDir, "p", "sess-1", [assistantEvent(0.4), resultEvent(0.4)]);

    const fetchUsageInfo = async () => ({
      userQuota: { total: 2000, used: 500, remaining: 1500, unit: "credits" },
      addOnQuota: { total: 100, used: 20, remaining: 80, unit: "credits" },
    });
    const ok = await mod.getQodercnRoleCardMetrics("sess-1", { projectsDir: tempDir, fetchUsageInfo });
    eq(ok.usageWindows.length, 3, "account quotas and context are shown together");
    eq(ok.usageWindows[0].usedPercent, 75, "plan remaining 75%");
    assert(ok.usageWindows[0].detail.includes("1500 / 总量 2000"), "normalized plan window keeps Credit detail");
    eq(ok.usageWindows[1].usedPercent, 80, "add-on remaining 80%");
    eq(ok.usageWindows[2].usedPercent, 60, "transcript: context remaining 60%");
    eq(ok.sources.quota, "qodercn-agent-sdk", "account quota source tagged");
    eq(ok.sources.usage, "transcript", "transcript: source tagged");

    const noSession = await mod.getQodercnRoleCardMetrics(null, { projectsDir: tempDir, fetchUsageInfo });
    eq(noSession.usageWindows[0].usedPercent, 75, "account quota available without session");
    eq(noSession.usageWindows[2].usedPercent, null, "no session: context placeholder");
    eq(noSession.sources.usage, "no-session", "no session: source tagged");

    const noTranscript = await mod.getQodercnRoleCardMetrics("missing", { projectsDir: tempDir, fetchUsageInfo });
    eq(noTranscript.sources.usage, "no-transcript", "missing transcript: source tagged");
    eq(noTranscript.usageWindows[2].usedPercent, null, "missing transcript: context placeholder");

    const failed = await mod.getQodercnRoleCardMetrics("sess-1", {
      projectsDir: tempDir,
      fetchUsageInfo: async () => { throw new Error("unavailable"); },
    });
    eq(failed.usageWindows.length, 1, "SDK failure keeps context metric");
    eq(failed.usageWindows[0].usedPercent, 60, "SDK failure preserves context remaining");
    eq(failed.sources.quota, "unavailable", "SDK failure is labeled");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testQoderCnResultEventEmitsMetrics() {
  delete require.cache[require.resolve("../invoke.js")];
  const { __test } = require("../invoke.js");

  const events = [];
  __test.parseQoderCnJsonEvent(
    { type: "result", subtype: "success", usage: { context_usage_ratio: 0.2 } },
    () => {},
    () => {},
    (event) => events.push(event)
  );
  eq(events.length, 1, "result event: one runtime event");
  eq(events[0].type, "metrics", "result event: metrics type");
  eq(events[0].data.usageWindows[0].usedPercent, 80, "result event: remaining 80%");

  events.length = 0;
  __test.parseQoderCnJsonEvent(
    { type: "result", subtype: "success", usage: {} },
    () => {},
    () => {},
    (event) => events.push(event)
  );
  eq(events.length, 0, "result without ratio: no metrics event");

  const metas = [];
  __test.parseQoderCnJsonEvent(
    { type: "system", subtype: "init", session_id: "s-1" },
    () => {},
    (meta) => metas.push(meta),
    () => {}
  );
  eq(metas[0]?.sessionId, "s-1", "init event: session_id still extracted");
}

async function main() {
  try {
    testBuildContextMetrics();
    testBuildQuotaWindows();
    testFindTranscriptPath();
    testReadContextUsageRatio();
    await testGetQodercnRoleCardMetrics();
    testQoderCnResultEventEmitsMetrics();
  } finally {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
