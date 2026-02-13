const { spawn } = require("child_process");

const question = process.argv[2];
if (!question) {
  console.error('用法: node minimal-trae.js "你的问题"');
  process.exit(1);
}

const trae = spawn("trae-cli", ["-p", question], {
  stdio: ["ignore", "pipe", "pipe"], // stdin 设为 ignore，防止 CLI 等待输入而卡住
});

// trae-cli 直接输出纯文本，无需 JSON 解析，直接透传即可
trae.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

trae.stderr.on("data", (chunk) => {
  console.error(chunk.toString());
});

trae.on("close", (code) => {
  console.log(); // 换行
  if (code !== 0) {
    console.error(`trae-cli 进程退出，退出码: ${code}`);
  }
});
