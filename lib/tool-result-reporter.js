// 编辑类工具执行结果回报（供 permission-server.js 使用）
// 快照按 before+after 合计字节数限制在 express.json 默认 100KB 请求体上限内；
// 回报被拒（如 413）时降级为仅 oversized 重试，避免成功记录静默丢失。
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

const SNAPSHOT_TOTAL_MAX_BYTES = 80 * 1024;

function fileSizeOrNull(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

// 流式 sha256，大文件不占内存。
// 返回 { status, hash }：status 为 ok / missing（文件不存在）/ error（存在但读取失败）。
// missing 与 error 必须区分：hash 不可得时不能推断"无变化"。
function hashFile(filePath) {
  return new Promise((resolve) => {
    if (!filePath) return resolve({ status: "missing", hash: null });
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve({ status: "ok", hash: hash.digest("hex") }));
    stream.on("error", (err) => resolve({ status: err && err.code === "ENOENT" ? "missing" : "error", hash: null }));
  });
}

// 依据执行前后的 hash 与内容读取结果决定回报形态。
// 返回 { changed?, snapshotError: true } / { changed?, oversized: true } / { changed?, before, after }
// 原则：任何"内容不可得"（hash 失败、读取失败、执行后文件已不存在）都不得伪装成有效快照。
function classifySnapshot({ beforeSnap, afterSnap, beforeContent, afterContent, totalSize }) {
  // 成功的编辑工具都应留下文件；执行后缺失（无论执行前是否存在）说明被外部删除或竞争，
  // 不能画成"空文件"，也不能因两侧 hash 同为 null 判成"无变化"而被前端丢弃
  const unknown = beforeSnap.status === "error" || afterSnap.status === "error" || afterSnap.status === "missing";
  const changed = unknown ? undefined : beforeSnap.hash !== afterSnap.hash;
  if (unknown) return { changed, snapshotError: true };
  if (totalSize > SNAPSHOT_TOTAL_MAX_BYTES) return { changed, oversized: true };
  // beforeContent 为 null 且文件原本存在 = 读取失败（原本不存在才是合法的新文件语义）
  const beforeReadFailed = beforeContent === null && beforeSnap.status !== "missing";
  if (beforeReadFailed || afterContent === null) return { changed, snapshotError: true };
  return { changed, before: beforeContent, after: afterContent };
}

function postResult(port, payload) {
  return new Promise((resolve) => {
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      return resolve(0);
    }
    let req;
    try {
      req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/tool-result",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
    } catch {
      return resolve(0);
    }
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// 返回最终 HTTP 状态码（0 表示网络失败）；含快照的回报被拒时自动降级为 oversized 重试一次
async function reportToolResult(payload, { port, log = () => {} } = {}) {
  let status = await postResult(port, payload);
  if (status >= 200 && status < 300) return status;

  if (payload.before != null || payload.after != null) {
    log(`执行结果回报被拒（HTTP ${status}），降级为 oversized 重试`);
    const { before, after, ...rest } = payload;
    status = await postResult(port, { ...rest, oversized: true });
  }
  if (!(status >= 200 && status < 300)) {
    log(`执行结果回报失败（HTTP ${status}）：本次修改不会被记录（可观测性缺口）`);
  }
  return status;
}

module.exports = {
  SNAPSHOT_TOTAL_MAX_BYTES,
  fileSizeOrNull,
  hashFile,
  classifySnapshot,
  reportToolResult,
};
