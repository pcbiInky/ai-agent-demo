/**
 * MCP 工具代理服务器（stdio 传输）
 *
 * 替代 Claude CLI 的内置工具（Bash/Read/Edit/Write/Glob/Grep 等），
 * 所有操作先向 Web UI 请求权限审批，批准后才真正执行。
 *
 * 环境变量：
 *   PERMISSION_SERVER_PORT    — Express 服务端口（默认 3000）
 *   PERMISSION_SERVER_HOST    — Express 服务监听地址（默认 127.0.0.1；绑定具体网卡或 ::1 时由主服务注入）
 *   PERMISSION_BROWSER_SESSION — 浏览器会话 ID（用于关联 SSE 推送）
 *   PERMISSION_CHARACTER      — 角色名（用于前端显示）
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { runCommandTree, killActiveCommandTrees } = require("./lib/process-tree");
const { globSync } = require("fs").promises ? { globSync: null } : {};

const PORT = process.env.PERMISSION_SERVER_PORT || "3000";
// 主服务可能绑定具体网卡地址或 ::1，此时回报必须连它实际监听的地址
const SERVER_HOST = process.env.PERMISSION_SERVER_HOST || "127.0.0.1";
const TIMEOUT_MS = 120_000;

function getContext() {
  return {
    browserSessionId: process.env.PERMISSION_BROWSER_SESSION || "",
    character: process.env.PERMISSION_CHARACTER || "",
    workingDirectory: process.env.PERMISSION_WORKING_DIRECTORY || "",
  };
}

const log = (msg) => process.stderr.write(`[permission-server] ${msg}\n`);

// 门禁启用时，内部路由也要凭证；默认本机模式下该变量为空，不发送头部
function internalAuthHeaders() {
  const token = process.env.PERMISSION_INTERNAL_TOKEN || "";
  return token ? { "x-internal-token": token } : {};
}

const server = new McpServer({
  name: "permission",
  version: "1.0.0",
});

// ── HTTP 权限请求（长轮询）──────────────────────────────────
function requestPermission(toolName, input) {
  return new Promise((resolve, reject) => {
    const ctx = getContext();
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({
      toolName,
      toolUseId: requestId,
      input,
      browserSessionId: ctx.browserSessionId,
      character: ctx.character,
      timestamp: Date.now(),
    });

    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: parseInt(PORT, 10),
        path: "/api/permission-request",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...internalAuthHeaders(),
        },
        timeout: TIMEOUT_MS + 10_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`权限服务响应解析失败: ${data}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(new Error(`无法连接权限服务: ${err.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("权限请求超时")); });
    req.write(body);
    req.end();
  });
}

// 工具通用封装：请求权限 → 批准则执行 → 返回结果
// executeFn 接收 decision 参数（包含 requestId 等审批信息）
async function withPermission(toolName, input, executeFn) {
  log(`工具请求: ${toolName}`);

  try {
    const decision = await requestPermission(toolName, input);

    if (decision.behavior !== "allow") {
      log(`用户拒绝: ${toolName}`);
      return { content: [{ type: "text", text: `操作被用户拒绝: ${decision.message || "未授权"}` }], isError: true };
    }

    log(`用户允许: ${toolName}，开始执行`);
    const result = await executeFn(decision);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    log(`错误: ${toolName} — ${err.message}`);
    return { content: [{ type: "text", text: `执行错误: ${err.message}` }], isError: true };
  }
}

// ── 编辑类工具的执行结果回报（before/after 快照）────────────
const {
  hashFile,
  classifySnapshot,
  reportToolResult,
} = require("./lib/tool-result-reporter");

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function report(payload) {
  return reportToolResult(payload, { port: parseInt(PORT, 10), log });
}

// 快照执行封装：批准 → 读 before → 执行 → 读 after → 分类回报（有效快照 / snapshotError）
// 内容不可得（hash 失败、读取失败、执行后文件已不存在）一律 snapshotError 且 changed 未知，
// 绝不把缺失或读取失败当成"空文件"或"无变化"
function withFileSnapshot(toolName, getFilePath, input, executeFn) {
  return withPermission(toolName, input, async (decision) => {
    const filePath = getFilePath(input);
    const beforeSnap = await hashFile(filePath);
    const beforeContent = beforeSnap.status === "ok" ? readFileOrNull(filePath) : null;

    let resultText;
    try {
      resultText = await executeFn(decision);
    } catch (err) {
      await report({
        requestId: decision.requestId,
        toolName,
        ok: false,
        error: err.message,
        filePath,
        changed: false,
        finishedAt: Date.now(),
      });
      throw err;
    }

    const afterSnap = await hashFile(filePath);
    const afterContent = afterSnap.status === "ok" ? readFileOrNull(filePath) : null;
    const { changed, ...snapshot } = classifySnapshot({ beforeSnap, afterSnap, beforeContent, afterContent });

    await report({
      requestId: decision.requestId,
      toolName,
      ok: true,
      filePath,
      ...(changed !== undefined ? { changed } : {}),
      ...snapshot,
      finishedAt: Date.now(),
    });
    return resultText;
  });
}

// ── 工具注册 ────────────────────────────────────────────────

// 1. Bash
server.tool(
  "Bash",
  "在系统 shell 中执行命令",
  {
    command: z.string().describe("要执行的 bash 命令"),
    cwd: z.string().optional().describe("命令执行目录"),
    description: z.string().optional().describe("命令的简短描述"),
    timeout: z.number().optional().describe("超时时间(ms)"),
  },
  async ({ command, cwd, description, timeout }) => {
    const ctx = getContext();
    const effectiveCwd = cwd || ctx.workingDirectory || undefined;
    const effectiveTimeout = timeout || 120_000;
    // 用 spawn 替代 execSync：保留子进程引用，宿主被终止 / 超时时能杀掉
    // 整棵进程树（execSync 只杀 sh 自己，命令再启动的子孙会被 init 收养继续跑）
    return withPermission("Bash", { command, cwd: effectiveCwd, description }, async () => {
      const { code, signal, stdout, stderr, timedOut, truncated } = await runCommandTree(command, {
        cwd: effectiveCwd,
        timeoutMs: effectiveTimeout,
      });
      const suffix = truncated ? "\n(输出过长已截断)" : "";
      if (timedOut) {
        const msg = stderr || stdout || "";
        return `命令执行失败 (超时 ${effectiveTimeout}ms，进程树已终止)${msg ? `\n${msg}` : ""}${suffix}`;
      }
      if (truncated) {
        // 输出超限即整树终止（与 execSync 的 maxBuffer 语义一致）
        const msg = stdout || stderr || "";
        return `命令执行失败 (输出超过 10MB 上限，进程树已终止)${msg ? `\n${msg}` : ""}`;
      }
      if (code === 0) return (stdout || "(无输出)") + suffix;
      const msg = stderr || stdout || (signal ? `signal ${signal}` : "");
      return `命令执行失败 (exit ${code ?? "?"})${msg ? `\n${msg}` : ""}${suffix}`;
    });
  }
);

// 2. Read
server.tool(
  "Read",
  "读取文件内容",
  {
    file_path: z.string().describe("文件的绝对路径"),
    offset: z.number().optional().describe("起始行号"),
    limit: z.number().optional().describe("读取行数"),
  },
  async ({ file_path, offset, limit }) => {
    return withPermission("Read", { file_path, offset, limit }, () => {
      const content = fs.readFileSync(file_path, "utf-8");
      const lines = content.split("\n");
      const start = (offset || 1) - 1;
      const end = limit ? start + limit : lines.length;
      const sliced = lines.slice(start, end);
      return sliced.map((line, i) => `${String(start + i + 1).padStart(6)}  ${line}`).join("\n");
    });
  }
);

// 3. Edit
server.tool(
  "Edit",
  "替换文件中的指定文本",
  {
    file_path: z.string().describe("文件的绝对路径"),
    old_string: z.string().describe("要替换的原始文本"),
    new_string: z.string().describe("替换后的新文本"),
    replace_all: z.boolean().optional().describe("是否替换所有匹配"),
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    return withFileSnapshot("Edit", (i) => i.file_path, { file_path, old_string, new_string, ...(replace_all ? { replace_all: true } : {}) }, () => {
      const content = fs.readFileSync(file_path, "utf-8");
      let updated;
      if (replace_all) {
        updated = content.split(old_string).join(new_string);
      } else {
        const idx = content.indexOf(old_string);
        if (idx === -1) {
          throw new Error(`未找到要替换的文本`);
        }
        updated = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
      }
      fs.writeFileSync(file_path, updated);
      return `已更新 ${file_path}`;
    });
  }
);

// 4. Write
server.tool(
  "Write",
  "写入文件内容（覆盖）",
  {
    file_path: z.string().describe("文件的绝对路径"),
    content: z.string().describe("要写入的内容"),
  },
  async ({ file_path, content }) => {
    return withFileSnapshot("Write", (i) => i.file_path, { file_path, content: content.slice(0, 500) + (content.length > 500 ? "..." : "") }, () => {
      const dir = path.dirname(file_path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file_path, content);
      return `已写入 ${file_path} (${content.length} 字符)`;
    });
  }
);

// 5. Glob
server.tool(
  "Glob",
  "按模式搜索文件",
  {
    pattern: z.string().describe("glob 模式，如 **/*.js"),
    path: z.string().optional().describe("搜索目录"),
  },
  async ({ pattern, path: searchPath }) => {
    const ctx = getContext();
    const effectivePath = searchPath || ctx.workingDirectory || process.cwd();
    return withPermission("Glob", { pattern, path: effectivePath }, () => {
      // 使用 find 命令模拟 glob
      const dir = effectivePath;
      try {
        const result = execSync(
          `find ${JSON.stringify(dir)} -type f -name ${JSON.stringify(pattern.replace(/\*\*\//g, ""))} 2>/dev/null | head -200`,
          { encoding: "utf-8", timeout: 10_000 }
        );
        return result.trim() || "(未找到匹配文件)";
      } catch {
        return "(搜索失败)";
      }
    });
  }
);

// 6. Grep
server.tool(
  "Grep",
  "在文件内容中搜索正则表达式",
  {
    pattern: z.string().describe("正则表达式"),
    path: z.string().optional().describe("搜索目录或文件"),
    glob: z.string().optional().describe("文件过滤模式"),
    output_mode: z.string().optional().describe("输出模式: content/files_with_matches/count"),
  },
  async ({ pattern, path: searchPath, glob: globFilter, output_mode }) => {
    const ctx = getContext();
    const effectivePath = searchPath || ctx.workingDirectory || process.cwd();
    return withPermission("Grep", { pattern, path: effectivePath, glob: globFilter }, () => {
      const dir = effectivePath;
      let cmd = `rg --no-heading -n`;
      if (output_mode === "files_with_matches") cmd = `rg -l`;
      else if (output_mode === "count") cmd = `rg -c`;
      if (globFilter) cmd += ` --glob ${JSON.stringify(globFilter)}`;
      cmd += ` ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`;
      cmd += " 2>/dev/null | head -500";
      try {
        const result = execSync(cmd, { encoding: "utf-8", timeout: 15_000 });
        return result.trim() || "(未找到匹配)";
      } catch {
        return "(未找到匹配)";
      }
    });
  }
);

// 7. WebFetch
server.tool(
  "WebFetch",
  "获取 URL 内容",
  {
    url: z.string().describe("要获取的 URL"),
    prompt: z.string().optional().describe("对内容的提示"),
  },
  async ({ url, prompt }) => {
    return withPermission("WebFetch", { url, prompt }, () => {
      try {
        const result = execSync(
          `curl -sL --max-time 30 ${JSON.stringify(url)} | head -c 50000`,
          { encoding: "utf-8", timeout: 35_000 }
        );
        return result || "(空响应)";
      } catch (err) {
        return `获取失败: ${err.message}`;
      }
    });
  }
);

// 8. WebSearch
// 桥接到主服务的 /api/web-search：批准后由主服务保管凭据并调用 DeepSeek，
// 本进程不持有任何搜索密钥。客户端总超时采用明确的统一上限（上游可配置
// 最大 120s + 5s 余量），避免"上游 120s 而工具端固定 65s"的冲突
const { normalizeQuery: normalizeWebSearchQuery } = require("./lib/deepseek-web-search");
const WEB_SEARCH_CLIENT_TIMEOUT_MS = 125_000;

function postWebSearch(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: parseInt(PORT, 10),
        path: "/api/web-search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...internalAuthHeaders(),
        },
        timeout: WEB_SEARCH_CLIENT_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            reject(new Error(`搜索服务响应解析失败（HTTP ${res.statusCode}）`));
            return;
          }
          if (!parsed || parsed.ok !== true) {
            const code = parsed?.error?.code || "WEB_SEARCH_UPSTREAM_ERROR";
            const message = parsed?.error?.message || `HTTP ${res.statusCode}`;
            reject(new Error(`[${code}] ${message}`));
            return;
          }
          resolve(parsed.result);
        });
      }
    );
    req.on("error", (err) => reject(new Error(`[WEB_SEARCH_UPSTREAM_ERROR] 无法连接搜索服务: ${err.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("[WEB_SEARCH_TIMEOUT] 搜索请求超时")); });
    req.write(body);
    req.end();
  });
}

server.tool(
  "WebSearch",
  "搜索网页",
  {
    query: z.string().describe("搜索关键词"),
  },
  async ({ query }) => {
    const normalized = normalizeWebSearchQuery(query);
    if (normalized === null) {
      return { content: [{ type: "text", text: "[WEB_SEARCH_INVALID_INPUT] query 必须是非空字符串且不超过 4096 字符" }], isError: true };
    }
    return withPermission("WebSearch", { query: normalized }, async (decision) => {
      const result = await postWebSearch(JSON.stringify({ requestId: decision.requestId, query: normalized }));
      return JSON.stringify(result, null, 2);
    });
  }
);

// 9. NotebookEdit
server.tool(
  "NotebookEdit",
  "编辑 Jupyter Notebook 单元格",
  {
    notebook_path: z.string().describe("notebook 文件路径"),
    cell_number: z.number().optional().describe("单元格编号"),
    new_source: z.string().describe("新的单元格内容"),
    cell_type: z.string().optional().describe("单元格类型: code/markdown"),
    edit_mode: z.string().optional().describe("编辑模式: replace/insert/delete"),
  },
  async ({ notebook_path, cell_number, new_source, cell_type, edit_mode }) => {
    return withFileSnapshot("NotebookEdit", (i) => i.notebook_path, { notebook_path, cell_number, edit_mode }, () => {
      const content = JSON.parse(fs.readFileSync(notebook_path, "utf-8"));
      const mode = edit_mode || "replace";
      const idx = cell_number || 0;

      if (mode === "replace" && content.cells[idx]) {
        content.cells[idx].source = new_source.split("\n").map((l, i, a) => i < a.length - 1 ? l + "\n" : l);
        if (cell_type) content.cells[idx].cell_type = cell_type;
      } else if (mode === "insert") {
        const cell = {
          cell_type: cell_type || "code",
          source: new_source.split("\n").map((l, i, a) => i < a.length - 1 ? l + "\n" : l),
          metadata: {},
          ...(cell_type !== "markdown" && { outputs: [], execution_count: null }),
        };
        content.cells.splice(idx, 0, cell);
      } else if (mode === "delete") {
        content.cells.splice(idx, 1);
      }

      fs.writeFileSync(notebook_path, JSON.stringify(content, null, 1));
      return `已${mode === "replace" ? "更新" : mode === "insert" ? "插入" : "删除"}单元格 #${idx}`;
    });
  }
);

// 10. SendMessage
server.tool(
  "SendMessage",
  "向当前聊天室发布消息，可通过 atTargets 显式召唤其他角色",
  {
    text: z.string().describe("消息文本内容"),
    atTargets: z.array(z.string()).optional()
      .describe('要召唤的角色名列表，如 ["YYF", "奇迹哥"]。只有在此列表中的角色才会被唤醒'),
    threadId: z.string().optional()
      .describe("关联的线程ID，不传则作为独立消息"),
  },
  async ({ text, atTargets, threadId }) => {
    const permInput = { text: text.slice(0, 200) + (text.length > 200 ? "..." : "") };
    if (atTargets?.length) permInput.atTargets = atTargets;

    return withPermission("SendMessage", permInput, async (decision) => {
      const body = JSON.stringify({
        text,
        atTargets: atTargets || [],
        threadId: threadId || null,
        requestId: decision.requestId,
      });

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: SERVER_HOST,
          port: parseInt(PORT, 10),
          path: "/api/mcp-send-message",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...internalAuthHeaders(),
          },
          timeout: 10_000,
        }, (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            try {
              const result = JSON.parse(data);
              resolve(result.ok ? `消息已发送 (id: ${result.messageId})` : `发送失败: ${result.error}`);
            } catch {
              reject(new Error(`响应解析失败: ${data}`));
            }
          });
        });
        req.on("error", (err) => reject(new Error(`无法连接服务: ${err.message}`)));
        req.write(body);
        req.end();
      });
    });
  }
);

// ── 启动 ──────────────────────────────────────────────────

// 退出清理：宿主 CLI 死亡（stdin EOF）或收到信号时，杀掉仍在执行的命令进程树，
// 不能孤儿化后让命令在后台继续跑
function shutdownAndExit(code) {
  killActiveCommandTrees("SIGTERM");
  process.exit(code);
}
process.on("SIGTERM", () => shutdownAndExit(0));
process.on("SIGINT", () => shutdownAndExit(0));
process.stdin.on("end", () => shutdownAndExit(0));
// exit 阶段只能同步操作：兜底 SIGKILL 一遍，防止 SIGTERM 后仍有残留
process.on("exit", () => killActiveCommandTrees("SIGKILL"));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP 工具代理服务器已启动（10 个工具已注册）");
}

main().catch((err) => {
  log(`启动失败: ${err.message}`);
  process.exit(1);
});
