"use strict";

/**
 * 通用额度窗口（usage window）归一化工具。
 *
 * 不同 CLI 的额度维度并不相同：
 *   - codex:  5h + week
 *   - claude: 5h + week
 *   - dsh:    balance
 *   - kimi:   5h + month（没有 week 维度）
 *
 * 因此角色卡片不再把 primary/secondary 写死成“第一个=时间、第二个=week”，
 * 而是统一归一化成有序的 usageWindows 数组，前端按数组顺序渲染：
 * 新增/调整维度时只改对应 metrics 模块，不必改渲染逻辑。
 *
 * window 结构：
 *   {
 *     key: string,            // 稳定标识：5h / week / month ...
 *     label: string,          // 展示文案
 *     usedPercent: number|null, // 0-100，null 表示未知
 *     resetsAt: number|null,  // epoch 毫秒，null 表示未知
 *   }
 */

function toUsedPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 把不同来源的重置时间统一成 epoch 毫秒。
 * 支持：毫秒时间戳、秒时间戳、ISO 字符串。
 */
function parseResetsAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeWindow(win) {
  if (!win || typeof win !== "object") return null;
  const key = win.key != null && String(win.key) !== "" ? String(win.key) : "";
  if (!key) return null;
  return {
    key,
    label: win.label != null && String(win.label) !== "" ? String(win.label) : key,
    usedPercent: win.usedPercent === undefined ? null : toUsedPercent(win.usedPercent),
    resetsAt: win.resetsAt === undefined ? null : parseResetsAt(win.resetsAt),
  };
}

/**
 * 归一化窗口列表：去重、保序、丢弃非法项。
 */
function normalizeUsageWindows(windows) {
  if (!Array.isArray(windows)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of windows) {
    const win = normalizeWindow(raw);
    if (!win || seen.has(win.key)) continue;
    seen.add(win.key);
    out.push(win);
  }
  return out;
}

/**
 * 把旧版 primary/secondary 字段还原成窗口列表（用于兼容与迁移）。
 * 仅当该维度有实际数据时才生成窗口。
 */
function windowsFromLegacy(metrics, { primaryLabel = "5h", secondaryLabel = "week" } = {}) {
  const src = metrics || {};
  const windows = [];
  if (src.primaryUsedPercent != null || src.primaryResetsAt != null) {
    windows.push({
      key: "primary",
      label: primaryLabel,
      usedPercent: src.primaryUsedPercent,
      resetsAt: src.primaryResetsAt,
    });
  }
  if (src.secondaryUsedPercent != null || src.secondaryResetsAt != null) {
    windows.push({
      key: "secondary",
      label: secondaryLabel,
      usedPercent: src.secondaryUsedPercent,
      resetsAt: src.secondaryResetsAt,
    });
  }
  return windows;
}

/**
 * 由窗口列表构造标准 role-card metrics：
 *   - usageWindows 为唯一数据源
 *   - 同时镜像 primary/secondary 旧字段，保证旧前端/旧测试兼容
 *   - base 中显式给出的 supportsUsageWindows 优先（例如“已拉到数据但本周期为空”）
 */
function buildUsageMetrics(windows, base = {}) {
  const normalized = normalizeUsageWindows(windows);
  const { supportsUsageWindows, ...rest } = base;
  const [primary, secondary] = normalized;
  return {
    ...rest,
    supportsUsageWindows:
      supportsUsageWindows !== undefined ? supportsUsageWindows : normalized.length > 0,
    usageWindows: normalized,
    primaryUsedPercent: primary ? primary.usedPercent : null,
    secondaryUsedPercent: secondary ? secondary.usedPercent : null,
    primaryResetsAt: primary ? primary.resetsAt : null,
    secondaryResetsAt: secondary ? secondary.resetsAt : null,
  };
}

module.exports = {
  toUsedPercent,
  parseResetsAt,
  normalizeWindow,
  normalizeUsageWindows,
  windowsFromLegacy,
  buildUsageMetrics,
};
