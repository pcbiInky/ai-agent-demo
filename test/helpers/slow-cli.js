#!/usr/bin/env node

// 模拟一个慢 CLI：根据参数控制行为
// 用法:
//   node slow-cli.js hang          — 完全静默，模拟进程挂起
//   node slow-cli.js slow          — 每 200ms 输出到 stderr，模拟 thinking
//   node slow-cli.js normal        — 立即输出结果并退出
//   node slow-cli.js ignore-term   — 忽略 SIGTERM，只响应 SIGKILL

const mode = process.argv[2] || "normal";

if (mode === "hang") {
  // 什么都不输出，挂住不退出
  setInterval(() => {}, 100_000);

} else if (mode === "slow") {
  // 持续往 stderr 写入（模拟 thinking），3 秒后输出结果
  const iv = setInterval(() => {
    process.stderr.write("thinking...\n");
  }, 200);
  setTimeout(() => {
    clearInterval(iv);
    process.stdout.write("done\n");
    process.exit(0);
  }, 3000);

} else if (mode === "ignore-term") {
  // 忽略 SIGTERM，只能被 SIGKILL 杀掉
  process.on("SIGTERM", () => {
    process.stderr.write("SIGTERM received but ignored\n");
  });
  setInterval(() => {}, 100_000);

} else {
  // normal: 立即输出并退出
  process.stdout.write("hello from fake cli\n");
  process.exit(0);
}
