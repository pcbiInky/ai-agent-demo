// ── 状态 ──────────────────────────────────────────────────
const state = {
  sessionId: null,
  characters: {},
  profiles: {},
  eventSource: null,
  // 右侧栏统计
  stats: { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 },
  // 角色状态: "online" | "thinking"
  charStatus: {},
  // thinking 中的 messageId -> Set<character>
  thinkingMap: {},
  unreadCount: 0,
  isLoadingHistory: false,
  isComposing: false,
  lastSpeaker: null,
  // Thread 相关
  threads: {},          // threadId -> { originId, originChar, originText, replies: [{ id, character, text, verified, depth }] }
  activeThreadId: null,  // 当前打开的 thread
  // 消息 ID -> DOM 元素映射（用于定位和引用）
  messageElements: {},
};

const PROFILE_STORAGE_KEY = "characterProfilesV2";
const BOTTOM_THRESHOLD_PX = 40;

// ── DOM 元素 ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $messages = $("#messages");
const $input = $("#message-input");
const $sendBtn = $("#send-btn");
const $chatContainer = $("#chat-container");
const $jumpToLatestBtn = $("#jump-to-latest-btn");
const $sessionDisplay = $("#session-id-display");
const $newSessionBtn = $("#new-session-btn");
const $sessionList = $("#session-list");
const $mentionHints = $("#mention-hints");
const $charStatuses = $("#character-statuses");
const $chatSubtitle = $("#chat-subtitle");
const $settingsBtn = $("#settings-btn");
const $settingsModal = $("#settings-modal");
const $settingsForm = $("#settings-form");
const $settingsError = $("#settings-error");
const $settingsSaveBtn = $("#settings-save-btn");
const $settingsCancelBtn = $("#settings-cancel-btn");
const $threadPanel = $("#thread-panel");
const $threadMessages = $("#thread-messages");
const $threadCloseBtn = $("#thread-close-btn");

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  const res = await fetch("/api/characters");
  const data = await res.json();
  state.characters = data.characters;
  initProfiles();

  // 初始化角色状态
  for (const name of Object.keys(state.characters)) {
    state.charStatus[name] = "online";
  }
  renderStaticCharacterTexts();
  renderCharStatuses();

  // Session
  state.sessionId = sessionStorage.getItem("sessionId");
  if (!state.sessionId) {
    state.sessionId = crypto.randomUUID();
    sessionStorage.setItem("sessionId", state.sessionId);
  }
  $sessionDisplay.textContent = state.sessionId.slice(0, 8) + "...";

  await loadHistory();
  await loadSessionList();
  connectSSE();
  setupInput();
  setupMentionHints();
  setupChatScroll();
  setupSettings();
  setupThreadPanel();

  $newSessionBtn.addEventListener("click", newSession);
}

// ── SSE ───────────────────────────────────────────────────
function connectSSE() {
  if (state.eventSource) state.eventSource.close();

  const es = new EventSource(`/api/events?sessionId=${state.sessionId}`);
  state.eventSource = es;

  es.addEventListener("thinking", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, "thinking");
    showThinking(data.character, data.messageId);
  });

  es.addEventListener("reply", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, "online");
    finalizeThinking(data.character, data.messageId, "done");

    if (data.threadId && data.depth > 0) {
      // Thread 回复：带引用条显示在主流 + 更新 thread 数据
      appendThreadReply(data);
    } else {
      appendAssistantMessage(data.character, data.text, data.verified, data.replyId, data.threadId, data.aiMentions);
    }

    state.lastSpeaker = data.character;
    updateStats(data.character, data.verified);
    loadSessionList();
  });

  es.addEventListener("error", (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      setCharStatus(data.character, "online");
      finalizeThinking(data.character, data.messageId, "error");
      appendErrorMessage(data.character, data.error);
    }
  });

  es.addEventListener("ai-mention", (e) => {
    const data = JSON.parse(e.data);
    appendAIMentionNotice(data.from, data.to, data.threadId);
  });

  es.addEventListener("system-notice", (e) => {
    const data = JSON.parse(e.data);
    appendSystemNotice(data.text);
  });

  es.addEventListener("status", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, data.status);
  });

  // ── 权限请求事件 ──
  es.addEventListener("permission", (e) => {
    const data = JSON.parse(e.data);
    showPermissionCard(data);
  });

  es.addEventListener("permission-resolved", (e) => {
    const data = JSON.parse(e.data);
    resolvePermissionCard(data.requestId, data.behavior, data.message);
  });
}

// ── 发送消息 ──────────────────────────────────────────────
function hasMention(text) {
  // "@所有人" 视为有效 mention
  if (text.includes("@所有人")) return true;
  const names = Object.keys(state.characters);
  for (const name of names) {
    const display = getDisplayName(name);
    if (text.includes("@" + name) || text.includes("@" + display)) return true;
  }
  return false;
}

async function sendMessage() {
  let rawText = $input.value.trim();
  if (!rawText) return;

  // 没有 @mention 时自动 @上一个说话的对象
  if (!hasMention(rawText) && state.lastSpeaker) {
    const displayName = getDisplayName(state.lastSpeaker);
    rawText = "@" + displayName + " " + rawText;
  }

  // "@所有人" 展开为所有角色的 @mention
  if (rawText.includes("@所有人")) {
    const allMentions = Object.keys(state.characters).map(name => "@" + getDisplayName(name)).join(" ");
    rawText = rawText.replace(/@所有人/g, allMentions);
  }

  const text = normalizeMentions(rawText);

  $input.value = "";
  autoResize($input);
  $mentionHints.classList.add("hidden");

  appendUserMessage(rawText);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          text,
          sessionId: state.sessionId,
          nicknames: Object.fromEntries(
            Object.keys(state.characters)
              .filter(c => getDisplayName(c) !== c)
              .map(c => [c, getDisplayName(c)])
          ),
          models: Object.fromEntries(
            Object.keys(state.characters)
              .filter(c => state.profiles[c]?.model)
              .map(c => [c, state.profiles[c].model])
          ),
        }),
    });

    if (!res.ok) {
      const err = await res.json();
      appendErrorMessage("系统", err.error);
    }
  } catch {
    appendErrorMessage("系统", "网络错误，无法发送消息");
  }
}

// ── 消息渲染 ──────────────────────────────────────────────
function appendUserMessage(text) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const time = formatTimeShort(Date.now());
  const div = document.createElement("div");
  div.className = "message user";
  div.innerHTML = `
    <div class="avatar user-avatar">铲</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name user-name">铲屎官</span>
          <span class="msg-time">${time}</span>
      </div>
      <div class="bubble">${escapeHtml(displayMentions(text))}</div>
    </div>
  `;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll, force: true });
  state.stats.total++;
  renderStats();
}

function appendAssistantMessage(character, text, verified, replyId, threadId, aiMentions) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(Date.now());
  const cli = state.characters[character]?.cli || "";
  const model = state.profiles[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;
  const msgId = replyId || crypto.randomUUID();

  let verifiedHtml = "";
  if (verified === true) verifiedHtml = '<span class="verified-badge pass">verified</span>';
  else if (verified === false) verifiedHtml = '<span class="verified-badge fail">unverified</span>';

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.dataset.msgId = msgId;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        <span class="msg-time">${time}</span>
        ${verifiedHtml}
      </div>
      <div class="bubble markdown-body">${renderMarkdown(displayMentions(text))}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  $messages.appendChild(div);

  // 追踪消息元素
  state.messageElements[msgId] = div;

  // 如果这条消息中有 AI @mention，初始化 thread 数据（避免覆盖 loadHistory 已建好的）
  if (aiMentions && aiMentions.length > 0) {
    const tid = threadId || msgId;
    if (!state.threads[tid]) {
      state.threads[tid] = {
        originId: msgId,
        originChar: character,
        originText: text,
        replies: [],
      };
    }
  }

  handlePostAppend({ shouldAutoScroll });
}

// ── Thread 回复渲染（主聊天流中，带引用条） ──────────────
function appendThreadReply(data) {
  const { character, text, verified, replyId, threadId, depth } = data;
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(Date.now());
  const cli = state.characters[character]?.cli || "";
  const model = state.profiles[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;
  const msgId = replyId || crypto.randomUUID();

  // 更新 thread 数据（避免 loadHistory 时重复 push）
  if (threadId && state.threads[threadId]) {
    const existing = state.threads[threadId].replies.find(r => r.id === msgId);
    if (!existing) {
      state.threads[threadId].replies.push({
        id: msgId, character, text, verified, depth,
      });
    }
    if (!state.isLoadingHistory) {
      updateThreadReplyBar(threadId);
      updateThreadPanelIfOpen(threadId);
    }
  }

  let verifiedHtml = "";
  if (verified === true) verifiedHtml = '<span class="verified-badge pass">verified</span>';
  else if (verified === false) verifiedHtml = '<span class="verified-badge fail">unverified</span>';

  // 引用条：显示原始消息的第一行
  let quoteHtml = "";
  if (threadId && state.threads[threadId]) {
    const origin = state.threads[threadId];
    const firstLine = (origin.originText || "").split("\n")[0].slice(0, 60);
    const originDisplayName = getDisplayName(origin.originChar);
    quoteHtml = `
      <div class="thread-quote" data-thread-id="${threadId}" onclick="openThread('${threadId}')">
        <span class="quote-char">${escapeHtml(originDisplayName)}:</span>
        <span class="quote-text">${escapeHtml(displayMentions(firstLine))}</span>
      </div>
    `;
  }

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.dataset.msgId = msgId;
  div.dataset.threadId = threadId || "";
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        <span class="msg-time">${time}</span>
        ${verifiedHtml}
      </div>
      <div class="bubble markdown-body">${quoteHtml}${renderMarkdown(displayMentions(text))}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  $messages.appendChild(div);
  state.messageElements[msgId] = div;

  handlePostAppend({ shouldAutoScroll });
}

// ── AI 互@ 系统提示 ──────────────────────────────────────
function appendAIMentionNotice(from, to, threadId) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const fromName = getDisplayName(from);
  const toName = getDisplayName(to);

  const div = document.createElement("div");
  div.className = "ai-mention-notice";
  div.innerHTML = `<span class="mention-icon">🔗</span> ${escapeHtml(fromName)} 召唤了 ${escapeHtml(toName)}`;
  if (threadId) div.dataset.threadId = threadId;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
}

function appendSystemNotice(text) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const div = document.createElement("div");
  div.className = "system-notice";
  div.textContent = text;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
}

// ── Thread 回复计数条 ────────────────────────────────────
function updateThreadReplyBar(threadId) {
  const thread = state.threads[threadId];
  if (!thread) return;

  const originEl = state.messageElements[thread.originId];
  if (!originEl) return;

  // 找到或创建回复计数条（放在 bubble-wrapper 内部底部）
  let bar = originEl.querySelector(".thread-reply-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "thread-reply-bar";
    bar.onclick = () => openThread(threadId);
    const wrapper = originEl.querySelector(".bubble-wrapper") || originEl;
    wrapper.appendChild(bar);
  }

  const replyCount = thread.replies.length;
  const participants = [...new Set(thread.replies.map(r => r.character))];
  const avatarsHtml = participants.slice(0, 3).map(c => {
    const charClass = getCharClass(c);
    const av = getAvatar(c);
    return `<span class="thread-mini-avatar" style="background:var(--${charClass}-accent)">${escapeHtml(av)}</span>`;
  }).join("");

  bar.innerHTML = `
    <span class="thread-avatars">${avatarsHtml}</span>
    <span>💬 ${replyCount} 条回复${participants.length > 0 ? "  " + participants.map(c => getDisplayName(c)).join("·") : ""}</span>
    <svg class="thread-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  `;
}

// ── Thread 面板 ──────────────────────────────────────────
function setupThreadPanel() {
  $threadCloseBtn.addEventListener("click", closeThread);
}

let _closeThreadTimer = null;

function openThread(threadId) {
  const thread = state.threads[threadId];
  if (!thread) return;

  // 取消可能残留的关闭定时器，防止竞态
  if (_closeThreadTimer) {
    clearTimeout(_closeThreadTimer);
    _closeThreadTimer = null;
  }

  state.activeThreadId = threadId;
  renderThreadPanel(threadId);

  $threadPanel.classList.add("open");
  // 用 rAF 来触发 CSS transition
  requestAnimationFrame(() => {
    $threadPanel.classList.add("visible");
  });
}

function closeThread() {
  state.activeThreadId = null;
  $threadPanel.classList.remove("visible");
  // 等动画结束再隐藏
  _closeThreadTimer = setTimeout(() => {
    $threadPanel.classList.remove("open");
    _closeThreadTimer = null;
  }, 250);
}

function renderThreadPanel(threadId) {
  const thread = state.threads[threadId];
  if (!thread) return;

  $threadMessages.innerHTML = "";

  // 1. 原始消息
  const originEl = buildThreadMessage(thread.originChar, thread.originText, false);
  $threadMessages.appendChild(originEl);

  // 分隔线
  const divider = document.createElement("div");
  divider.className = "thread-origin-divider";
  divider.textContent = `${thread.replies.length} 条回复`;
  $threadMessages.appendChild(divider);

  // 2. 所有回复
  for (const reply of thread.replies) {
    const replyEl = buildThreadMessage(reply.character, reply.text, true, reply.verified);
    $threadMessages.appendChild(replyEl);
  }

  $threadMessages.scrollTop = $threadMessages.scrollHeight;
}

function buildThreadMessage(character, text, isReply, verified) {
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const cli = state.characters[character]?.cli || "";
  const model = state.profiles[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;

  let verifiedHtml = "";
  if (verified === true) verifiedHtml = '<span class="verified-badge pass">verified</span>';
  else if (verified === false) verifiedHtml = '<span class="verified-badge fail">unverified</span>';

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        ${verifiedHtml}
      </div>
      <div class="bubble markdown-body">${renderMarkdown(displayMentions(text))}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  return div;
}

function updateThreadPanelIfOpen(threadId) {
  if (state.activeThreadId === threadId) {
    renderThreadPanel(threadId);
  }
}

function appendErrorMessage(character, error) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character, "!");
  const displayName = getDisplayName(character);

  const div = document.createElement("div");
  div.className = `message assistant error-msg ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}" style="background:var(--error-text)">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name">${escapeHtml(displayName)}</span>
        <span class="msg-time">${formatTimeShort(Date.now())}</span>
      </div>
      <div class="bubble">${escapeHtml(error)}</div>
    </div>
  `;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
}

// ── Thinking ──────────────────────────────────────────────
function showThinking(character, messageId) {
  const existing = document.getElementById(`thinking-${character}-${messageId}`);
  if (existing) return;

  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.id = `thinking-${character}-${messageId}`;
  div.dataset.character = character;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
        <div class="msg-header">
          <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
          <span class="msg-time">处理中...</span>
        </div>
        <div class="thinking-scroll-area">
          <div class="process-log"></div>
          <div class="perm-container"></div>
        </div>
      </div>
  `;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
}

function finalizeThinking(character, messageId, status = "done") {
  const el = document.getElementById(`thinking-${character}-${messageId}`);
  if (!el) return;
  const hasPerm = !!el.querySelector(".perm-card");
  const hasStep = !!el.querySelector(".process-step");
  if (!hasPerm && !hasStep) {
    el.remove();
    return;
  }

  el.classList.add("thinking-finished");
  el.dataset.archived = "true";
  el.id = `thinking-archive-${character}-${messageId}-${Date.now()}`;

  const timeEl = el.querySelector(".msg-time");
  if (timeEl) timeEl.textContent = status === "error" ? "执行中断" : "过程记录";

  const buttons = el.querySelectorAll(".perm-summary-actions .perm-btn");
  for (const btn of buttons) btn.disabled = true;
}

// ── 权限审批卡片（紧凑模式） ────────────────────────────
function getPermBrief(toolName, input) {
  if (toolName === "Bash" && input?.command) return input.command;
  if (toolName === "Read" && input?.file_path) return input.file_path;
  if (toolName === "Edit" && input?.file_path) return input.file_path;
  if (toolName === "Write" && input?.file_path) return input.file_path;
  if (toolName === "Glob" && input?.pattern) return input.pattern;
  if (toolName === "Grep" && input?.pattern) return input.pattern;
  if (toolName === "WebFetch" && input?.url) return input.url;
  if (toolName === "WebSearch" && input?.query) return input.query;
  return JSON.stringify(input || {}).slice(0, 80);
}

function getPermIntent(toolName, input) {
  // 从 description 字段提取 AI 的意图说明
  if (input?.description) return input.description;
  // 生成默认意图描述
  if (toolName === "Bash") return "执行系统命令";
  if (toolName === "Read") return "读取文件内容";
  if (toolName === "Edit") return "修改文件内容";
  if (toolName === "Write") return "创建/覆盖文件";
  if (toolName === "Glob") return "搜索匹配文件";
  if (toolName === "Grep") return "在文件中搜索内容";
  if (toolName === "WebFetch") return "获取网页内容";
  if (toolName === "WebSearch") return "搜索网页";
  return "执行工具操作";
}

function buildPermDetail(toolName, input) {
  let detail = "";
  if (toolName === "Bash" && input?.command) {
    detail = `<div class="perm-detail-label">命令</div><pre class="perm-code">${escapeHtml(input.command)}</pre>`;
    if (input.description) {
      detail += `<div class="perm-detail-label">说明</div><div class="perm-desc">${escapeHtml(input.description)}</div>`;
    }
  } else if ((toolName === "Edit" || toolName === "Write") && input?.file_path) {
    detail = `<div class="perm-detail-label">文件</div><div class="perm-desc mono">${escapeHtml(input.file_path)}</div>`;
    if (input.old_string) {
      detail += `<div class="perm-detail-label">替换</div><pre class="perm-code">${escapeHtml(truncate(input.old_string, 200))} → ${escapeHtml(truncate(input.new_string || "", 200))}</pre>`;
    } else if (input.content) {
      detail += `<div class="perm-detail-label">内容预览</div><pre class="perm-code">${escapeHtml(truncate(input.content, 300))}</pre>`;
    }
  } else if (toolName === "Read" && input?.file_path) {
    detail = `<div class="perm-detail-label">文件</div><div class="perm-desc mono">${escapeHtml(input.file_path)}</div>`;
  } else {
    const inputStr = JSON.stringify(input, null, 2);
    detail = `<div class="perm-detail-label">参数</div><pre class="perm-code">${escapeHtml(truncate(inputStr, 400))}</pre>`;
  }
  return detail;
}

function showPermissionCard({ requestId, character, toolName, input, timestamp, messageId }) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const brief = getPermBrief(toolName, input);
  const intent = getPermIntent(toolName, input);
  const detail = buildPermDetail(toolName, input);

  // 用 character + messageId 精确定位 thinking 容器
  const thinkingEl = findThinkingElement(character, messageId);
  const container = thinkingEl?.querySelector(".perm-container");

  const cardHtml = `
    <div class="perm-card" id="perm-card-${requestId}" data-request-id="${requestId}">
      <div class="perm-summary" onclick="togglePermDetail('${requestId}')">
        <svg class="perm-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01M5.07 19h13.86c1.14 0 1.83-1.23 1.23-2.2L13.23 4.6a1.39 1.39 0 0 0-2.46 0L3.84 16.8c-.6.97.09 2.2 1.23 2.2z"/></svg>
        <span class="perm-summary-tool">${escapeHtml(toolName)}</span>
        <span class="perm-summary-brief">${escapeHtml(truncate(brief, 60))}</span>
        <svg class="perm-expand-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        <div class="perm-summary-actions" id="perm-actions-${requestId}">
          <button class="perm-btn perm-deny" onclick="event.stopPropagation(); respondPermission('${requestId}', 'deny')">拒绝</button>
          <button class="perm-btn perm-allow" onclick="event.stopPropagation(); respondPermission('${requestId}', 'allow')">允许</button>
        </div>
      </div>
      <div class="perm-detail">
        <div class="perm-intent">${escapeHtml(intent)}</div>
        ${detail}
      </div>
    </div>
  `;

  if (container) {
    const processLog = thinkingEl.querySelector(".process-log");
    if (processLog) {
      const step = document.createElement("div");
      step.className = "process-step";
      step.textContent = input?.description || `准备调用 ${toolName}：${truncate(brief, 80)}`;
      processLog.appendChild(step);
    }

    // 嵌入 thinking 消息内部
    container.insertAdjacentHTML("beforeend", cardHtml);
    // 滚动 thinking 区域到底部，确保新卡片可见
    const scrollArea = thinkingEl.querySelector(".thinking-scroll-area");
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  } else {
    // 降级：如果找不到 thinking 元素（极端边界情况），独立显示
    const charClass = getCharClass(character);
    const avatar = getAvatar(character);
    const displayName = getDisplayName(character);
    const time = formatTimeShort(timestamp || Date.now());
    const div = document.createElement("div");
    div.className = `message assistant ${charClass}`;
    div.id = `perm-fallback-${requestId}`;
    div.innerHTML = `
      <div class="avatar ${charClass}">${avatar}</div>
      <div class="bubble-wrapper">
        <div class="msg-header">
          <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
          <span class="msg-time">${time}</span>
          <span class="perm-badge">需要权限</span>
        </div>
        ${cardHtml}
      </div>
    `;
    $messages.appendChild(div);
  }
  handlePostAppend({ shouldAutoScroll });
}

// 找到指定角色当前正在显示的 thinking 元素
function findThinkingElement(character, messageId) {
  // 优先按精确 id 定位
  if (messageId) {
    const exact = document.getElementById(`thinking-${character}-${messageId}`);
    if (exact) return exact;
  }
  // 降级：按角色取最新一个
  const candidates = $messages.querySelectorAll(`[id^="thinking-${character}-"]`);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function togglePermDetail(requestId) {
  const card = document.getElementById(`perm-card-${requestId}`);
  if (card) card.classList.toggle("expanded");
}

async function respondPermission(requestId, behavior) {
  markPermResolved(requestId, behavior);

  try {
    await fetch("/api/permission-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, behavior }),
    });
  } catch {
    const actionsEl = document.getElementById(`perm-actions-${requestId}`);
    if (actionsEl) {
      actionsEl.innerHTML = '<span class="perm-pending" style="color:var(--error-text)">发送失败</span>';
    }
  }
}

function resolvePermissionCard(requestId, behavior, message) {
  // 自动通过的权限可能 permission 和 permission-resolved 几乎同时到达
  // 卡片可能还没渲染完，延迟一帧重试
  if (!document.getElementById(`perm-card-${requestId}`)) {
    requestAnimationFrame(() => markPermResolved(requestId, behavior, message));
  } else {
    markPermResolved(requestId, behavior, message);
  }
}

function markPermResolved(requestId, behavior, message) {
  const card = document.getElementById(`perm-card-${requestId}`);
  const actionsEl = document.getElementById(`perm-actions-${requestId}`);
  const isAuto = message && message.includes("默认授权");

  if (card) {
    card.classList.remove("expanded");
    card.classList.add("resolved");
    if (isAuto) card.classList.add("auto-resolved");
  }

  if (actionsEl) {
    const cls = behavior === "allow" ? "allowed" : "denied";
    const label = behavior === "allow" ? "已允许" : "已拒绝";
    actionsEl.innerHTML = `<span class="perm-resolved-label ${cls}">${label}</span>`;
  }

  // 降级模式的独立卡片处理
  const fallbackEl = document.getElementById(`perm-fallback-${requestId}`);
  if (fallbackEl) {
    const badge = fallbackEl.querySelector(".perm-badge");
    if (badge) badge.remove();
    if (isAuto) {
      fallbackEl.classList.add("perm-auto-msg");
      const avatar = fallbackEl.querySelector(".avatar");
      if (avatar) avatar.style.display = "none";
      const header = fallbackEl.querySelector(".msg-header");
      if (header) header.style.display = "none";
    }
  }
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

// ── 右侧栏：角色状态 ─────────────────────────────────────
function setCharStatus(name, status) {
  state.charStatus[name] = status;
  renderCharStatuses();
}

function renderCharStatuses() {
  $charStatuses.innerHTML = "";
  for (const [name, config] of Object.entries(state.characters)) {
    const status = state.charStatus[name] || "online";
    const dotClass = status === "thinking" ? "thinking" : "online";
    const label = status === "thinking" ? "思考中" : "待命";
    const charClass = getCharClass(name);

    const div = document.createElement("div");
    div.className = "char-status";
    div.innerHTML = `
      <div class="status-dot ${dotClass}"></div>
      <span class="char-status-name" style="color: var(--${charClass}-accent)">${escapeHtml(getDisplayName(name))} (${state.profiles[name]?.model ? config.cli + ' · ' + state.profiles[name].model : config.cli})</span>
      <span class="char-status-label">${label}</span>
    `;
    $charStatuses.appendChild(div);
  }
}

// ── 右侧栏：统计 ─────────────────────────────────────────
function updateStats(character, verified) {
  state.stats.total++;
  if (getCharClass(character) === "faker") state.stats.faker++;
  if (getCharClass(character) === "qijige") state.stats.qijige++;
  if (getCharClass(character) === "yyf") state.stats.yyf++;
  if (verified === true) state.stats.verified++;
  renderStats();
}

function renderStats() {
  $("#stat-total").textContent = state.stats.total;
  $("#stat-faker").textContent = state.stats.faker;
  $("#stat-qijige").textContent = state.stats.qijige;
  $("#stat-yyf").textContent = state.stats.yyf;
  $("#stat-verified").textContent = state.stats.verified;
}

// ── 左侧栏：会话列表 ─────────────────────────────────────
async function loadSessionList() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();

    if (data.sessions.length === 0) {
      $sessionList.innerHTML = '<div style="padding:16px;color:var(--text-light);font-size:13px">暂无对话</div>';
      return;
    }

    $sessionList.innerHTML = "";
    for (const s of data.sessions) {
      const isCurrent = s.sessionId === state.sessionId;
      const div = document.createElement("div");
      div.className = `session-item${isCurrent ? " active" : ""}`;
      div.innerHTML = `
        <div class="session-avatars">
          <span class="mini-avatar" style="background:var(--faker-accent)">${escapeHtml(getAvatar(getCharacterByClass("faker"), "F"))}</span>
          <span class="mini-avatar" style="background:var(--qijige-accent)">${escapeHtml(getAvatar(getCharacterByClass("qijige"), "奇"))}</span>
          <span class="mini-avatar" style="background:var(--yyf-accent)">${escapeHtml(getAvatar(getCharacterByClass("yyf"), "Y"))}</span>
        </div>
        <div class="session-preview">${s.sessionId.slice(0, 12)}...${isCurrent ? " (当前)" : ""}</div>
        <div class="session-meta">
          <span>${s.messageCount} 条消息</span>
          <span>${formatTime(s.lastMessageAt)}</span>
        </div>
      `;
      div.addEventListener("click", () => switchSession(s.sessionId));
      $sessionList.appendChild(div);
    }
  } catch { /* ignore */ }
}

function switchSession(id) {
  state.sessionId = id;
  sessionStorage.setItem("sessionId", id);
  $sessionDisplay.textContent = id.slice(0, 8) + "...";
  clearUnreadIndicator();
  closeThread();
  $messages.innerHTML = `<div id="system-notice" class="system-notice">${buildSystemNoticeHtml()}</div>`;
  state.stats = { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 };
  state.threads = {};
  state.messageElements = {};
  renderStats();
  loadHistory();
  loadSessionList();
  connectSSE();
}

function newSession() {
  const id = crypto.randomUUID();
  switchSession(id);
}

// ── 历史记录加载 ──────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`/api/history?sessionId=${state.sessionId}`);
    const log = await res.json();
    if (!log.messages || log.messages.length === 0) return;

    state.isLoadingHistory = true;
    clearUnreadIndicator();
    $messages.innerHTML = "";
    state.stats = { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 };
    state.threads = {};
    state.messageElements = {};

    // 第一遍：重建 thread 数据结构
    for (const msg of log.messages) {
      if (msg.threadId && msg.aiMentions && msg.aiMentions.length > 0 && !msg.depth) {
        // 这是 thread 发起消息
        state.threads[msg.threadId] = {
          originId: msg.id,
          originChar: msg.character,
          originText: msg.text,
          replies: [],
        };
      }
    }
    for (const msg of log.messages) {
      if (msg.threadId && msg.depth > 0 && state.threads[msg.threadId]) {
        state.threads[msg.threadId].replies.push({
          id: msg.id,
          character: msg.character,
          text: msg.text,
          verified: msg.verified,
          depth: msg.depth,
        });
      }
    }

    // 第二遍：渲染消息
    for (const msg of log.messages) {
      if (msg.role === "user") {
        appendUserMessage(msg.text);
      } else if (msg.role === "assistant") {
        if (msg.threadId && msg.depth > 0) {
          appendThreadReply({
            character: msg.character,
            text: msg.text,
            verified: msg.verified,
            replyId: msg.id,
            threadId: msg.threadId,
            depth: msg.depth,
          });
        } else {
          appendAssistantMessage(msg.character, msg.text, msg.verified, msg.id, msg.threadId, msg.aiMentions);
        }
        updateStats(msg.character, msg.verified);
        state.lastSpeaker = msg.character;
      } else if (msg.role === "error") {
        appendErrorMessage(msg.character, msg.error);
      }
    }

    // 重建所有 thread 的回复计数条
    for (const threadId of Object.keys(state.threads)) {
      if (state.threads[threadId].replies.length > 0) {
        updateThreadReplyBar(threadId);
      }
    }

    scrollToBottom();
    clearUnreadIndicator();
  } catch { /* ignore */ }
  finally {
    state.isLoadingHistory = false;
  }
}

// ── @mention 提示 ─────────────────────────────────────────
function setupMentionHints() {
  $mentionHints.innerHTML = "";
  for (const [name] of Object.entries(state.characters)) {
    const displayName = getDisplayName(name);
    const chip = document.createElement("span");
    chip.className = `hint-chip ${getCharClass(name)}`;
    chip.textContent = `@${displayName}`;
    chip.addEventListener("click", () => {
      const cursor = $input.selectionStart;
      const before = $input.value.slice(0, cursor);
      const after = $input.value.slice(cursor);
      
      if (before.endsWith("@")) {
        $input.value = before.slice(0, -1) + `@${displayName} ` + after;
      } else {
        $input.value = before + `@${displayName} ` + after;
      }
      
      $input.focus();
      $mentionHints.classList.add("hidden");
    });
    $mentionHints.appendChild(chip);
  }
}

// ── 输入事件 ──────────────────────────────────────────────
function setupInput() {
  $input.addEventListener("input", () => {
    autoResize($input);
    const cursor = $input.selectionStart;
    const textBefore = $input.value.slice(0, cursor);
    if (textBefore.endsWith("@")) {
      $mentionHints.classList.remove("hidden");
    } else {
      $mentionHints.classList.add("hidden");
    }
  });

  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (state.isComposing || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      sendMessage();
    }
  });

  $input.addEventListener("compositionstart", () => {
    state.isComposing = true;
  });
  $input.addEventListener("compositionend", () => {
    state.isComposing = false;
  });

  $sendBtn.addEventListener("click", sendMessage);
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ── 工具函数 ──────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Markdown 渲染 ─────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  try {
    const raw = marked.parse(text);
    return DOMPurify.sanitize(raw);
  } catch {
    return escapeHtml(text);
  }
}

// 初始化 marked 配置
(function initMarked() {
  if (typeof marked === "undefined") return;
  marked.use({ breaks: true, gfm: true });
  if (typeof markedHighlight !== "undefined" && typeof hljs !== "undefined") {
    marked.use(markedHighlight.markedHighlight({
      langPrefix: "hljs language-",
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(code, { language: lang }).value; } catch {}
        }
        try { return hljs.highlightAuto(code).value; } catch {}
        return "";
      },
    }));
  }
})();

function initProfiles() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "{}");
  } catch { /* ignore */ }

  // 从 V1 迁移（V1 只有 nickname）
  if (Object.keys(saved).length === 0) {
    try {
      const v1 = JSON.parse(localStorage.getItem("characterProfilesV1") || "{}");
      if (Object.keys(v1).length > 0) saved = v1;
    } catch { /* ignore */ }
  }

  state.profiles = {};
  for (const [character] of Object.entries(state.characters)) {
    const nickname = String(saved[character]?.nickname || character).trim() || character;
    const model = String(saved[character]?.model || "").trim();
    state.profiles[character] = { nickname, model };
  }
}

function persistProfiles() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(state.profiles));
}

function getDisplayName(character) {
  return state.profiles[character]?.nickname || character;
}

function getAvatar(character, fallback = "") {
  const displayName = getDisplayName(character);
  const derived = deriveAvatarFromName(displayName);
  return derived || fallback || character?.[0] || "?";
}

function getCharacterByClass(charClass) {
  if (charClass === "qijige") return Object.keys(state.characters).find((k) => state.characters[k]?.cli === "trae");
  if (charClass === "yyf") return Object.keys(state.characters).find((k) => state.characters[k]?.cli === "codex");
  return Object.keys(state.characters).find((k) => state.characters[k]?.cli === "claude");
}

function buildSystemNoticeHtml() {
  const claudeName = getDisplayName(getCharacterByClass("faker"));
  const traeName = getDisplayName(getCharacterByClass("qijige"));
  const codexName = getDisplayName(getCharacterByClass("yyf"));
  return `输入 <code>@${escapeHtml(claudeName)}</code> 调用 Claude，<code>@${escapeHtml(traeName)}</code> 调用 Trae，<code>@${escapeHtml(codexName)}</code> 调用 Codex`;
}

function renderStaticCharacterTexts() {
  const claudeName = getDisplayName(getCharacterByClass("faker"));
  const traeName = getDisplayName(getCharacterByClass("qijige"));
  const codexName = getDisplayName(getCharacterByClass("yyf"));
  $chatSubtitle.textContent = `${claudeName} (Claude) & ${traeName} (Trae) & ${codexName} (Codex)`;
  const noticeEl = $("#system-notice");
  if (noticeEl) noticeEl.innerHTML = buildSystemNoticeHtml();
  $("#label-stat-faker").textContent = `${claudeName} 消息`;
  $("#label-stat-qijige").textContent = `${traeName} 消息`;
  $("#label-stat-yyf").textContent = `${codexName} 消息`;
}

function setupSettings() {
  $settingsBtn.addEventListener("click", () => {
    renderSettingsForm();
    hideSettingsError();
    $settingsModal.classList.remove("hidden");
  });
  $settingsCancelBtn.addEventListener("click", () => {
    hideSettingsError();
    $settingsModal.classList.add("hidden");
  });
  $settingsModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close === "1") {
      hideSettingsError();
      $settingsModal.classList.add("hidden");
    }
  });
  $settingsSaveBtn.addEventListener("click", () => {
    const rows = $settingsForm.querySelectorAll(".setting-row[data-character]");
    const nextProfiles = {};
    const nicknameMap = new Map();
    for (const row of rows) {
      const character = row.getAttribute("data-character");
      const nickname = row.querySelector(".nickname-input")?.value?.trim();
      const model = row.querySelector(".model-input")?.value?.trim() || "";
      if (!character) continue;
      const safeName = nickname || character;
      nextProfiles[character] = { nickname: safeName, model };

      const key = safeName.toLocaleLowerCase();
      if (!nicknameMap.has(key)) nicknameMap.set(key, []);
      nicknameMap.get(key).push(character);
    }

    for (const [key, characters] of nicknameMap.entries()) {
      if (characters.length > 1) {
        showSettingsError(`昵称重复：${key}。请给每个角色设置不同昵称。`);
        return;
      }
    }

    hideSettingsError();
    state.profiles = nextProfiles;
    persistProfiles();
    renderStaticCharacterTexts();
    renderCharStatuses();
    setupMentionHints();
    loadHistory();
    loadSessionList();
    $settingsModal.classList.add("hidden");
  });
}

function renderSettingsForm() {
  $settingsForm.innerHTML = "";
  // 表头
  const header = document.createElement("div");
  header.className = "setting-row";
  header.style.cssText = "font-size:12px;color:var(--text-light);font-weight:500;";
  header.innerHTML = `<div>CLI</div><div>昵称</div><div>模型</div>`;
  $settingsForm.appendChild(header);

  for (const [character, config] of Object.entries(state.characters)) {
    const currentModel = state.profiles[character]?.model || "";
    const isTraeCli = config.cli === "trae";
    const row = document.createElement("div");
    row.className = "setting-row";
    row.setAttribute("data-character", character);
    row.innerHTML = `
      <div class="setting-cli">${config.cli}</div>
      <input class="nickname-input" type="text" value="${escapeHtml(getDisplayName(character))}" placeholder="昵称">
      <input class="model-input" type="text" value="${escapeHtml(currentModel)}" placeholder="${isTraeCli ? "例如 glm-5" : "暂不支持"}" ${isTraeCli ? "" : "disabled"}>
    `;
    $settingsForm.appendChild(row);
  }
}

function deriveAvatarFromName(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  const firstChinese = text.match(/[\u3400-\u9FFF]/);
  if (firstChinese) return firstChinese[0];
  const firstVisible = [...text].find((ch) => /\S/.test(ch));
  return firstVisible || "";
}

function showSettingsError(text) {
  if (!$settingsError) return;
  $settingsError.textContent = text;
  $settingsError.classList.remove("hidden");
}

function hideSettingsError() {
  if (!$settingsError) return;
  $settingsError.textContent = "";
  $settingsError.classList.add("hidden");
}

function normalizeMentions(raw) {
  let text = raw;
  const byLength = Object.keys(state.characters).sort((a, b) => {
    const da = getDisplayName(a);
    const db = getDisplayName(b);
    return db.length - da.length;
  });
  for (const canonical of byLength) {
    const display = getDisplayName(canonical);
    if (!display || display === canonical) continue;
    const escaped = display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`@${escaped}`, "g"), `@${canonical}`);
  }
  return text;
}

// 反向：将 @原始角色名 替换为 @昵称（用于渲染显示）
function displayMentions(raw) {
  let text = raw;
  const byLength = Object.keys(state.characters).sort((a, b) => b.length - a.length);
  for (const canonical of byLength) {
    const display = getDisplayName(canonical);
    if (!display || display === canonical) continue;
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`@${escaped}`, "g"), `@${display}`);
  }
  return text;
}

function getCharClass(character) {
  const cli = state.characters[character]?.cli;
  if (cli === "trae") return "qijige";
  if (cli === "codex") return "yyf";
  return "faker";
}

function scrollToBottom() {
  if (!$chatContainer) return;
  $chatContainer.scrollTop = $chatContainer.scrollHeight;
}

function setupChatScroll() {
  if (!$chatContainer || !$jumpToLatestBtn) return;
  $chatContainer.addEventListener("scroll", () => {
    if (isNearBottom()) clearUnreadIndicator();
  });
  $jumpToLatestBtn.addEventListener("click", () => {
    scrollToBottom();
    clearUnreadIndicator();
  });
}

function handlePostAppend({ shouldAutoScroll = true, force = false } = {}) {
  if (state.isLoadingHistory) return;
  if (force || shouldAutoScroll) {
    scrollToBottom();
    clearUnreadIndicator();
    return;
  }
  increaseUnreadIndicator();
}

function shouldAutoScrollOnAppend() {
  return isNearBottom(BOTTOM_THRESHOLD_PX);
}

function isNearBottom(threshold = BOTTOM_THRESHOLD_PX) {
  if (!$chatContainer) return true;
  const distance = $chatContainer.scrollHeight - $chatContainer.scrollTop - $chatContainer.clientHeight;
  return distance <= threshold;
}

function increaseUnreadIndicator() {
  if (!$jumpToLatestBtn) return;
  state.unreadCount += 1;
  $jumpToLatestBtn.textContent = state.unreadCount > 1 ? `${state.unreadCount} 条新消息` : "有新消息";
  $jumpToLatestBtn.classList.add("show");
}

function clearUnreadIndicator() {
  if (!$jumpToLatestBtn) return;
  state.unreadCount = 0;
  $jumpToLatestBtn.classList.remove("show");
}

function formatTimeShort(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// ── 启动 ──────────────────────────────────────────────────
init();
