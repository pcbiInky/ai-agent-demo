/**
 * Office Document MCP Server
 *
 * Provides 4 tools for reading and editing DOCX/PPTX files:
 *   - open_document_session
 *   - analyze_document
 *   - apply_document_operations
 *   - save_document_session
 *
 * Architecture: Node MCP shell + Python worker (JSON over stdio)
 * Protocol version: 1
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { spawn } = require("child_process");
const pathMod = require("path");
const readline = require("readline");
const fs = require("fs");
const { OfficeSessionStore } = require("./lib/office-session-store");
const {
  OpenDocumentSessionInput,
  AnalyzeDocumentInput,
  ApplyDocumentOperationsInput,
  SaveDocumentSessionInput,
} = require("./lib/office-schemas");

const PROTOCOL_VERSION = 1;
const log = (msg) => process.stderr.write(`[office-mcp] ${msg}\n`);

// ── Python Worker ──────────────────────────────────────────

class PythonWorker {
  constructor() {
    this._proc = null;
    this._rl = null;
    this._pending = new Map();
    this._counter = 0;
    this._alive = false;
  }

  start() {
    const workerPath = pathMod.join(__dirname, "python", "office_worker.py");
    this._proc = spawn("python3", ["-u", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: __dirname,
    });

    this._alive = true;

    this._proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    this._proc.on("exit", (code) => {
      log(`Python worker exited with code ${code}`);
      this._alive = false;
      for (const [, { reject }] of this._pending) {
        reject(Object.assign(new Error("Python worker exited unexpectedly"), { code: "WORKER_EXIT" }));
      }
      this._pending.clear();
    });

    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on("line", (line) => {
      let resp;
      try {
        resp = JSON.parse(line);
      } catch (e) {
        log(`Non-JSON from worker stdout: ${line.slice(0, 200)}`);
        return;
      }
      const pending = this._pending.get(resp.id);
      if (!pending) return;
      this._pending.delete(resp.id);
      if (resp.ok) {
        pending.resolve(resp.result);
      } else {
        const err = resp.error || {};
        const error = new Error(typeof err === "string" ? err : (err.message || "Unknown worker error"));
        error.code = (typeof err === "object" ? err.code : null) || "UNKNOWN";
        error.details = (typeof err === "object" ? err.details : null) || null;
        pending.reject(error);
      }
    });

    return this.call("ping", {}).then(() => {
      log("Python worker is ready");
    });
  }

  call(action, params, timeoutMs = 60_000) {
    if (!this._alive) {
      return Promise.reject(Object.assign(new Error("Python worker is not running"), { code: "WORKER_DOWN" }));
    }
    const id = `req-${++this._counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(Object.assign(new Error(`Worker call timed out: ${action}`), { code: "TIMEOUT" }));
      }, timeoutMs);

      this._pending.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      const msg = JSON.stringify({ id, protocol_version: PROTOCOL_VERSION, action, params }) + "\n";
      this._proc.stdin.write(msg);
    });
  }

  stop() {
    this._alive = false;
    if (this._proc) {
      this._proc.stdin.end();
      this._proc.kill();
    }
  }
}

// ── MCP Server ─────────────────────────────────────────────

const sessionStore = new OfficeSessionStore();
const worker = new PythonWorker();
const server = new McpServer({ name: "office-mcp", version: "1.0.0" });

// 1. open_document_session
server.tool(
  "open_document_session",
  "打开一个 Office 文档会话（DOCX 或 PPTX），创建工作副本。返回 session_id 用于后续操作。同一源文件同时只允许一个可写 session。",
  OpenDocumentSessionInput.shape,
  async ({ file_path }) => {
    try {
      const session = sessionStore.open(file_path);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            session_id: session.id,
            doc_type: session.docType,
            source_path: session.sourcePath,
            working_copy_path: session.workingCopyPath,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true };
    }
  }
);

// 2. analyze_document
server.tool(
  "analyze_document",
  "分析文档结构。mode=summary 返回完整结构概要和可编辑定位信息；mode=search 按关键词搜索并返回匹配位置。",
  AnalyzeDocumentInput.shape,
  async ({ session_id, mode, query }) => {
    try {
      const session = sessionStore.get(session_id);
      if (mode === "search" && !query) {
        return { content: [{ type: "text", text: "错误: search 模式需要提供 query 参数" }], isError: true };
      }
      const result = await worker.call("analyze", {
        doc_type: session.docType,
        file_path: session.workingCopyPath,
        mode,
        query,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `错误 [${e.code || "UNKNOWN"}]: ${e.message}` }], isError: true };
    }
  }
);

// 3. apply_document_operations
server.tool(
  "apply_document_operations",
  "对文档执行批量编辑操作（all-or-nothing）。所有操作必须带 target locator（来自 analyze_document 返回的索引）。DOCX: replace_text(target.paragraph_index), insert_paragraph_after, delete_paragraph。PPTX: replace_text(target.slide_index+shape_index), add_text_slide, delete_slide。单次最多 20 个操作。",
  ApplyDocumentOperationsInput.shape,
  async ({ session_id, operations }) => {
    try {
      const session = sessionStore.get(session_id);

      // Backup for all-or-nothing rollback
      const backupPath = session.workingCopyPath + ".bak";
      fs.copyFileSync(session.workingCopyPath, backupPath);

      let result;
      try {
        result = await worker.call("apply_operations", {
          doc_type: session.docType,
          file_path: session.workingCopyPath,
          operations,
        });
      } catch (e) {
        // Restore backup on worker error
        fs.copyFileSync(backupPath, session.workingCopyPath);
        fs.unlinkSync(backupPath);
        throw e;
      }

      if (!result.success) {
        // Rollback: restore from backup
        fs.copyFileSync(backupPath, session.workingCopyPath);
        fs.unlinkSync(backupPath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: `操作失败，已回滚。第 ${result.failed_op_index} 个操作 (${result.failed_op}) 出错: ${result.error}`,
              ...result,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Success — remove backup
      fs.unlinkSync(backupPath);
      sessionStore.markDirty(session_id, operations);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            applied_count: result.applied.length,
            applied: result.applied,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `错误 [${e.code || "UNKNOWN"}]: ${e.message}` }], isError: true };
    }
  }
);

// 4. save_document_session
server.tool(
  "save_document_session",
  "保存文档会话的工作副本。可指定 output_path 另存为（需 overwrite=true 才能覆盖已有文件），默认保存到工作副本路径。",
  SaveDocumentSessionInput.shape,
  async ({ session_id, output_path, overwrite }) => {
    try {
      const savedPath = sessionStore.save(session_id, output_path, overwrite);
      const session = sessionStore.get(session_id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            saved_to: savedPath,
            source_path: session.sourcePath,
            op_count: session.opLog.length,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `错误: ${e.message}` }], isError: true };
    }
  }
);

// ── Startup ────────────────────────────────────────────────

async function main() {
  await worker.start();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Office MCP Server started (4 tools registered)");
}

process.on("SIGINT", () => {
  worker.stop();
  sessionStore.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  worker.stop();
  sessionStore.destroy();
  process.exit(0);
});

main().catch((err) => {
  log(`Startup failed: ${err.message}`);
  process.exit(1);
});
