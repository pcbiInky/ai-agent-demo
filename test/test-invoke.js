#!/usr/bin/env node

const { invoke } = require('../invoke.js');

async function main() {
  console.log('=== 测试 Claude CLI ===');
  try {
    const claudeResult = await invoke('claude', '你好，请用一句话介绍自己');
    console.log('Claude 回复:', claudeResult.text);
    console.log('Claude 会话 ID:', claudeResult.sessionId);
    
    // 使用相同的会话 ID 继续对话
    console.log('\n=== 继续 Claude 对话 ===');
    const claudeResult2 = await invoke('claude', '你能做什么？', claudeResult.sessionId);
    console.log('Claude 回复:', claudeResult2.text);
    console.log('Claude 会话 ID:', claudeResult2.sessionId);
  } catch (error) {
    console.error('Claude 错误:', error.message);
  }
  
  console.log('\n=== 测试 Trae CLI ===');
  try {
    const traeResult = await invoke('trae', '你好，请用一句话介绍自己');
    console.log('Trae 回复:', traeResult.text);
    console.log('Trae 会话 ID:', traeResult.sessionId);
    
    // 使用相同的会话 ID 继续对话
    console.log('\n=== 继续 Trae 对话 ===');
    const traeResult2 = await invoke('trae', '你能做什么？', traeResult.sessionId);
    console.log('Trae 回复:', traeResult2.text);
    console.log('Trae 会话 ID:', traeResult2.sessionId);
  } catch (error) {
    console.error('Trae 错误:', error.message);
  }
}

main();
