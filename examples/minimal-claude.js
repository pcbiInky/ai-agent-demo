const { spawn } = require("child_process");
const { createInterface } = require("readline");

const question = process.argv[2];
if (!question) {
  console.error("用法: node minimal-claude.js \"你的问题\"");
  process.exit(1);
}

const claude = spawn("claude", [
  "-p",
  question,
  "--output-format",
  "stream-json",
  "--verbose",
], {
  stdio: ["ignore", "pipe", "pipe"],  // 关键：stdin 设为 ignore，防止 CLI 等待输入而卡住
});

const rl = createInterface({ input: claude.stdout });

rl.on("line", (line) => {
  if (!line.trim()) return;

  try {
    const event = JSON.parse(line);

    if (event.type === "assistant") {
      const content = event.message?.content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        }
      }
    }
  } catch {
    // 忽略非 JSON 行
  }
});

claude.stderr.on("data", (chunk) => {
  console.error(chunk.toString());
});

claude.on("close", (code) => {
  console.log(); // 换行
  if (code !== 0) {
    console.error(`Claude 进程退出，退出码: ${code}`);
  }
});
