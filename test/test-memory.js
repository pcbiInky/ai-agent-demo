#!/usr/bin/env node

const { invoke } = require('../invoke.js');

async function testMemory(cli) {
  console.log(`\n=== 测试 ${cli} CLI 会话记忆功能 ===\n`);
  
  try {
    // 第一轮对话：告诉 AI 一个数字
    console.log('第一轮对话：告诉 AI 一个数字');
    console.log('问题: 请记住这个数字：42');
    const result1 = await invoke(cli, '请记住这个数字：42');
    console.log('回复:', result1.text);
    console.log('会话 ID:', result1.sessionId);
    console.log('');
    
    // 第二轮对话：询问 AI 刚才的数字
    console.log('第二轮对话：询问 AI 刚才的数字');
    console.log('问题: 我刚才告诉你的数字是多少？');
    const result2 = await invoke(cli, '我刚才告诉你的数字是多少？', result1.sessionId);
    console.log('回复:', result2.text);
    console.log('会话 ID:', result2.sessionId);
    console.log('');
    
    // 检查是否记住了数字 42
    if (result2.text.includes('42')) {
      console.log('✅ 测试通过！AI 记住了数字 42');
    } else {
      console.log('❌ 测试失败！AI 没有记住数字 42');
    }
    
  } catch (error) {
    console.error('错误:', error.message);
    return false;
  }
  
  return true;
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     会话记忆测试（遍历所有 CLI）        ║');
  console.log('╚══════════════════════════════════════╝');

  const clis = ['claude', 'trae'];
  let passed = 0;
  let failed = 0;

  for (const cli of clis) {
    const success = await testMemory(cli);
    if (success) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n════════════════════════════════════════');
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log('══════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
