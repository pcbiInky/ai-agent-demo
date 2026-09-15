/**
 * DeepSeek Harness (dsh) ACP 客户端
 *
 * dsh 的 ACP profile 是一个长期运行的 JSON-RPC over NDJSON 服务：
 *   dsh --profile acp
 * 协议细节与双向驱动统一在 lib/acp-client.js，本模块只声明 dsh 特有的启动参数。
 */

"use strict";

const {
  invokeAcp,
  resolveModelValue,
  selectAllowOption,
  PROTOCOL_VERSION,
} = require("./acp-client");

const DEFAULT_PROFILE = "acp";

/**
 * 启动 dsh ACP agent 并完成一轮对话。
 *
 * @param {object} params - 见 invokeAcp，额外支持 profile
 * @param {string} [params.command="dsh"] - dsh 可执行文件
 * @param {string} [params.profile="acp"] - dsh profile
 * @returns {Promise<{text: string, sessionId: string, resumed: boolean, stderr: string}>}
 */
function invokeDshAcp({ command = "dsh", profile = DEFAULT_PROFILE, ...rest } = {}) {
  return invokeAcp({
    ...rest,
    command,
    args: ["--profile", profile],
  });
}

module.exports = {
  invokeDshAcp,
  resolveModelValue,
  selectAllowOption,
  PROTOCOL_VERSION,
  DEFAULT_PROFILE,
};
