# 线程归属错配修复方案（新消息抢走历史回复）

日期：2026-10-10
作者：马哥（qodercn）
状态：已实施，待 YYF 复审
关联：`docs/plans/2026-10-10-message-file-diff-display.md`、`docs/plans/2026-10-10-cross-device-access-token.md`

## 1. 问题

YYF 复审指出：新一轮召唤的消息会把**上一轮线程的历史回复**算到自己头上——界面上一条刚发出的回复挂着「13 条回复」计数条，点开线程面板看到的是别人的历史往返，而真正属于它的 0 条回复被淹没。

真实日志（`chat-logs/fb265fa6-9fae-4752-bc82-a6bd33c627d8.json`，904 条消息）复现：

| 事实 | 数据 |
| --- | --- |
| 旧线程 `c55b017d…` | 55 条消息同挂该 `threadId`，其中 `depth>0` 的回复 14 条，`id === threadId` 的自身根 1 条 |
| 新消息 `f3d0d4d8…` | `depth` 为空、带 `aiMentions: ["YYF"]`，但 `threadId` 仍是 `c55b017d…`；它的 `replyTo` 指向 `945eab47…`，而那条消息**没有** `threadId` |
| 末尾记录 `3f17167d…` | `depth: 1`、`text` 为空、只有 `error: "协议违规：本轮未通过 mcp__permission__SendMessage 发送消息"` |

两处独立缺陷叠加成用户看到的现象：

1. **服务端信任客户端传入的 `threadId`**。`/api/mcp-send-message` 里 `contextThreadId = threadId || chainContext?.threadId || null`，`threadId` 来自请求体（permission-server 沿用上一轮的线程上下文）。于是新一轮召唤被记成旧线程的成员；又因为它带 `aiMentions` 且无 `depth`，`effectiveThreadId` 逻辑不会给它开新线程。
2. **前端历史重建用"最后一条 depth=0 且带 mentions 的消息"覆盖 `originId`**。`loadHistory` 遍历日志时对同 `threadId` 反复 `state.threads[threadId] = { originId: msg.id, … }`，且不清空 `replies`——旧线程的 14 条 `depth>0` 回复全部挂到最后那条新消息上，计数条与面板随之错配。

附带缺陷：`3f17167d…` 这类**空文本**记录（协议违规、执行中断产生的 error 条目）也被计入回复数，于是出现「13 条回复」与「14 条回复」两种口径不一致。

## 2. 修复

### 2.1 服务端：用 `replyTo`/消息 ID 证实父子关系（server.js:1447-1465, 1804-1810）

```js
function readLogMessages(sessionId) { /* 读 chat-logs/<session>.json 的 messages，失败返回 [] */ }

// 客户端传来的 threadId 可能是上一轮遗留的旧线程：只有能用 replyTo 证实父子关系才沿用，
// 否则新一轮召唤以自身 id 开线程，避免历史回复被算到最新一条消息头上
function isThreadContinuation(messages, threadId, replyToMessageId) {
  if (!threadId || !replyToMessageId) return false;
  if (threadId === replyToMessageId) return messages.some((m) => m.id === threadId);
  const parent = messages.find((m) => m.id === replyToMessageId);
  return Boolean(parent && parent.threadId === threadId);
}
```

`/api/mcp-send-message` 中：

```js
const providedThreadId = typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
const contextThreadId = chainContext?.threadId
  || (providedThreadId && isThreadContinuation(readLogMessages(browserSessionId), providedThreadId, replyToMessageId)
    ? providedThreadId
    : null);
```

规则：
- 服务端链上下文（`chainContext`，即 depth 0→1→2 的同轮召唤链）优先，行为不变。
- 客户端传入的 `threadId` 只在两种情况被采信：`replyTo` 就是线程根本身（且该 id 确实在日志里），或 `replyTo` 指向的消息确实属于该线程。
- 否则 `contextThreadId = null`，走既有 `effectiveThreadId` 逻辑：有 `aiMentions` 时以**自身 messageId** 开新线程，无 mentions 时不进线程。
- `replyToMessageId` 取自审批记录（`storeApproval` 时保存的父消息），不采信请求体里的自报字段。

### 2.2 前端：线程根不可被覆盖 + 空文本不计回复（public/app.js:652-664, 684, 2224-2254）

历史重建第一遍：

```js
for (const msg of log.messages) {
  if (!msg.threadId || msg.depth > 0) continue;
  const isSelfRoot = msg.id === msg.threadId;
  const hasMentions = Array.isArray(msg.aiMentions) && msg.aiMentions.length > 0;
  if (!isSelfRoot && !hasMentions) continue;
  const existing = state.threads[msg.threadId];
  if (existing && (existing.rootConfirmed || !isSelfRoot)) continue;
  state.threads[msg.threadId] = { originId: msg.id, originChar: msg.character, originText: msg.text, replies: existing ? existing.replies : [], rootConfirmed: isSelfRoot };
}
```

- 线程根以 `id === threadId` 为准（服务端就是以自身 id 开线程），标记 `rootConfirmed`，此后同 `threadId` 的任何消息都不得改写 `originId`。
- 兼容旧日志：若某线程没有自身根记录，退化为"该线程第一条带 mentions 的消息"，一旦被自身根证实就升级为确定根。
- 已存在的 `replies` 数组保留，不因重建根而丢失或翻倍。

第二遍收集回复时跳过空文本：`if (!String(msg.text || "").trim()) continue;`。

实时链路口径对齐：
- `appendMessage` 初始化线程时 `rootConfirmed: tid === msgId`（app.js:661），且不覆盖 `loadHistory` 已建好的结构。
- `appendThreadReply` 改为 `if (threadId && state.threads[threadId] && String(text || "").trim())`（app.js:684）——空文本的 SSE 回复同样不进计数与面板。

### 2.3 实时与刷新一致性

新消息在实时链路上以自身 id 开线程、计数从 0 开始；刷新后走 `loadHistory` 重建，`id === threadId` 命中自身根，`originId` 与计数条位置与实时一致。旧线程的历史回复始终留在旧线程根上。

## 3. 回归（test/test-thread-attribution.js，27 项）

1. `isThreadContinuation` 单元判定 5 项：回复线程根 → 沿用；回复线程内子消息 → 沿用；回复线程外的新用户消息 → 不沿用；无 `replyTo` → 不沿用；`threadId` 在日志中不存在 → 不沿用。
2. 路由级「新一轮召唤传旧 threadId」6 项：请求成功、新消息落盘、`threadId === 自身 id`、不等于旧线程 id、无 `depth` 字段、`aiMentions` 仍能召唤，且旧线程消息数仍为 2。
3. 路由级「回复线程内消息」2 项：`replyTo` 能证实父子关系时沿用原线程。
4. jsdom 历史重建（夹具：`thread-root` + 13 条 `old-reply` + 用户消息 `u1` + 复用旧 `threadId` 的 `new-msg` + 一条空文本 error 记录）：线程根渲染出来、计数条留在 `thread-root` 且为「13 条回复」、`new-msg` 与 `u1` 不挂计数条、面板含「此前往返 1…13」、面板不含 `new-msg` 的文本、不出现「14 条回复」。
5. 实时链路：新召唤只计自己的 1 条回复、不继承历史 13 条、历史线程计数不受影响、空文本回复不计入。

全量：test-thread-attribution 27、test-access-gate 57、test-sse-resume 13、test-file-diff-display 90、test-tool-result 38、test-tool-result-reporter 30、test-chain-caller 10、test-concurrent-parent-routing 12、test-invoke-queue-recycle 13、test-permission-context 51、test-permission-history 20、test-thinking-restore 56、test-tool-records-fold 26、test-metric-bar-label 9、test-send-message 10、test-safe-command 83、test-sessions 24、skill-* 8/11/9、test-robustness 7 全过。既有失败与本次无关：test-cli-invocation 9 项（win32 平台分支）、test-memory 1 项（依赖真实 CLI），在 `9e54087` 上同样失败。

## 4. 已知限制

1. `readLogMessages` 每次 SendMessage 读一次日志文件（O(文件大小)）。当前日志约 900 条消息、单文件 MB 级，开销可接受；若日志继续增长应改为内存索引。
2. 判定依赖 `replyTo` 与已落盘的 `threadId`。日志被截断/损坏（`readLogMessages` 返回 `[]`）时会保守地开新线程，即"宁可少合并，不可错合并"。
3. 旧日志中已错配的记录不会被回改：本方案只保证此后新增消息归属正确，以及前端重建时计数条挂在正确的根上；历史文件里 `f3d0d4d8…` 那条的 `threadId` 仍是旧值，前端按"非自身根 + 已有确定根"规则忽略它对 `originId` 的影响。
4. 空文本回复的判定是 `text.trim()` 为空。若将来出现"只有附件/只有 diff 没有正文"的合法回复，需要放宽这条规则。
5. `depth>0` 但 `threadId` 指向已不存在线程的记录会被丢弃（原行为一致），不做孤儿回复兜底展示。
