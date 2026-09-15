/**
 * Kimi Code CLI ACP 客户端
 *
 * Kimi Code CLI 通过 `kimi acp` 暴露 ACP over NDJSON 服务：
 *   kimi acp
 * 协议与 dsh 完全一致（initialize / session/new | session/resume /
 * session/set_config_option / session/prompt / session/close），
 * 因此复用 lib/acp-client.js，本模块只声明 kimi 特有的启动参数。
 *
 * 注意：kimi 不一定在 PATH 里（默认安装在 ~/.kimi-code/bin/kimi），
 * 调用方可通过 KIMI_CLI_COMMAND 或 command 参数指定绝对路径。
 */

"use strict";

const {
  invokeAcp,
  resolveModelValue,
  selectAllowOption,
  PROTOCOL_VERSION,
} = require("./acp-client");

const ACP_ARGS = ["acp"];

/**
 * 启动 kimi ACP agent 并完成一轮对话。
 *
 * @param {object} params - 见 invokeAcp
 * @param {string} [params.command="kimi"] - kimi 可执行文件
 * @param {string[]} [params.args=["acp"]] - kimi 启动参数
 * @returns {Promise<{text: string, sessionId: string, resumed: boolean, stderr: string}>}
 */
function invokeKimiAcp({ command = "kimi", args = ACP_ARGS, ...rest } = {}) {
  return invokeAcp({
    ...rest,
    command,
    args,
  });
}

module.exports = {
  invokeKimiAcp,
  resolveModelValue,
  selectAllowOption,
  PROTOCOL_VERSION,
  ACP_ARGS,
};
