#!/usr/bin/env node

const { invoke } = require('../invoke.js');

async function testMemory() {
  console.log('=== 测试会话记忆功能 ===\n');
  
  const cli = process.argv[2] || 'trae';
  console.log(`使用 CLI: ${cli}\n`);
  
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
    process.exit(1);
  }
}

testMemory();
