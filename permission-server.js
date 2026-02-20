/**
 * MCP 工具代理服务器（stdio 传输）
 *
 * 替代 Claude CLI 的内置工具（Bash/Read/Edit/Write/Glob/Grep 等），
 * 所有操作先向 Web UI 请求权限审批，批准后才真正执行。
 *
 * 环境变量：
 *   PERMISSION_SERVER_PORT    — Express 服务端口（默认 3000）
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
const { globSync } = require("fs").promises ? { globSync: null } : {};

const PORT = process.env.PERMISSION_SERVER_PORT || "3000";
const TIMEOUT_MS = 120_000;

// browserSessionId 和 character 的获取优先级：
// 1. 环境变量（Claude 每次通过临时 MCP config 传入）
// 2. 共享状态文件（Trae/Codex 全局注册，invoke 前写入）
const CONTEXT_FILE = path.join(require("os").tmpdir(), "mcp-perm-context.json");
function getContext() {
  // 环境变量优先
  if (process.env.PERMISSION_BROWSER_SESSION) {
    return {
      browserSessionId: process.env.PERMISSION_BROWSER_SESSION,
      character: process.env.PERMISSION_CHARACTER || "",
    };
  }
  // 回退到共享状态文件
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
  } catch {
    return { browserSessionId: "", character: "" };
  }
}

const log = (msg) => process.stderr.write(`[permission-server] ${msg}\n`);

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
        hostname: "127.0.0.1",
        port: parseInt(PORT, 10),
        path: "/api/permission-request",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
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
async function withPermission(toolName, input, executeFn) {
  log(`工具请求: ${toolName}`);

  try {
    const decision = await requestPermission(toolName, input);

    if (decision.behavior !== "allow") {
      log(`用户拒绝: ${toolName}`);
      return { content: [{ type: "text", text: `操作被用户拒绝: ${decision.message || "未授权"}` }], isError: true };
    }

    log(`用户允许: ${toolName}，开始执行`);
    const result = await executeFn();
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    log(`错误: ${toolName} — ${err.message}`);
    return { content: [{ type: "text", text: `执行错误: ${err.message}` }], isError: true };
  }
}

// ── 工具注册 ────────────────────────────────────────────────

// 1. Bash
server.tool(
  "Bash",
  "在系统 shell 中执行命令",
  {
    command: z.string().describe("要执行的 bash 命令"),
    description: z.string().optional().describe("命令的简短描述"),
    timeout: z.number().optional().describe("超时时间(ms)"),
  },
  async ({ command, description, timeout }) => {
    return withPermission("Bash", { command, description }, () => {
      try {
        const result = execSync(command, {
          encoding: "utf-8",
          timeout: timeout || 120_000,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return result || "(无输出)";
      } catch (err) {
        // execSync 失败时 err 包含 stdout/stderr
        const stdout = err.stdout || "";
        const stderr = err.stderr || "";
        const msg = stderr || stdout || err.message;
        return `命令执行失败 (exit ${err.status || "?"})\n${msg}`;
      }
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
    return withPermission("Edit", { file_path, old_string, new_string }, () => {
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
    return withPermission("Write", { file_path, content: content.slice(0, 500) + (content.length > 500 ? "..." : "") }, () => {
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
    return withPermission("Glob", { pattern, path: searchPath }, () => {
      // 使用 find 命令模拟 glob
      const dir = searchPath || process.cwd();
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
    return withPermission("Grep", { pattern, path: searchPath, glob: globFilter }, () => {
      const dir = searchPath || process.cwd();
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
server.tool(
  "WebSearch",
  "搜索网页",
  {
    query: z.string().describe("搜索关键词"),
  },
  async ({ query }) => {
    return withPermission("WebSearch", { query }, () => {
      // MCP 环境下无法直接调用搜索 API，返回提示
      return `WebSearch 工具在 MCP 代理模式下不可用。请建议用户直接搜索: "${query}"`;
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
    return withPermission("NotebookEdit", { notebook_path, cell_number, edit_mode }, () => {
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

// ── 启动 ──────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP 工具代理服务器已启动（9 个工具已注册）");
}

main().catch((err) => {
  log(`启动失败: ${err.message}`);
  process.exit(1);
});
