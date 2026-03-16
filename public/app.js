// ── 状态 ──────────────────────────────────────────────────
const state = {
  sessionId: null,
  characters: {},      // name -> { cli, avatar, id, archived, model }
  profiles: {},        // (deprecated, kept for backwards compat during transition)
  sessionMembers: [],  // 当前会话的成员角色列表 [{ id, name, cli, ... }]
    sessionMeta: { title: "新对话", workingDirectory: "" },
  eventSource: null,
  // 右侧栏统计 - 动态按角色名统计
  stats: { total: 0, byRole: {}, verified: 0 },
  // 角色状态: "online" | "thinking"
  charStatus: {},
  // thinking 中的 messageId -> Set<character>
  thinkingMap: {},
  unreadCount: 0,
  isLoadingHistory: false,
  isComposing: false,
  lastSpeaker: null,
  // Thread 相关
  threads: {},
  activeThreadId: null,
  // 消息 ID -> DOM 元素映射
  messageElements: {},
  skills: [],
  skillConfig: null,
  skillTraces: [],
  settingsTab: "roles",
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
const $chatTitleText = $("#chat-title-text");
const $chatSubtitle = $("#chat-subtitle");
const $editSessionMetaBtn = $("#edit-session-meta-btn");
const $settingsBtn = $("#settings-btn");
const $settingsModal = $("#settings-modal");
const $settingsForm = $("#settings-form");
const $settingsError = $("#settings-error");
const $settingsSaveBtn = $("#settings-save-btn");
const $settingsCancelBtn = $("#settings-cancel-btn");
const $settingsTitle = $("#settings-title");
const $settingsSubtitle = $("#settings-subtitle");
const $settingsSkillsPanel = $("#settings-skills-panel");
const $threadPanel = $("#thread-panel");
const $threadMessages = $("#thread-messages");
const $threadCloseBtn = $("#thread-close-btn");
const $skillTraceList = $("#skill-trace-list");
const $skillList = $("#skill-list");

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  await loadCharacters();
  initProfiles();

  // 初始化角色状态
  for (const name of Object.keys(state.characters)) {
    state.charStatus[name] = "online";
  }

  // Session
  state.sessionId = sessionStorage.getItem("sessionId");
  if (!state.sessionId) {
    state.sessionId = crypto.randomUUID();
    sessionStorage.setItem("sessionId", state.sessionId);
  }
  $sessionDisplay.textContent = state.sessionId.slice(0, 8) + "...";

  await loadSessionMeta();
  await loadSessionMembers();
  renderStaticCharacterTexts();
  renderCharStatuses();

  await loadHistory();
  await loadSessionList();
  await loadSkillsOverview();
  await loadSkillTraces();
  connectSSE();
  setupInput();
  setupMentionHints();
  setupChatScroll();
  setupSettings();
    setupSessionMetaEditor();
  setupThreadPanel();

  $newSessionBtn.addEventListener("click", () => showNewSessionModal());
}

async function loadCharacters() {
  const res = await fetch("/api/characters");
  const data = await res.json();
  state.characters = data.characters;
}

async function loadSessionMembers() {
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/members`);
    const data = await res.json();
    state.sessionMembers = data.members || [];
  } catch {
    state.sessionMembers = [];
  }
}

async function loadSessionMeta() {
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}`);
    const data = await res.json();
    state.sessionMeta = data.session || { title: "新对话", workingDirectory: "" };
  } catch {
    state.sessionMeta = { title: "新对话", workingDirectory: "" };
  }
  renderSessionMeta();
}

function renderSessionMeta() {
  if ($chatTitleText) {
    $chatTitleText.textContent = state.sessionMeta?.title || "新对话";
  }
  if ($chatSubtitle) {
    $chatSubtitle.textContent = state.sessionMeta?.workingDirectory || "未设置";
    $chatSubtitle.title = state.sessionMeta?.workingDirectory || "";
  }
}

function setupSessionMetaEditor() {
  $editSessionMetaBtn?.addEventListener("click", () => showSessionMetaModal());
}

async function loadSkillsOverview() {
  try {
    const res = await fetch("/api/skills");
    const data = await res.json();
    state.skills = data.skills || [];
    state.skillConfig = data.config || null;
  } catch {
    state.skills = [];
    state.skillConfig = null;
  }
  renderSkillList();
}

async function loadSkillTraces() {
  if (!state.sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/skill-traces?limit=6`);
    const data = await res.json();
    state.skillTraces = data.traces || [];
  } catch {
    state.skillTraces = [];
  }
  renderSkillTraces();
}

function renderSkillTraces() {
  if (!$skillTraceList) return;
  if (!state.skillTraces.length) {
    $skillTraceList.innerHTML = '<div class="empty-panel">暂无命中记录</div>';
    return;
  }

  $skillTraceList.innerHTML = state.skillTraces.map((trace) => {
    const scenes = trace.matchedScenes?.length ? trace.matchedScenes.join(", ") : "(none)";
    const hits = trace.hitSkills?.length ? trace.hitSkills.join(", ") : "(none)";
    const skipped = trace.skipped?.length
      ? trace.skipped.map((item) => `${item.id}:${item.reason}`).join(", ")
      : "-";
    return `
      <div class="skill-trace-item">
        <div class="skill-trace-head">
          <span class="skill-trace-role">${escapeHtml(trace.character || "-")}</span>
          <span class="skill-trace-time">${formatTimeShort(trace.timestamp || Date.now())}</span>
        </div>
        <div class="skill-trace-line"><span>scenes</span><code>${escapeHtml(scenes)}</code></div>
        <div class="skill-trace-line"><span>hits</span><code>${escapeHtml(hits)}</code></div>
        <div class="skill-trace-line"><span>skipped</span><code>${escapeHtml(skipped)}</code></div>
      </div>
    `;
  }).join("");
}

function renderSkillList() {
  if (!$skillList) return;
  if (!state.skills.length) {
    $skillList.innerHTML = '<div class="empty-panel">暂无 Skill</div>';
    return;
  }

  $skillList.innerHTML = state.skills.map((skill) => {
    const bindings = [];
    if (skill.bindings?.global) bindings.push("global");
    if (skill.bindings?.scenes?.length) bindings.push(...skill.bindings.scenes.map((scene) => `scene:${scene}`));
    if (skill.bindings?.roles?.length) bindings.push(...skill.bindings.roles.map((role) => `role:${role}`));
    return `
      <div class="skill-list-item">
        <div class="skill-list-head">
          <span class="skill-id">${escapeHtml(skill.id)}</span>
          <span class="skill-type">${escapeHtml(skill.type)}</span>
        </div>
        <div class="skill-desc">${escapeHtml(skill.description || "")}</div>
        <div class="skill-bindings">${escapeHtml(bindings.join(" · ") || "unbound")}</div>
      </div>
    `;
  }).join("");
}

async function chooseSystemDirectory($input, $error) {
  try {
    const res = await fetch("/api/system/select-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "选择目录失败");
    $input.value = data.workingDirectory || "";
    if ($error) $error.textContent = "";
  } catch (err) {
    if ($error) $error.textContent = err.message;
  }
}

function showSessionMetaModal() {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "session-meta-modal";
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel">
      <h3>对话设置</h3>
      <p class="modal-desc">设置当前对话的名称和工作目录。角色会优先在该目录内执行开发操作。</p>
      <div class="session-meta-fields">
        <label class="session-meta-label">对话名称</label>
        <input id="session-title-input" class="session-meta-input" value="${escapeHtml(state.sessionMeta?.title || "新对话")}">
        <label class="session-meta-label">工作目录</label>
        <div class="session-meta-row">
          <input id="session-workdir-input" class="session-meta-input" value="${escapeHtml(state.sessionMeta?.workingDirectory || "")}" placeholder="/absolute/path">
          <button id="session-workdir-pick" class="btn-secondary" type="button">选择</button>
        </div>
        <div id="session-meta-error" class="settings-error"></div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="session-meta-cancel">取消</button>
        <button class="btn-primary" id="session-meta-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  const $titleInput = modal.querySelector("#session-title-input");
  const $workdirInput = modal.querySelector("#session-workdir-input");
  const $error = modal.querySelector("#session-meta-error");

  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.querySelector("#session-meta-cancel").addEventListener("click", close);
  modal.querySelector("#session-workdir-pick").addEventListener("click", () => chooseSystemDirectory($workdirInput, $error));
  modal.querySelector("#session-meta-save").addEventListener("click", async () => {
    $error.textContent = "";
    try {
      const res = await fetch(`/api/sessions/${state.sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ($titleInput.value || "").trim() || "新对话",
          workingDirectory: ($workdirInput.value || "").trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      state.sessionMeta = data.session;
      renderSessionMeta();
      loadSessionList();
      close();
    } catch (err) {
      $error.textContent = err.message;
    }
  });
}

/**
 * 获取当前会话的成员角色名列表
 */
function getSessionMemberNames() {
  return state.sessionMembers.map(m => m.name);
}

/**
 * 判断角色是否在当前会话成员中
 */
function isMemberInSession(characterName) {
  return state.sessionMembers.some(m => m.name === characterName);
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
    finalizeThinking(data.character, data.messageId, "done");

    if (data.threadId && data.depth > 0) {
      appendThreadReply(data);
    } else {
      appendAssistantMessage(data.character, data.text, data.verified, data.replyId, data.threadId, data.aiMentions, data.timestamp);
    }

    // MCP 消息：invoke 可能还在运行（CLI 退出前），用处理中标记提示用户
    if (data.source === "mcp-tool") {
      markMessageProcessing(data.replyId, data.character);
    } else {
      setCharStatus(data.character, "online");
    }

    state.lastSpeaker = data.character;
    updateStats(data.character, data.verified);
    loadSessionList();
    loadSkillTraces();
  });

  es.addEventListener("message-meta", (e) => {
    const data = JSON.parse(e.data);
    applyVerifiedMeta(data.messageId, data.verified);
  });

  es.addEventListener("error", (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      setCharStatus(data.character, "online");
      finalizeThinking(data.character, data.messageId, "error");
      appendErrorMessage(data.character, data.error);
      loadSkillTraces();
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

  es.addEventListener("abort", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, "online");
    clearMessageProcessing(data.character);
    // 找到所有该角色正在 thinking 的元素，标记为已终止
    const els = document.querySelectorAll(`[id^="thinking-${data.character}-"]`);
    for (const el of els) {
      if (el.dataset.archived) continue;
      finalizeThinking(data.character, el.id.replace(`thinking-${data.character}-`, ""), "error");
    }
    appendSystemNotice(`${getDisplayName(data.character)} 的执行已被用户终止`);
  });

  es.addEventListener("status", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, data.status);
    // invoke 真正结束时清除消息上的"处理中"标记
    if (data.status === "online") {
      clearMessageProcessing(data.character);
    }
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
  if (text.includes("@所有人")) return true;
  // 只检查当前会话成员
  const memberNames = getSessionMemberNames();
  for (const name of memberNames) {
    if (text.includes("@" + name)) return true;
  }
  return false;
}

async function sendMessage() {
  let rawText = $input.value.trim();
  if (!rawText) return;

  // 没有 @mention 时自动 @上一个说话的对象
  if (!hasMention(rawText) && state.lastSpeaker) {
    rawText = "@" + state.lastSpeaker + " " + rawText;
  }

  // "@所有人" 展开为当前会话成员的 @mention
  if (rawText.includes("@所有人")) {
    const allMentions = getSessionMemberNames().map(name => "@" + name).join(" ");
    rawText = rawText.replace(/@所有人/g, allMentions);
  }

  const text = rawText;

  $input.value = "";
  autoResize($input);
  $mentionHints.classList.add("hidden");

  const userMsgEl = appendUserMessage(rawText);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          text,
          sessionId: state.sessionId,
        }),
    });

    if (!res.ok) {
      const err = await res.json();
      appendErrorMessage("系统", err.error);
    } else {
      const data = await res.json();
      if (data.timestamp && userMsgEl) {
        const timeEl = userMsgEl.querySelector(".msg-time");
        if (timeEl) timeEl.textContent = formatTimeShort(data.timestamp);
      }
    }
  } catch {
    appendErrorMessage("系统", "网络错误，无法发送消息");
  }
}

// ── 消息渲染 ──────────────────────────────────────────────
function appendUserMessage(text, timestamp) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const time = formatTimeShort(timestamp || Date.now());
  const div = document.createElement("div");
  div.className = "message user";
  div.innerHTML = `
    <div class="avatar user-avatar">铲</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name user-name">铲屎官</span>
          <span class="msg-time">${time}</span>
      </div>
      <div class="bubble">${escapeHtml(text)}</div>
    </div>
  `;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll, force: true });
  state.stats.total++;
  renderStats();
  return div;
}

function verifiedBadgeHtml(verified) {
  if (verified === true) return '<span class="verified-badge pass">verified</span>';
  if (verified === false) return '<span class="verified-badge fail">unverified</span>';
  return "";
}

function applyVerifiedMeta(messageId, verified) {
  const el = state.messageElements[messageId];
  if (!el) return;

  const previous = el.dataset.verified;
  const next = verified === undefined ? "" : String(verified);
  const header = el.querySelector(".msg-header");
  if (!header) return;

  header.querySelector(".verified-badge")?.remove();
  const badge = verifiedBadgeHtml(verified);
  if (badge) {
    header.insertAdjacentHTML("beforeend", badge);
  }

  if (previous !== next) {
    if (previous !== "true" && verified === true) state.stats.verified++;
    if (previous === "true" && verified !== true) state.stats.verified = Math.max(0, state.stats.verified - 1);
    renderStats();
  }

  el.dataset.verified = next;
  if (el.dataset.threadId && state.threads[el.dataset.threadId]) {
    const thread = state.threads[el.dataset.threadId];
    if (thread.originId === messageId) {
      thread.originVerified = verified;
    }
    const reply = thread.replies.find((item) => item.id === messageId);
    if (reply) reply.verified = verified;
    updateThreadPanelIfOpen(el.dataset.threadId);
  }
}

function appendAssistantMessage(character, text, verified, replyId, threadId, aiMentions, timestamp) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(timestamp || Date.now());
  const cli = state.characters[character]?.cli || "";
  const model = state.characters[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;
  const msgId = replyId || crypto.randomUUID();

  const verifiedHtml = verifiedBadgeHtml(verified);

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
      <div class="bubble markdown-body">${renderMarkdown(text)}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  $messages.appendChild(div);

  // 追踪消息元素
  state.messageElements[msgId] = div;
  div.dataset.verified = verified === undefined ? "" : String(verified);
  if (threadId) div.dataset.threadId = threadId;

  // 如果这条消息中有 AI @mention，初始化 thread 数据（避免覆盖 loadHistory 已建好的）
  if (aiMentions && aiMentions.length > 0) {
    const tid = threadId || msgId;
    if (!state.threads[tid]) {
      state.threads[tid] = {
        originId: msgId,
        originChar: character,
        originText: text,
        originVerified: verified,
        replies: [],
      };
    }
  }

  handlePostAppend({ shouldAutoScroll });
}

// ── Thread 回复渲染（主聊天流中，带引用条） ──────────────
function appendThreadReply(data) {
  const { character, text, verified, replyId, threadId, depth, timestamp } = data;
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(timestamp || Date.now());
  const cli = state.characters[character]?.cli || "";
  const model = state.characters[character]?.model;
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

  const verifiedHtml = verifiedBadgeHtml(verified);

  // 引用条：显示原始消息的第一行
  let quoteHtml = "";
  if (threadId && state.threads[threadId]) {
    const origin = state.threads[threadId];
    const firstLine = (origin.originText || "").split("\n")[0].slice(0, 60);
    const originDisplayName = getDisplayName(origin.originChar);
    quoteHtml = `
      <div class="thread-quote" data-thread-id="${threadId}" onclick="openThread('${threadId}')">
        <span class="quote-char">${escapeHtml(originDisplayName)}:</span>
        <span class="quote-text">${escapeHtml(firstLine)}</span>
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
      <div class="bubble markdown-body">${quoteHtml}${renderMarkdown(text)}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  $messages.appendChild(div);
  state.messageElements[msgId] = div;
  div.dataset.verified = verified === undefined ? "" : String(verified);

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
  const originEl = buildThreadMessage(thread.originChar, thread.originText, false, thread.originVerified);
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
  const model = state.characters[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;

  const verifiedHtml = verifiedBadgeHtml(verified);

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        ${verifiedHtml}
      </div>
      <div class="bubble markdown-body">${renderMarkdown(text)}</div>
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
          <span class="msg-time thinking-status"><span class="thinking-spinner"></span>处理中...</span>
          <button class="abort-btn" title="终止执行" data-character="${escapeHtml(character)}">终止</button>
        </div>
        <div class="thinking-scroll-area">
          <div class="process-log"></div>
          <div class="perm-container"></div>
        </div>
      </div>
  `;
  // 绑定终止按钮
  div.querySelector(".abort-btn").addEventListener("click", () => {
    abortInvoke(character);
  });
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

// ── 用户主动终止 AI 执行 ─────────────────────────────────
async function abortInvoke(character) {
  try {
    const res = await fetch("/api/abort-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserSessionId: state.sessionId, character }),
    });
    const data = await res.json();
    if (!data.ok) console.warn("[abort]", data.error);
  } catch (err) {
    console.error("[abort] 请求失败:", err);
  }
}

// ── 消息级"处理中"标记（invoke 未结束时显示在消息上方）──
function markMessageProcessing(msgId, character) {
  const el = state.messageElements[msgId];
  if (!el) return;
  // 在消息 header 中追加处理中标记
  const header = el.querySelector(".msg-header");
  if (!header || header.querySelector(".msg-processing")) return;
  const badge = document.createElement("span");
  badge.className = "msg-processing";
  badge.dataset.character = character;
  badge.innerHTML = '<span class="thinking-spinner"></span>仍在处理中';
  header.appendChild(badge);
}

function clearMessageProcessing(character) {
  const badges = document.querySelectorAll(`.msg-processing[data-character="${character}"]`);
  for (const badge of badges) badge.remove();
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

  // 当前会话成员
  const memberNames = getSessionMemberNames();
  for (const member of state.sessionMembers) {
    const name = member.name;
    const status = state.charStatus[name] || "online";
    const dotClass = status === "thinking" ? "thinking" : "online";
    const label = status === "thinking" ? "思考中" : "待命";
    const charClass = getCharClass(name);

    const div = document.createElement("div");
    div.className = "char-status";
    div.innerHTML = `
      <div class="status-dot ${dotClass}"></div>
      <span class="char-status-name" style="color: var(--${charClass}-accent)">${escapeHtml(name)} (${member.model ? member.cli + ' · ' + member.model : member.cli})</span>
      <span class="char-status-label">${label}</span>
      <button class="btn-remove-member" title="移出会话" data-role-id="${member.id}" data-name="${escapeHtml(name)}">×</button>
    `;
    div.querySelector(".btn-remove-member").addEventListener("click", async (e) => {
      const roleId = e.target.dataset.roleId;
      await fetch(`/api/sessions/${state.sessionId}/members/${roleId}`, { method: "DELETE" });
    await loadSessionMeta();
      await loadSessionMembers();
      renderCharStatuses();
      setupMentionHints();
    });
    $charStatuses.appendChild(div);
  }

  // 可邀请角色（未归档且不在当前会话中）
  const invitable = Object.entries(state.characters).filter(([name, cfg]) =>
    !cfg.archived && !memberNames.includes(name)
  );
  if (invitable.length > 0) {
    const divider = document.createElement("div");
    divider.className = "invite-divider";
    divider.textContent = "可邀请";
    $charStatuses.appendChild(divider);

    for (const [name, cfg] of invitable) {
      const div = document.createElement("div");
      div.className = "char-status invitable";
      div.innerHTML = `
        <span class="char-status-name">${escapeHtml(name)} (${cfg.cli})</span>
        <button class="btn-invite-member" data-role-id="${cfg.id}">邀请</button>
      `;
      div.querySelector(".btn-invite-member").addEventListener("click", async (e) => {
        const roleId = e.target.dataset.roleId;
        await fetch(`/api/sessions/${state.sessionId}/members/${roleId}/invite`, { method: "POST" });
        await loadSessionMembers();
        renderCharStatuses();
        setupMentionHints();
      });
      $charStatuses.appendChild(div);
    }
  }
}

// ── 右侧栏：统计 ─────────────────────────────────────────
function updateStats(character, verified) {
  state.stats.total++;
  if (!state.stats.byRole[character]) state.stats.byRole[character] = 0;
  state.stats.byRole[character]++;
  if (verified === true) state.stats.verified++;
  renderStats();
}

function renderStats() {
  const $statsContainer = $("#message-stats");
  if (!$statsContainer) return;
  $statsContainer.innerHTML = `
    <div class="stat-row"><span>总数</span><span>${state.stats.total}</span></div>
    ${Object.entries(state.stats.byRole).map(([name, count]) =>
      `<div class="stat-row"><span>${escapeHtml(name)} 消息</span><span>${count}</span></div>`
    ).join("")}
    <div class="stat-row"><span>验证通过</span><span>${state.stats.verified}</span></div>
  `;
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
      const activeRoles = Object.entries(state.characters).filter(([, c]) => !c.archived).slice(0, 3);
      const avatarsHtml = activeRoles.map(([name, cfg]) => {
        const charClass = getCharClass(name);
        const av = getAvatar(name, cfg.avatar);
        return '<span class="mini-avatar" style="background:var(--' + charClass + '-accent)">' + escapeHtml(av) + '</span>';
      }).join('');
      div.innerHTML = `
        <div class="session-avatars">${avatarsHtml}</div>
          <div class="session-preview">${escapeHtml(s.title || s.sessionId.slice(0, 12))}${isCurrent ? " (当前)" : ""}</div>
          <div class="session-path">${escapeHtml(s.workingDirectory || s.sessionId)}</div>
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

async function switchSession(id) {
  state.sessionId = id;
  sessionStorage.setItem("sessionId", id);
  $sessionDisplay.textContent = id.slice(0, 8) + "...";
  clearUnreadIndicator();
  closeThread();
  state.stats = { total: 0, byRole: {}, verified: 0 };
  state.threads = {};
  state.messageElements = {};

    await loadSessionMeta();
  await loadSessionMembers();
  $messages.innerHTML = `<div id="system-notice" class="system-notice">${buildSystemNoticeHtml()}</div>`;
  renderStats();
  renderCharStatuses();
  setupMentionHints();
  renderStaticCharacterTexts();
  await loadHistory();
  await loadSessionList();
  await loadSkillTraces();
  connectSSE();
}

function showNewSessionModal() {
  const roles = Object.entries(state.characters).filter(([, cfg]) => !cfg.archived);
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "new-session-modal";
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel">
      <h3>新建会话</h3>
      <p class="modal-desc">选择要加入的角色（可在会话中随时邀请/移除）</p>
      <div id="new-session-roles">
        ${roles.map(([name, cfg]) => `
          <label class="role-checkbox">
            <input type="checkbox" value="${cfg.id}" checked>
            <span class="role-check-name">${escapeHtml(name)}</span>
            <span class="role-check-cli">(${cfg.cli})</span>
          </label>
        `).join("")}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="new-session-cancel">取消</button>
        <button class="btn-primary" id="new-session-create">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  modal.querySelector("#new-session-cancel").addEventListener("click", () => modal.remove());
  modal.querySelector("#new-session-create").addEventListener("click", async () => {
    const checked = modal.querySelectorAll('input[type="checkbox"]:checked');
    const memberIds = [...checked].map(cb => cb.value);
    const sessionId = crypto.randomUUID();

    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, memberIds }),
    });

    modal.remove();
    switchSession(sessionId);
  });
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
    state.stats = { total: 0, byRole: {}, verified: 0 };
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
          originVerified: msg.verified,
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
        appendUserMessage(msg.text, msg.timestamp);
      } else if (msg.role === "assistant") {
        if (msg.threadId && msg.depth > 0) {
          appendThreadReply({
            character: msg.character,
            text: msg.text,
            verified: msg.verified,
            replyId: msg.id,
            threadId: msg.threadId,
            depth: msg.depth,
            timestamp: msg.timestamp,
          });
        } else {
          appendAssistantMessage(msg.character, msg.text, msg.verified, msg.id, msg.threadId, msg.aiMentions, msg.timestamp);
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
  // 只显示当前会话成员
  const memberNames = getSessionMemberNames();
  for (const name of memberNames) {
    const chip = document.createElement("span");
    chip.className = `hint-chip ${getCharClass(name)}`;
    chip.textContent = `@${name}`;
    chip.addEventListener("click", () => {
      const cursor = $input.selectionStart;
      const before = $input.value.slice(0, cursor);
      const after = $input.value.slice(cursor);
      
      if (before.endsWith("@")) {
        $input.value = before.slice(0, -1) + `@${name} ` + after;
      } else {
        $input.value = before + `@${name} ` + after;
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
  // Profiles are now managed server-side via role system
  state.profiles = {};
}

function getDisplayName(character) {
  return character;
}

function getAvatar(character, fallback = "") {
  const displayName = getDisplayName(character);
  const derived = deriveAvatarFromName(displayName);
  return derived || fallback || character?.[0] || "?";
}


function buildSystemNoticeHtml() {
  const memberNames = getSessionMemberNames();
  if (memberNames.length === 0) return "暂无角色，请在右侧栏邀请角色加入会话";
  return "输入 " + memberNames.map(name => {
    const cli = state.characters[name]?.cli || "";
    return `<code>@${escapeHtml(name)}</code> 调用 ${cli}`;
  }).join("，");
}

function renderStaticCharacterTexts() {
  renderSessionMeta();
  const noticeEl = $("#system-notice");
  if (noticeEl) noticeEl.innerHTML = buildSystemNoticeHtml();
}

function setupSettings() {
  $settingsBtn.addEventListener("click", async () => {
    await loadSkillsOverview();
    await loadSkillTraces();
    renderSettingsForm();
    setSettingsTab(state.settingsTab || "roles");
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

  document.querySelectorAll(".settings-tab[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextTab = btn.dataset.settingsTab || "roles";
      if (nextTab === "skills") {
        await loadSkillsOverview();
        await loadSkillTraces();
      }
      setSettingsTab(nextTab);
      hideSettingsError();
    });
  });

  $settingsSaveBtn.addEventListener("click", async () => {
    if (state.settingsTab !== "roles") return;

    const rows = $settingsForm.querySelectorAll(".setting-row[data-role-id]");
    const nameMap = new Map();
    const updates = [];

    for (const row of rows) {
      const roleId = row.getAttribute("data-role-id");
      const name = row.querySelector(".name-input")?.value?.trim();
      const model = row.querySelector(".model-input")?.value?.trim() || "";
      if (!roleId || !name) continue;

      const key = name.toLocaleLowerCase();
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key).push(roleId);
      updates.push({ roleId, name, model });
    }

    for (const [key, ids] of nameMap.entries()) {
      if (ids.length > 1) {
        showSettingsError(`角色名重复：${key}。请给每个角色设置不同名称。`);
        return;
      }
    }

    hideSettingsError();

    for (const { roleId, name, model } of updates) {
      try {
        const res = await fetch(`/api/roles/${roleId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, model }),
        });
        if (!res.ok) {
          const data = await res.json();
          showSettingsError(data.error || "更新失败");
          return;
        }
      } catch (err) {
        showSettingsError(`更新失败: ${err.message}`);
        return;
      }
    }

    await loadCharacters();
    await loadSessionMembers();
    renderStaticCharacterTexts();
    renderCharStatuses();
    setupMentionHints();
    renderStats();
    renderSettingsForm();
    $settingsModal.classList.add("hidden");
  });
}

function setSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll(".settings-tab[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsTab === tab);
  });

  const isRolesTab = tab === "roles";
  if ($settingsTitle) {
    $settingsTitle.textContent = isRolesTab ? "角色管理" : "SKILL 面板";
  }
  if ($settingsSubtitle) {
    $settingsSubtitle.textContent = isRolesTab
      ? "管理角色名称、模型配置。可归档、恢复和新增角色。"
      : "查看最近命中的 Skill 和当前已加载的 Skill 绑定关系。";
  }
  if ($settingsForm) {
    $settingsForm.style.display = isRolesTab ? "grid" : "none";
  }
  if ($settingsSkillsPanel) {
    $settingsSkillsPanel.style.display = isRolesTab ? "none" : "grid";
  }
  if ($settingsSaveBtn) {
    $settingsSaveBtn.style.display = isRolesTab ? "inline-flex" : "none";
  }
}

function renderSettingsForm() {
  $settingsForm.innerHTML = "";
  // 表头
  const header = document.createElement("div");
  header.className = "setting-row";
  header.style.cssText = "font-size:12px;color:var(--text-light);font-weight:500;";
  header.innerHTML = `<div>CLI</div><div>角色名</div><div>模型</div><div></div>`;
  $settingsForm.appendChild(header);

  const allRoles = Object.entries(state.characters).map(([name, cfg]) => ({
    id: cfg.id, name, cli: cfg.cli, model: cfg.model || "", archived: cfg.archived || false,
  }));

  for (const role of allRoles) {
    const row = document.createElement("div");
    row.className = `setting-row${role.archived ? " archived" : ""}`;
    row.setAttribute("data-role-id", role.id);
    row.innerHTML = `
      <div class="setting-cli">${role.cli}</div>
      <input class="name-input" type="text" value="${escapeHtml(role.name)}" placeholder="角色名" ${role.archived ? "disabled" : ""}>
      <input class="model-input" type="text" value="${escapeHtml(role.model)}" placeholder="模型" ${role.archived ? "disabled" : ""}>
      <div class="setting-actions">
        ${role.archived
          ? `<button class="btn-restore" data-role-id="${role.id}" title="恢复">恢复</button>`
          : `<button class="btn-archive" data-role-id="${role.id}" title="归档">归档</button>`
        }
      </div>
    `;
    $settingsForm.appendChild(row);
  }

  // 归档/恢复按钮事件
  $settingsForm.querySelectorAll(".btn-archive").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/roles/${btn.dataset.roleId}/archive`, { method: "POST" });
      await loadCharacters();
      await loadSessionMembers();
      renderSettingsForm();
      renderCharStatuses();
      setupMentionHints();
      renderStaticCharacterTexts();
    });
  });
  $settingsForm.querySelectorAll(".btn-restore").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/roles/${btn.dataset.roleId}/restore`, { method: "POST" });
      await loadCharacters();
      await loadSessionMembers();
      renderSettingsForm();
      renderCharStatuses();
      setupMentionHints();
      renderStaticCharacterTexts();
    });
  });

  // 新增角色按钮
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add-role";
  addBtn.textContent = "+ 新增角色";
  addBtn.addEventListener("click", () => showCreateRoleModal());
  $settingsForm.appendChild(addBtn);
}

function showCreateRoleModal() {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "create-role-modal";
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel">
      <h3>新增角色</h3>
      <div class="create-role-form">
        <label>角色名 <input type="text" id="new-role-name" placeholder="例如: 小助手"></label>
        <label>CLI <select id="new-role-cli">
          <option value="claude">claude</option>
          <option value="trae">trae</option>
          <option value="codex">codex</option>
        </select></label>
        <label>模型 <input type="text" id="new-role-model" placeholder="可选"></label>
        <div id="create-role-error" class="settings-error hidden"></div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="create-role-cancel">取消</button>
        <button class="btn-primary" id="create-role-submit">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  modal.querySelector("#create-role-cancel").addEventListener("click", () => modal.remove());
  modal.querySelector("#create-role-submit").addEventListener("click", async () => {
    const name = modal.querySelector("#new-role-name").value.trim();
    const cli = modal.querySelector("#new-role-cli").value;
    const model = modal.querySelector("#new-role-model").value.trim();
    const errEl = modal.querySelector("#create-role-error");

    if (!name) {
      errEl.textContent = "角色名不能为空";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cli, model }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }

      modal.remove();
      await loadCharacters();
      renderSettingsForm();
      renderCharStatuses();
      setupMentionHints();
      renderStaticCharacterTexts();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    }
  });
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
