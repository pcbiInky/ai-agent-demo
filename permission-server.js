/**
 * MCP 权限代理服务器（stdio 传输）
 *
 * 当 Claude CLI 需要执行工具（Bash/Edit/Write 等）时，通过 --permission-prompt-tool
 * 将权限请求委托到这个 MCP 服务器。服务器再通过 HTTP 转发给 Express 主服务，
 * Express 通过 SSE 推送给前端，用户在网页上审批后原路返回结果。
 *
 * 环境变量：
 *   PERMISSION_SERVER_PORT  — Express 服务端口（默认 3000）
 *   PERMISSION_BROWSER_SESSION — 浏览器会话 ID（用于关联 SSE 推送）
 *   PERMISSION_CHARACTER — 角色名（用于前端显示是哪个角色在请求权限）
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const http = require("http");

const PORT = process.env.PERMISSION_SERVER_PORT || "3000";
const BROWSER_SESSION = process.env.PERMISSION_BROWSER_SESSION || "";
const CHARACTER = process.env.PERMISSION_CHARACTER || "";
const TIMEOUT_MS = 120_000; // 等待用户响应的超时时间：120 秒

const server = new McpServer({
  name: "permission-prompt",
  version: "1.0.0",
});

/**
 * 通过 HTTP POST 将权限请求发送给 Express 服务器，
 * Express 会阻塞这个请求直到用户在前端做出选择（长轮询）
 */
function requestPermission(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

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
        // 超时比用户端稍长，确保用户端超时先触发
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

    req.on("error", (err) => {
      reject(new Error(`无法连接权限服务: ${err.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("权限请求超时"));
    });

    req.write(body);
    req.end();
  });
}

// 注册权限检查工具
server.tool(
  "check_permission",
  "处理 Claude Code 的工具权限请求，转发到 Web UI 供用户审批",
  {
    tool_name: z.string().describe("请求权限的工具名称"),
    tool_use_id: z.string().describe("工具调用唯一标识"),
    input: z.object({}).passthrough().describe("工具调用的参数"),
  },
  async ({ tool_name, tool_use_id, input }) => {
    const log = (msg) => process.stderr.write(`[permission-server] ${msg}\n`);

    log(`收到权限请求: ${tool_name} (${tool_use_id})`);

    try {
      const result = await requestPermission({
        toolName: tool_name,
        toolUseId: tool_use_id,
        input,
        browserSessionId: BROWSER_SESSION,
        character: CHARACTER,
        timestamp: Date.now(),
      });

      log(`用户决定: ${result.behavior} (${tool_name})`);

      // 返回给 Claude CLI 的标准格式
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: result.behavior,
              ...(result.message && { message: result.message }),
              ...(result.updatedInput && { updatedInput: result.updatedInput }),
            }),
          },
        ],
      };
    } catch (err) {
      log(`权限请求失败: ${err.message}`);

      // 出错时默认拒绝，保证安全
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: `权限服务错误: ${err.message}`,
            }),
          },
        ],
      };
    }
  }
);

// 启动 stdio 传输
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[permission-server] MCP 权限代理服务器已启动\n");
}

main().catch((err) => {
  process.stderr.write(`[permission-server] 启动失败: ${err.message}\n`);
  process.exit(1);
});
