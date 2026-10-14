#!/usr/bin/env node

/**
 * DeepSeek WebSearch 真实 API 冒烟脚本（默认不发起付费调用）
 *
 * 不带 --live 时只打印用法并退出；显式 --live 才调用真实 API。
 * 输出只含 provider / 状态 / 耗时 / 来源数 / usage 与来源标题列表，
 * 不输出密钥、thinking 或完整原始响应。
 *
 * 用法：
 *   node scripts/deepseek-web-search-smoke.js                # 打印用法并退出
 *   DEEPSEEK_API_KEY=sk-... \
 *     node scripts/deepseek-web-search-smoke.js --live \
 *     --query "Model Context Protocol latest specification site:modelcontextprotocol.io"
 *
 *   # 或复用 dsh 已保存的凭据：
 *   DEEPSEEK_SEARCH_CREDENTIALS_FILE=/Users/inky/.dsh/.credentials.yaml \
 *     node scripts/deepseek-web-search-smoke.js --live --query "你的查询"
 */

const { searchDeepSeekWeb } = require("../lib/deepseek-web-search");

const USAGE = `用法:
  node scripts/deepseek-web-search-smoke.js --live --query "<搜索词>"

选项:
  --live          显式启用真实 API 调用（默认只打印本说明并退出）
  --query <词>    搜索查询（必填，trim 后非空且不超过 4096 字符）

凭据（二选一，由主服务同款规则解析）:
  DEEPSEEK_API_KEY                    直接提供 API Key
  DEEPSEEK_SEARCH_CREDENTIALS_FILE    dsh 格式 YAML（refs.DEEPSEEK_API_KEY）

可选配置: DEEPSEEK_SEARCH_BASE_URL / DEEPSEEK_SEARCH_MODEL /
          DEEPSEEK_SEARCH_TIMEOUT_MS / DEEPSEEK_SEARCH_MAX_RESULTS
`;

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const queryIndex = args.indexOf("--query");
  const query = queryIndex >= 0 ? args[queryIndex + 1] : "";

  if (!live) {
    process.stdout.write(USAGE);
    return;
  }
  if (!query || !query.trim()) {
    console.error("错误: --live 必须搭配 --query");
    process.stdout.write(USAGE);
    process.exit(1);
  }

  try {
    const result = await searchDeepSeekWeb(query);
    console.log(`provider: ${result.provider}`);
    console.log(`query: ${result.query}`);
    console.log(`model: ${result.model}`);
    console.log(`elapsedMs: ${result.elapsedMs}`);
    console.log(`sources: ${result.sources.length} (truncated=${result.truncated})`);
    console.log(`usage: ${JSON.stringify(result.usage || {})}`);
    for (const [index, source] of result.sources.entries()) {
      console.log(`  [${index + 1}] ${source.title} — ${source.url}${source.publishedAt ? ` (${source.publishedAt})` : ""}`);
    }
  } catch (err) {
    console.error(`失败: [${err.code || "UNKNOWN"}] ${err.message}`);
    process.exit(1);
  }
}

main();
