// ── 状态 ──────────────────────────────────────────────────
const state = {
  sessionId: null,
  characters: {},      // name -> { cli, avatar, id, archived, model }
  profiles: {},        // (deprecated, kept for backwards compat during transition)
  sessionMembers: [],  // 当前会话的成员角色列表 [{ id, name, cli, ... }]
  sessionMeta: { title: "新对话", displayTitle: "新对话", titleCustomized: false, workingDirectory: "" },
  sessionReadCounts: null,
  sessionSummaries: {},
  eventSource: null,
  lastEventSeq: 0,   // 历史快照的事件序号，SSE 按此续订，刷新/断线不丢事件
  // 右侧栏统计 - 动态按角色名统计
  stats: { total: 0, byRole: {} },
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
  // 文件修改记录: "character|messageId" -> { filePath -> changes[] }（仅执行成功的编辑类工具）
  fileChanges: {},
  // 权限请求索引: requestId -> SSE permission 事件数据（等待 permission-executed 归档）
  permRequestIndex: {},
  // "character|messageId" -> replyId，用于执行结果晚于回复到达时补挂目录
  replyByThinking: {},
  skills: [],
  skillConfig: null,
  skillTraces: [],
  settingsTab: "roles",
};

const PROFILE_STORAGE_KEY = "characterProfilesV2";
const SESSION_READ_COUNTS_KEY = "sessionReadCountsV1";
const SESSION_LIST_REFRESH_MS = 3000;
const BOTTOM_THRESHOLD_PX = 40;

// ── DOM 元素 ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $messages = $("#messages");
const $input = $("#message-input");
const $sendBtn = $("#send-btn");
const $chatContainer = $("#chat-container");
const $jumpToLatestBtn = $("#jump-to-latest-btn");
const $permFloatLayer = $("#perm-float-layer");
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
const $diffPanel = $("#diff-panel");
const $diffPanelTitle = $("#diff-panel-title");
const $diffPanelSub = $("#diff-panel-sub");
const $diffPanelContent = $("#diff-panel-content");
const $diffCloseBtn = $("#diff-close-btn");
const $diffNav = $("#diff-nav");
const $diffNavPrev = $("#diff-nav-prev");
const $diffNavCount = $("#diff-nav-count");
const $diffNavNext = $("#diff-nav-next");
const $diffResizeHandle = $("#diff-resize-handle");
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
  scheduleSessionRoleCardRefresh();

  await loadHistory();
  await loadSessionList();
  startSessionListRefresh();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadSessionList();
  });
  await loadSkillsOverview();
  await loadSkillTraces();
  connectSSE();
  setupInput();
  setupMentionHints();
  setupChatScroll();
  setupSettings();
    setupSessionMetaEditor();
  setupThreadPanel();
  setupDiffPanel();
  setupPermFloatLayer();

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

let runtimeRefreshTimer = null;
let runtimeRefreshInFlight = false;

async function refreshSessionRoleCards(sessionId = state.sessionId) {
  if (!sessionId) return;
  try {
    await fetch(`/api/sessions/${sessionId}/runtime-metrics/refresh`, { method: "POST" });
    if (state.sessionId !== sessionId) return;
    await loadSessionMembers();
    renderCharStatuses();
  } catch {
    // ignore refresh errors and keep last known metrics
  }
}

function scheduleSessionRoleCardRefresh(delay = 120) {
  if (!state.sessionId) return;
  if (runtimeRefreshTimer) clearTimeout(runtimeRefreshTimer);
  const targetSessionId = state.sessionId;
  runtimeRefreshTimer = setTimeout(async () => {
    runtimeRefreshTimer = null;
    if (runtimeRefreshInFlight) return;
    runtimeRefreshInFlight = true;
    try {
      if (state.sessionId !== targetSessionId) return;
      await refreshSessionRoleCards(targetSessionId);
    } finally {
      runtimeRefreshInFlight = false;
    }
  }, delay);
}

async function loadSessionMeta() {
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}`);
    const data = await res.json();
    state.sessionMeta = data.session || { title: "新对话", displayTitle: "新对话", titleCustomized: false, workingDirectory: "" };
  } catch {
    state.sessionMeta = { title: "新对话", displayTitle: "新对话", titleCustomized: false, workingDirectory: "" };
  }
  renderSessionMeta();
}

function renderSessionMeta() {
  if ($chatTitleText) {
    const displayTitle = state.sessionMeta?.displayTitle || state.sessionMeta?.title || "新对话";
    $chatTitleText.textContent = displayTitle;
    $chatTitleText.title = displayTitle;
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

/**
 * 调用原生API选择目录（Windows/macOS原生目录选择器）
 */
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
        <input id="session-title-input" class="session-meta-input" value="${escapeAttribute(state.sessionMeta?.titleCustomized ? state.sessionMeta.title : "")}" placeholder="留空则显示第一条聊天记录">
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
          title: ($titleInput.value || "").trim(),
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
function closeEventSource() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

// 正在执行 resync 的连接集合：防重绑定到具体 EventSource/会话，
// 避免 A 会话的 resync 把 B 会话自己的 resync 吞掉（服务端只发一次）
const resyncingSources = new Set();

async function handleSSEResync(es) {
  if (resyncingSources.has(es)) return;
  if (state.eventSource !== es) return;
  const targetSession = state.sessionId;
  resyncingSources.add(es);
  try {
    closeEventSource();
    await loadHistory(targetSession);
    // 重载期间若已切换会话或另有重连，不再重复建连
    if (state.sessionId === targetSession && state.eventSource === null) {
      connectSSE();
    }
  } finally {
    resyncingSources.delete(es);
  }
}

function connectSSE() {
  closeEventSource();

  const es = new EventSource(`/api/events?sessionId=${state.sessionId}&afterSeq=${state.lastEventSeq}`);
  state.eventSource = es;

  // 建连/断线重连成功后，以服务端快照校准浮层（journal 补发之外的兜底）
  es.addEventListener("open", () => {
    syncFloatPermsFromServer();
  });

  // 缺失区间超出服务端 journal 容量时：关闭当前连接 → 加载一致快照 → 按新序号重连。
  // 重载窗口内的事件由服务端 journal 保留，重连后补发，不会丢。
  es.addEventListener("resync", () => {
    handleSSEResync(es);
  });

  es.addEventListener("thinking", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, "thinking");
    showThinking(data.character, data.messageId);
    loadSessionList();
  });

  es.addEventListener("thinking-content", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, "thinking");
    // reply/error 可能先于 CLI 最后一条过程 message 到达；优先复用已嵌入回复的归档容器，
    // 避免同一轮后续过程信息又创建一条独立“Thinking 过程”记录。
    const container = findThinkingElement(data.character, data.messageId)
      || showThinking(data.character, data.messageId);
    if (container) appendThinkingContent(container, data);
  });

  es.addEventListener("reply", (e) => {
    const data = JSON.parse(e.data);
    finalizeThinking(data.character, data.messageId, "done");

    if (data.threadId && data.depth > 0) {
      appendThreadReply(data);
      // 召唤链 thread 回复：执行记录嵌入回复内部（与历史渲染一致）
      attachThinkingToReply(data.character, data.messageId, state.messageElements[data.replyId]);
    } else {
      appendAssistantMessage(data.character, data.text, data.replyId, data.threadId, data.aiMentions, data.timestamp);
      // 执行期间可能有其他消息插入，把过程记录挪到该回复正上方
      attachThinkingToReply(data.character, data.messageId, state.messageElements[data.replyId]);
    }

    if (data.messageId) {
      state.replyByThinking[`${data.character}|${data.messageId}`] = data.replyId;
      renderFileDiffDirectory(data.character, data.messageId, state.messageElements[data.replyId]);
    }

    if (data.source !== "mcp-tool") {
      setCharStatus(data.character, "online");
    }

    state.lastSpeaker = data.character;
    updateStats(data.character);
    loadSessionList();
    loadSkillTraces();
  });

  es.addEventListener("error", (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      setCharStatus(data.character, "online");
      finalizeThinking(data.character, data.messageId, "error");
      const errorEl = appendErrorMessage(data.character, data.error);
      // 归档后的执行记录嵌入错误气泡内部，不再作为独立行残留
      if (data.messageId) attachThinkingToReply(data.character, data.messageId, errorEl);
      loadSessionList();
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
    // 找到所有该角色正在 thinking 的元素，标记为已终止
    const els = document.querySelectorAll(`[id^="thinking-${data.character}-"]`);
    for (const el of els) {
      if (el.dataset.archived) continue;
      finalizeThinking(data.character, el.id.replace(`thinking-${data.character}-`, ""), "error");
    }
    appendSystemNotice(`${getDisplayName(data.character)} 的执行已被用户终止`);
    loadSessionList();
  });

  es.addEventListener("status", (e) => {
    const data = JSON.parse(e.data);
    setCharStatus(data.character, data.status);
    if (data.status === "online") {
      // 完成事件携带 messageId 时，按 character + messageId 精确清理 live thinking
      if (data.messageId) finalizeThinking(data.character, data.messageId, "done");
    }
    loadSessionList();
  });

  // ── 角色运行时指标事件 ──
  es.addEventListener("role-metrics", (e) => {
    const data = JSON.parse(e.data);
    const member = state.sessionMembers.find(m => m.id === data.roleId);
    if (!member) return;
    member.runtimeMetrics = data.metrics;
    renderCharStatuses();
  });

  // ── 权限请求事件 ──
  es.addEventListener("permission", (e) => {
    const data = JSON.parse(e.data);
    state.permRequestIndex[data.requestId] = data;
    showPermissionCard(data);
    addFloatPerm(data);
    loadSessionList();
  });

  es.addEventListener("permission-resolved", (e) => {
    const data = JSON.parse(e.data);
    const req = state.permRequestIndex[data.requestId];
    if (req && data.behavior === "allow") req.approved = true;
    resolvePermissionCard(data.requestId, data.behavior, data.message);
    loadSessionList();
  });

  es.addEventListener("permission-executed", (e) => {
    const data = JSON.parse(e.data);
    const req = state.permRequestIndex[data.requestId];
    if (!req) return;
    req.execution = data.execution;
    if (req.approved) {
      recordFileChange(req);
      // 回复可能先于执行结果渲染，支持补挂/刷新目录
      refreshFileDiffDirectory(req.character, req.messageId);
    }
    delete state.permRequestIndex[data.requestId];
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
      await Promise.all([loadSessionMeta(), loadSessionList()]);
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

function appendAssistantMessage(character, text, replyId, threadId, aiMentions, timestamp) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(timestamp || Date.now());
  const cli = state.characters[character]?.cli || "";
  const model = state.characters[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;
  const msgId = replyId || crypto.randomUUID();

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.dataset.msgId = msgId;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="bubble markdown-body">${renderMarkdown(text)}</div>
      <div class="msg-model">${modelLabel}</div>
    </div>
  `;
  $messages.appendChild(div);

  // 追踪消息元素
  state.messageElements[msgId] = div;
  if (threadId) div.dataset.threadId = threadId;

  // 如果这条消息中有 AI @mention，初始化 thread 数据（避免覆盖 loadHistory 已建好的）
  if (aiMentions && aiMentions.length > 0) {
    const tid = threadId || msgId;
    if (!state.threads[tid]) {
      state.threads[tid] = {
        originId: msgId,
        originChar: character,
        originText: text,
        replies: [],
        rootConfirmed: tid === msgId,
      };
    }
  }

  handlePostAppend({ shouldAutoScroll });
}

// ── Thread 回复渲染（主聊天流中，带引用条） ──────────────
function appendThreadReply(data) {
  const { character, text, replyId, threadId, depth, timestamp } = data;
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
  // 空文本记录不算有效回复，与历史重建保持同一口径
  if (threadId && state.threads[threadId] && String(text || "").trim()) {
    const existing = state.threads[threadId].replies.find(r => r.id === msgId);
    if (!existing) {
      state.threads[threadId].replies.push({
        id: msgId, character, text, depth,
      });
    }
    if (!state.isLoadingHistory) {
      updateThreadReplyBar(threadId);
      updateThreadPanelIfOpen(threadId);
    }
  }

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
      </div>
      <div class="bubble markdown-body">${quoteHtml}${renderMarkdown(text)}</div>
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
  const originEl = buildThreadMessage(thread.originChar, thread.originText);
  $threadMessages.appendChild(originEl);

  // 分隔线
  const divider = document.createElement("div");
  divider.className = "thread-origin-divider";
  divider.textContent = `${thread.replies.length} 条回复`;
  $threadMessages.appendChild(divider);

  // 2. 所有回复
  for (const reply of thread.replies) {
    const replyEl = buildThreadMessage(reply.character, reply.text);
    $threadMessages.appendChild(replyEl);
  }

  $threadMessages.scrollTop = $threadMessages.scrollHeight;
}

function buildThreadMessage(character, text) {
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const cli = state.characters[character]?.cli || "";
  const model = state.characters[character]?.model;
  const modelLabel = model ? `${cli} · ${model}` : cli;

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
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

function appendErrorMessage(character, error, timestamp) {
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
        <span class="msg-time">${formatTimeShort(timestamp || Date.now())}</span>
      </div>
      <div class="bubble">${escapeHtml(error)}</div>
    </div>
  `;
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
  return div;
}

// ── Thinking ──────────────────────────────────────────────
function showThinking(character, messageId) {
  const existing = document.getElementById(`thinking-${character}-${messageId}`);
  if (existing) return existing;

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
          <svg class="thinking-toggle-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M9 18l6-6-6-6"/></svg>
        </div>
          <div class="thinking-scroll-area">
            <div class="thinking-live-content">
              <div class="process-log"></div>
              <div class="perm-container"></div>
            </div>
            <details class="thinking-process" hidden open>
              <summary>Thinking 过程</summary>
              <div class="thinking-content"></div>
            </details>
          </div>
      </div>
  `;
  // 绑定终止按钮
  div.querySelector(".abort-btn").addEventListener("click", () => {
    abortInvoke(character);
  });
  bindThinkingHeader(div);
  $messages.appendChild(div);
  handlePostAppend({ shouldAutoScroll });
  return div;
}

// 点击已完成的过程记录头部时折叠/展开（参考 clowder-ai 的折叠交互）
function bindThinkingHeader(div) {
  const header = div.querySelector(".msg-header") || div.querySelector(".thinking-embed-header");
  if (!header) return;
  header.addEventListener("click", () => {
    if (!div.classList.contains("thinking-finished")) return;
    div.dataset.userToggled = "true";
    div.classList.toggle("expanded");
  });
}

// 更新过程记录头部的摘要：一行标题 + 执行记录条数
function updateThinkingSummary(el, status = "done") {
  const count = Math.max(
    el.querySelectorAll(".perm-card").length,
    el.querySelectorAll(".process-step").length,
  );
  const base = status === "error" ? "执行中断" : "过程记录";
  const timeEl = el.querySelector(".msg-time");
  if (timeEl) timeEl.textContent = count > 0 ? `${base} · ${count} 条执行记录` : base;
  const arrow = el.querySelector(".thinking-toggle-arrow");
  if (arrow) arrow.style.display = "";
}

// 历史渲染专用：直接创建已完成、默认折叠的过程记录容器，
// 让散落的执行记录重新嵌入它内部，位于绑定回复的上方
function showArchivedThinking(character, messageId) {
  const existing = document.getElementById(`thinking-${character}-${messageId}`)
    || (messageId && $messages.querySelector(`[id^="thinking-archive-${character}-${messageId}-"]`));
  if (existing) return existing;

  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);

  const div = document.createElement("div");
  div.className = `message assistant thinking-finished ${charClass}`;
  // 直接用归档 id：嵌入回复后仍能按前缀被 findThinkingElement 找到，
  // 且不会和实时 thinking 的 id 冲突
  div.id = `thinking-archive-${character}-${messageId}-${Date.now()}`;
  div.dataset.character = character;
  div.dataset.archived = "true";
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        <span class="msg-time">过程记录</span>
        <svg class="thinking-toggle-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
        <div class="thinking-scroll-area">
          <div class="thinking-live-content">
            <div class="process-log"></div>
            <div class="perm-container"></div>
          </div>
          <details class="thinking-process" hidden>
            <summary>Thinking 过程</summary>
            <div class="thinking-content"></div>
          </details>
        </div>
    </div>
  `;
  bindThinkingHeader(div);
  $messages.appendChild(div);
  return div;
}

function finalizeThinking(character, messageId, status = "done") {
  const el = document.getElementById(`thinking-${character}-${messageId}`);
  if (!el) return;
  const hasPerm = !!el.querySelector(".perm-card");
  const hasStep = !!el.querySelector(".process-step");
  const hasThinking = !!el.querySelector(".thinking-content")?.textContent?.trim();
  if (!hasPerm && !hasStep && !hasThinking) {
    el.remove();
    return;
  }

  el.classList.add("thinking-finished");
  el.dataset.archived = "true";
  el.id = `thinking-archive-${character}-${messageId}-${Date.now()}`;

  // 默认折叠；执行过程中用户手动展开过则保留其状态
  if (el.dataset.userToggled !== "true") el.classList.remove("expanded");
  const thinkingProcess = el.querySelector(".thinking-process");
  if (thinkingProcess) thinkingProcess.open = false;
  updateThinkingSummary(el, status);

  const buttons = el.querySelectorAll(".perm-summary-actions .perm-btn");
  for (const btn of buttons) btn.disabled = true;
}

function appendThinkingContent(container, { text, delta = false }) {
  if (!container || typeof text !== "string" || !text.trim()) return;
  const details = container.querySelector(".thinking-process");
  const content = details?.querySelector(".thinking-content");
  if (!details || !content) return;
  details.hidden = false;
  if (!container.classList.contains("thinking-finished")) details.open = true;
  const separator = content.textContent && !delta ? "\n\n" : "";
  content.appendChild(document.createTextNode(separator + text));
  content.scrollTop = content.scrollHeight;
}

// 把过程记录嵌入到绑定回复内部（回复内容上方），不再另起一行角色记录；
// 同时解决执行期间插入其他消息导致的分离问题
function attachThinkingToReply(character, messageId, replyEl) {
  if (!replyEl || !messageId) return;
  const container = document.querySelector(`[id^="thinking-archive-${character}-${messageId}-"]`)
    || document.getElementById(`thinking-${character}-${messageId}`);
  if (!container) return;
  // 同角色对同父消息产生多条回复时，记录留在先渲染的回复里，不再整块搬移
  if (container.classList.contains("thinking-embed")) return;

  const header = replyEl.querySelector(".bubble-wrapper .msg-header");
  const scrollArea = container.querySelector(".thinking-scroll-area");
  if (!header || !scrollArea) return;

  // 摘要条：箭头 + 标题（标题沿用 .msg-time，方便 updateThinkingSummary 刷新条数）
  const summaryText = container.querySelector(".msg-time")?.textContent || "过程记录";
  const embed = document.createElement("div");
  embed.className = "thinking-embed thinking-finished";
  if (container.id) embed.id = container.id;
  if (container.dataset.character) embed.dataset.character = container.dataset.character;
  if (container.dataset.archived) embed.dataset.archived = container.dataset.archived;
  embed.innerHTML = `
    <div class="thinking-embed-header">
      <svg class="thinking-toggle-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      <span class="msg-time">${escapeHtml(summaryText)}</span>
    </div>
  `;
  embed.appendChild(scrollArea);
  bindThinkingHeader(embed);
  header.after(embed);
  container.remove();
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
    if (input.cwd) {
      detail = `<div class="perm-detail-label">目录</div><div class="perm-desc mono">${escapeHtml(input.cwd)}</div>`;
    }
    detail += `<div class="perm-detail-label">命令</div><pre class="perm-code">${escapeHtml(input.command)}</pre>`;
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

function buildPermCardHtml(requestId, toolName, input) {
  const brief = getPermBrief(toolName, input);
  const intent = getPermIntent(toolName, input);
  const detail = buildPermDetail(toolName, input);
  return `
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
}

// 把一条执行记录嵌入指定的过程记录容器（调用方负责定位容器）
function appendPermRecord(container, { requestId, toolName, input, status = "pending", resolutionMessage }) {
  const brief = getPermBrief(toolName, input);
  const processLog = container.querySelector(".process-log");
  if (processLog) {
    const step = document.createElement("div");
    step.className = "process-step";
    step.textContent = input?.description || `准备调用 ${toolName}：${truncate(brief, 80)}`;
    processLog.appendChild(step);
  }

  const permContainer = container.querySelector(".perm-container");
  if (permContainer) {
    permContainer.insertAdjacentHTML("beforeend", buildPermCardHtml(requestId, toolName, input));
    // 上方实时过程是独立滚动窗口；新步骤到达时只跟随该窗口到底部
    const liveContent = container.querySelector(".thinking-live-content");
    if (liveContent) liveContent.scrollTop = liveContent.scrollHeight;
  }

  if (status && status !== "pending") {
    markPermResolved(requestId, status, resolutionMessage);
  }
}

function showPermissionCard({ requestId, character, toolName, input, timestamp, messageId, status = "pending", resolutionMessage }) {
  const shouldAutoScroll = shouldAutoScrollOnAppend();

  // 用 character + messageId 精确定位 thinking 容器
  const thinkingEl = findThinkingElement(character, messageId);
  if (thinkingEl && thinkingEl.querySelector(".perm-container")) {
    appendPermRecord(thinkingEl, { requestId, toolName, input, status, resolutionMessage });
  } else {
    // 降级：如果找不到 thinking 元素（极端边界情况），独立显示
    const cardHtml = buildPermCardHtml(requestId, toolName, input);
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

    if (status && status !== "pending") {
      markPermResolved(requestId, status, resolutionMessage);
    }
  }

  handlePostAppend({ shouldAutoScroll });
}

// 找到指定角色当前正在显示的 thinking 元素
function findThinkingElement(character, messageId) {
  // 优先按精确 id 定位
  if (messageId) {
    const exact = document.getElementById(`thinking-${character}-${messageId}`);
    if (exact) return exact;
    // 已嵌入回复内部的过程记录（invoke 尚未结束、仍有权限请求到达）
    const embed = $messages.querySelector(`[id^="thinking-archive-${character}-${messageId}-"]`);
    if (embed) return embed;
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
  // 双入口共享同一 requestId：提交期间两处按钮同时禁用
  const actionsEls = [`perm-actions-${requestId}`, `perm-float-actions-${requestId}`]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  floatPermState.submitting.add(requestId);
  for (const el of actionsEls) {
    for (const btn of el.querySelectorAll(".perm-btn")) btn.disabled = true;
    el.querySelector(".perm-send-fail")?.remove();
  }

  let res = null;
  try {
    res = await fetch("/api/permission-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, behavior }),
    });
  } catch {
    res = null;
  }

  if (res?.ok) {
    floatPermState.submitting.delete(requestId);
    markPermResolved(requestId, behavior);
    return;
  }

  if (res?.status === 404) {
    // 另一入口/其他设备已处理或请求已失效：以服务端结果收敛，不作为可重试的待审批
    const data = await res.json().catch(() => null);
    floatPermState.submitting.delete(requestId);
    if (data?.resolved) {
      markPermResolved(requestId, data.resolved.behavior, data.resolved.message);
    } else {
      markPermResolved(requestId, "expired", "请求已失效");
      syncFloatPermsFromServer();
    }
    return;
  }

  // 网络失败：恢复按钮可点并提示重试，卡片保持待审批状态不折叠
  floatPermState.submitting.delete(requestId);
  for (const el of actionsEls) {
    for (const btn of el.querySelectorAll(".perm-btn")) btn.disabled = false;
    el.insertAdjacentHTML("beforeend", '<span class="perm-send-fail" style="color:var(--error-text);font-size:11px;align-self:center">发送失败，请重试</span>');
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

function getToolRecordsDetails(container) {
  const scrollArea = container.querySelector(".thinking-scroll-area");
  if (!scrollArea) return null;
  let details = scrollArea.querySelector(".tool-records");
  if (!details) {
    details = document.createElement("details");
    details.className = "tool-records";
    details.innerHTML = `
      <summary class="tool-records-summary"></summary>
      <div class="tool-records-content"></div>
    `;
    const liveContent = scrollArea.querySelector(".thinking-live-content");
    const permContainer = scrollArea.querySelector(".perm-container");
    if (liveContent) liveContent.after(details);
    else if (permContainer) permContainer.after(details);
    else scrollArea.appendChild(details);
  }
  return details;
}

// 已处理的工具卡片（所有 MCP 工具）移入二级折叠组（默认折叠，类似 Thinking 过程），并刷新条数
function foldResolvedPermCard(card) {
  const scrollArea = card.closest(".thinking-scroll-area");
  if (!scrollArea) return; // 降级独立卡片不折叠
  const details = getToolRecordsDetails(scrollArea.parentElement);
  if (!details) return;
  details.querySelector(".tool-records-content").appendChild(card);
  const count = details.querySelectorAll(".perm-card").length;
  details.querySelector(".tool-records-summary").textContent = `工具执行记录 · ${count} 条`;
}

function markPermResolved(requestId, behavior, message) {
  // 浮层只保留待审批项；执行记录保留"已允许/已拒绝"结果
  removeFloatPerm(requestId);
  const card = document.getElementById(`perm-card-${requestId}`);
  const actionsEl = document.getElementById(`perm-actions-${requestId}`);
  const isAuto = message && message.includes("默认授权");

  if (card) {
    card.classList.remove("expanded");
    card.classList.add("resolved");
    if (isAuto) card.classList.add("auto-resolved");
    // 处理完（允许/拒绝）即归入二级折叠；待审批的留在折叠外以便操作
    foldResolvedPermCard(card);
  }

  if (actionsEl) {
    const cls = behavior === "allow" ? "allowed" : behavior === "deny" ? "denied" : "expired";
    const label = behavior === "allow" ? "已允许" : behavior === "deny" ? "已拒绝" : "已处理";
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

// ── 审批浮层（输入框上方的第二审批入口，与执行记录卡片共享同一 requestId 状态）──
const FLOAT_PERM_MAX = 5;
const floatPermState = {
  items: new Map(),      // requestId -> 待审批数据（含 receivedAt 时钟值，用于快照合并守卫）
  elements: new Map(),   // requestId -> 浮层卡片元素（增量渲染，避免动画重放）
  submitting: new Set(), // 提交中的 requestId，两个入口的按钮同时禁用
  resolutions: new Map(),// requestId -> 已决时的时钟值（旧快照晚到不得放回已决项）
  clock: 0,              // 本地单调递增序号；Date.now() 同毫秒相等，不能作为事件顺序
  lastAppliedSyncSeq: 0, // 已应用的最新快照序号；更早发起的快照响应乱序晚到时丢弃
  pageOffset: 0,         // 0 = 最新一批；按 FLOAT_PERM_MAX 分批向较早翻页
};

function addFloatPerm(data) {
  // 只有手动待审批进浮层；自动通过/已决的记录仍只留在执行记录里
  if (!data?.requestId || (data.status && data.status !== "pending")) return;
  if (floatPermState.items.has(data.requestId)) return;
  floatPermState.items.set(data.requestId, { ...data, receivedAt: ++floatPermState.clock });
  renderFloatLayer();
}

function removeFloatPerm(requestId) {
  // 先记已决时钟再删卡片：即使项尚未进浮层，晚到的旧快照也不能把它放回来
  floatPermState.resolutions.set(requestId, ++floatPermState.clock);
  if (floatPermState.resolutions.size > 200) {
    floatPermState.resolutions.delete(floatPermState.resolutions.keys().next().value);
  }
  if (!floatPermState.items.has(requestId)) return;
  floatPermState.items.delete(requestId);
  floatPermState.submitting.delete(requestId);
  const el = floatPermState.elements.get(requestId);
  if (el) { el.remove(); floatPermState.elements.delete(requestId); }
  renderFloatLayer();
}

function clearFloatPerms() {
  floatPermState.items.clear();
  floatPermState.submitting.clear();
  floatPermState.pageOffset = 0;
  for (const el of floatPermState.elements.values()) el.remove();
  floatPermState.elements.clear();
  renderFloatLayer();
}

// 以服务端 pendingPermissions 快照为权威合并：移除已不存在的，补上遗漏的。
// syncSeq 是快照请求发起时的时钟值：之后收到的 SSE 新项不参与移除判定，
// 之后到达终态（removeFloatPerm 记录）的项不参与补入判定，避免旧快照回灌。
function syncFloatPerms(pendingList, syncSeq = ++floatPermState.clock) {
  // 并发快照乱序返回：已有更新的快照应用过时，更早发起的响应整体丢弃
  if (syncSeq < floatPermState.lastAppliedSyncSeq) return;
  floatPermState.lastAppliedSyncSeq = syncSeq;
  const server = new Map((pendingList || []).map((p) => [p.requestId, p]));
  for (const [id, item] of floatPermState.items) {
    if (!server.has(id) && (item.receivedAt || 0) < syncSeq) {
      floatPermState.items.delete(id);
      floatPermState.elements.get(id)?.remove();
      floatPermState.elements.delete(id);
    }
  }
  for (const [id, p] of server) {
    if (floatPermState.items.has(id)) continue;
    const resolvedSeq = floatPermState.resolutions.get(id);
    if (resolvedSeq !== undefined && resolvedSeq > syncSeq) continue;
    floatPermState.items.set(id, { ...p, receivedAt: ++floatPermState.clock });
  }
  renderFloatLayer();
}

async function syncFloatPermsFromServer() {
  const forSessionId = state.sessionId;
  if (!forSessionId) return;
  const syncSeq = ++floatPermState.clock;
  try {
    const res = await fetch(`/api/pending-permissions?sessionId=${encodeURIComponent(forSessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (state.sessionId !== forSessionId) return;
    syncFloatPerms(data.pending, syncSeq);
  } catch {
    // 快照失败时保留现有浮层，等待 SSE 事件继续驱动
  }
}

function buildFloatPermCard(item) {
  const { requestId, character, toolName, input, timestamp } = item;
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const brief = getPermBrief(toolName, input);
  const intent = getPermIntent(toolName, input);
  const detail = buildPermDetail(toolName, input);
  const el = document.createElement("div");
  el.className = "perm-float-card";
  el.id = `perm-float-${requestId}`;
  el.dataset.requestId = requestId;
  el.innerHTML = `
    <div class="perm-float-main">
      <div class="perm-float-head" onclick="toggleFloatPermDetail('${requestId}')" title="展开详情">
        <span class="perm-float-avatar ${charClass}">${escapeHtml(avatar)}</span>
        <span class="perm-float-char">${escapeHtml(displayName)}</span>
        <span class="perm-summary-tool">${escapeHtml(toolName)}</span>
        <span class="perm-summary-brief">${escapeHtml(truncate(brief, 60))}</span>
        <span class="perm-float-wait" data-since="${timestamp || Date.now()}"></span>
        <svg class="perm-expand-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="perm-summary-actions perm-float-actions" id="perm-float-actions-${requestId}">
        <button class="perm-btn perm-deny" onclick="event.stopPropagation(); respondPermission('${requestId}', 'deny')">拒绝</button>
        <button class="perm-btn perm-allow" onclick="event.stopPropagation(); respondPermission('${requestId}', 'allow')">允许</button>
      </div>
    </div>
    <div class="perm-float-detail">
      <div class="perm-intent">${escapeHtml(intent)}</div>
      ${detail}
    </div>
  `;
  if (floatPermState.submitting.has(requestId)) {
    for (const btn of el.querySelectorAll(".perm-btn")) btn.disabled = true;
  }
  return el;
}

function toggleFloatPermDetail(requestId) {
  floatPermState.elements.get(requestId)?.classList.toggle("expanded");
}

function renderFloatLayer() {
  if (!$permFloatLayer) return;
  const items = [...floatPermState.items.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const total = items.length;
  // 同屏最多 5 张：默认显示最新一批，溢出的按每批 5 张向较早翻页
  const maxPage = Math.max(0, Math.ceil(total / FLOAT_PERM_MAX) - 1);
  if (floatPermState.pageOffset > maxPage) floatPermState.pageOffset = maxPage;
  const pageOffset = floatPermState.pageOffset;
  const end = total - FLOAT_PERM_MAX * pageOffset;
  const start = Math.max(0, end - FLOAT_PERM_MAX);
  const visible = items.slice(start, end);
  const olderCount = start;
  const newerCount = total - end;

  $permFloatLayer.classList.toggle("hidden", total === 0);

  let chipRow = $permFloatLayer.querySelector(".perm-float-chips");
  if (olderCount > 0 || pageOffset > 0) {
    if (!chipRow) {
      chipRow = document.createElement("div");
      chipRow.className = "perm-float-chips";
      chipRow.innerHTML = `
        <button type="button" class="perm-float-overflow perm-float-older" hidden></button>
        <button type="button" class="perm-float-overflow perm-float-newer" hidden></button>
      `;
      chipRow.querySelector(".perm-float-older").addEventListener("click", () => {
        floatPermState.pageOffset += 1;
        renderFloatLayer();
      });
      chipRow.querySelector(".perm-float-newer").addEventListener("click", () => {
        floatPermState.pageOffset = 0;
        renderFloatLayer();
      });
      $permFloatLayer.prepend(chipRow);
    }
    const olderBtn = chipRow.querySelector(".perm-float-older");
    const newerBtn = chipRow.querySelector(".perm-float-newer");
    olderBtn.hidden = olderCount === 0;
    olderBtn.textContent = `另有 ${olderCount} 项待审批，点击查看较早`;
    newerBtn.hidden = pageOffset === 0;
    newerBtn.textContent = `返回最新 ${Math.min(FLOAT_PERM_MAX, total)} 项`;
  } else if (chipRow) {
    chipRow.remove();
  }

  const visibleIds = new Set(visible.map((i) => i.requestId));
  for (const [id, el] of floatPermState.elements) {
    if (!visibleIds.has(id)) { el.remove(); floatPermState.elements.delete(id); }
  }
  for (const item of visible) {
    let el = floatPermState.elements.get(item.requestId);
    if (!el) {
      el = buildFloatPermCard(item);
      floatPermState.elements.set(item.requestId, el);
    }
    // 按时间序 append：已存在的节点仅移动位置，不会重放入场动画
    $permFloatLayer.appendChild(el);
  }
  updateFloatWaitTimes();
}

function formatWaitDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}

function updateFloatWaitTimes() {
  if (!$permFloatLayer || floatPermState.items.size === 0) return;
  const now = Date.now();
  for (const el of $permFloatLayer.querySelectorAll(".perm-float-wait")) {
    const since = Number(el.dataset.since) || now;
    el.textContent = `等待 ${formatWaitDuration(now - since)}`;
  }
}

function setupPermFloatLayer() {
  if (!$permFloatLayer) return;
  const inputArea = document.getElementById("input-area");
  const place = () => {
    $permFloatLayer.style.bottom = `${inputArea.offsetHeight + 10}px`;
  };
  place();
  new ResizeObserver(place).observe(inputArea);
  setInterval(updateFloatWaitTimes, 1000);
}

// ── 文件修改 Diff（聚合编辑类工具的成功执行结果）────────────
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function changeFilePath(rec) {
  return rec.execution?.filePath
    || (rec.toolName === "NotebookEdit" ? rec.input?.notebook_path : rec.input?.file_path)
    || null;
}

// 仅计入获批且执行成功的记录；before===after 的无变化操作不进入目录
function recordFileChange(rec) {
  if (!rec || !rec.character || !rec.messageId) return;
  if (!FILE_EDIT_TOOLS.has(rec.toolName)) return;
  const exec = rec.execution;
  if (!exec || exec.status !== "success") return;
  const filePath = changeFilePath(rec);
  if (!filePath) return;
  // 工具侧 hash 判定的无变化操作（含 oversized 大文件）不计入
  if (exec.changed === false) return;
  if (exec.diffAvailable && exec.before === exec.after) return;
  const key = `${rec.character}|${rec.messageId}`;
  if (!state.fileChanges[key]) state.fileChanges[key] = {};
  const files = state.fileChanges[key];
  if (!files[filePath]) files[filePath] = [];
  files[filePath].push({
    requestId: rec.requestId || rec.id,
    toolName: rec.toolName,
    input: rec.input,
    timestamp: rec.timestamp,
    execution: exec,
  });
  // 基线顺序（完成时间 → 回报序号）：真实先后由 orderFileChanges 按快照连续性重建，
  // 这里只保证实时（事件到达序）与历史（日志请求序）拿到同一份稳定输入
  files[filePath].sort((a, b) => (a.execution?.finishedAt ?? 0) - (b.execution?.finishedAt ?? 0)
    || (a.execution?.seq ?? 0) - (b.execution?.seq ?? 0));
}

// 行拆分：末尾换行不算独立行；空文件/缺失文件为零行
// eol: true=以换行结尾 / false=末尾无换行 / null=文件不存在
function splitDiffLines(text) {
  if (text == null) return { lines: [], eol: null };
  if (text === "") return { lines: [], eol: true };
  const eol = text.endsWith("\n");
  return { lines: (eol ? text.slice(0, -1) : text).split("\n"), eol };
}

const MAX_DIFF_MATRIX_CELLS = 10000000;
const MAX_DIFF_LINE_PAIRS = 10000 * 10000;
const MAX_SPARSE_MATCH_PAIRS = 250000;
const MAX_DENSE_DIFF_MS = 1000;

// 稀疏匹配用 Hunt–Szymanski 重建精确 LCS；常见的大文件编辑无需扫描整张矩阵。
function appendSparseDiff(a, aStart, aEnd, b, bStart, bEnd, lines) {
  const positions = new Map();
  for (let j = bStart; j < bEnd; j++) {
    if (!positions.has(b[j])) positions.set(b[j], []);
    positions.get(b[j]).push(j);
  }
  let pairCount = 0;
  for (let i = aStart; i < aEnd; i++) {
    pairCount += positions.get(a[i])?.length || 0;
    if (pairCount > MAX_SPARSE_MATCH_PAIRS) return false;
  }

  const tails = [];
  const nodes = [];
  for (let i = aStart; i < aEnd; i++) {
    const matches = positions.get(a[i]);
    if (!matches) continue;
    for (let k = matches.length - 1; k >= 0; k--) {
      const j = matches[k];
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (tails[middle] < j) low = middle + 1;
        else high = middle;
      }
      if (tails[low] === j) continue;
      const node = { oldIndex: i, newIndex: j, previous: low > 0 ? nodes[low - 1] : null };
      tails[low] = j;
      nodes[low] = node;
    }
  }

  const common = [];
  for (let node = nodes[nodes.length - 1]; node; node = node.previous) common.push(node);
  common.reverse();
  let oldIndex = aStart;
  let newIndex = bStart;
  for (const match of common) {
    while (oldIndex < match.oldIndex) lines.push({ type: "del", text: a[oldIndex++] });
    while (newIndex < match.newIndex) lines.push({ type: "add", text: b[newIndex++] });
    lines.push({ type: "ctx", text: a[oldIndex] });
    oldIndex++;
    newIndex++;
  }
  while (oldIndex < aEnd) lines.push({ type: "del", text: a[oldIndex++] });
  while (newIndex < bEnd) lines.push({ type: "add", text: b[newIndex++] });
  return true;
}

// 高重复内容用 Hirschberg 保留精确结果；超时则降级，避免阻塞页面。
const DIFF_TIME_LIMIT = Symbol("diff time limit");
function appendLinearSpaceDiff(a, aStart, aEnd, b, bStart, bEnd, lines, deadline) {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0) {
    for (let j = bStart; j < bEnd; j++) lines.push({ type: "add", text: b[j] });
    return;
  }
  if (m === 0) {
    for (let i = aStart; i < aEnd; i++) lines.push({ type: "del", text: a[i] });
    return;
  }
  if (n === 1) {
    let match = bStart;
    while (match < bEnd && a[aStart] !== b[match]) match++;
    if (match === bEnd) {
      lines.push({ type: "del", text: a[aStart] });
      for (let j = bStart; j < bEnd; j++) lines.push({ type: "add", text: b[j] });
    } else {
      for (let j = bStart; j < match; j++) lines.push({ type: "add", text: b[j] });
      lines.push({ type: "ctx", text: a[aStart] });
      for (let j = match + 1; j < bEnd; j++) lines.push({ type: "add", text: b[j] });
    }
    return;
  }

  const middle = aStart + Math.floor(n / 2);
  const lengths = (start, end, reverseA, reverseB) => {
    let previous = new Uint32Array(m + 1);
    let current = new Uint32Array(m + 1);
    for (let i = 0; i < end - start; i++) {
      if ((i & 63) === 0 && Date.now() > deadline) throw DIFF_TIME_LIMIT;
      const aLine = a[reverseA ? end - 1 - i : start + i];
      for (let j = 1; j <= m; j++) {
        const bLine = b[reverseB ? bEnd - j : bStart + j - 1];
        current[j] = aLine === bLine
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
      }
      [previous, current] = [current, previous];
    }
    return previous;
  };
  const left = lengths(aStart, middle, false, false);
  const right = lengths(middle, aEnd, true, true);
  let split = 0;
  let best = -1;
  for (let j = 0; j <= m; j++) {
    const score = left[j] + right[m - j];
    if (score > best) { best = score; split = j; }
  }
  appendLinearSpaceDiff(a, aStart, middle, b, bStart, bStart + split, lines, deadline);
  appendLinearSpaceDiff(a, middle, aEnd, b, bStart + split, bEnd, lines, deadline);
}

// 行级 diff：先剔除相同前后缀；变化区小则用矩阵，大则优先稀疏匹配并限时尝试线性内存 LCS。
// 变化区上限为 10000×10000 行对；末尾换行变化用 meta 行表示（不计入 +/-）。
function computeLineDiff(oldText, newText) {
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  const oldLines = a.lines;
  const newLines = b.lines;
  const n = oldLines.length;
  const m = newLines.length;
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = n;
  let newEnd = m;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldCount = oldEnd - prefix;
  const newCount = newEnd - prefix;
  if (oldCount * newCount > MAX_DIFF_LINE_PAIRS) {
    return { lines: null, degraded: true, reason: "size" };
  }

  const lines = [];
  for (let i = 0; i < prefix; i++) lines.push({ type: "ctx", text: oldLines[i] });
  if ((oldCount + 1) * (newCount + 1) > MAX_DIFF_MATRIX_CELLS) {
    if (!appendSparseDiff(oldLines, prefix, oldEnd, newLines, prefix, newEnd, lines)) {
      try {
        appendLinearSpaceDiff(oldLines, prefix, oldEnd, newLines, prefix, newEnd, lines, Date.now() + MAX_DENSE_DIFF_MS);
      } catch (error) {
        if (error === DIFF_TIME_LIMIT) return { lines: null, degraded: true, reason: "time" };
        throw error;
      }
    }
  } else {
    const dp = Array.from({ length: oldCount + 1 }, () => new Uint32Array(newCount + 1));
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        dp[i][j] = oldLines[prefix + i] === newLines[prefix + j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldCount && j < newCount) {
      if (oldLines[prefix + i] === newLines[prefix + j]) {
        lines.push({ type: "ctx", text: oldLines[prefix + i] }); i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ type: "del", text: oldLines[prefix + i] }); i++;
      } else {
        lines.push({ type: "add", text: newLines[prefix + j] }); j++;
      }
    }
    while (i < oldCount) { lines.push({ type: "del", text: oldLines[prefix + i] }); i++; }
    while (j < newCount) { lines.push({ type: "add", text: newLines[prefix + j] }); j++; }
  }
  for (let i = oldEnd; i < n; i++) lines.push({ type: "ctx", text: oldLines[i] });
  if (n > 0 && a.eol === false && b.eol !== false) {
    lines.push({ type: "meta", text: "\\ 修改前文件末尾无换行" });
  }
  if (m > 0 && b.eol === false && a.eol !== false) {
    lines.push({ type: "meta", text: "\\ 修改后文件末尾无换行" });
  }
  return { lines, degraded: false };
}

function diffStatLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.lines || []) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}

// 同文件修改顺序不能依赖 seq（那是"回报到达序"，并发工具的回报可能倒序）。
// 以快照连续性重建唯一链：每个 before/after 状态只出现一次时链可确定；
// 出现重复状态或成环则顺序不可判定，标为 orderUnknown —— 宁可不出净 Diff，也不给虚假合计。
function orderFileChanges(changes) {
  const cmpBaseline = (a, b) => {
    const ta = a.execution?.finishedAt ?? 0;
    const tb = b.execution?.finishedAt ?? 0;
    return ta - tb || (a.execution?.seq ?? 0) - (b.execution?.seq ?? 0);
  };
  const snapped = changes.filter((c) => c.execution?.diffAvailable);
  if (snapped.length <= 1) return { ordered: changes, orderUnknown: false };

  const byBefore = new Map();
  const byAfter = new Map();
  for (const c of snapped) {
    if (byBefore.has(c.execution.before) || byAfter.has(c.execution.after)) {
      return { ordered: changes, orderUnknown: true };
    }
    byBefore.set(c.execution.before, c);
    byAfter.set(c.execution.after, c);
  }

  const chains = [];
  const chained = new Set();
  for (const c of snapped) {
    if (byAfter.has(c.execution.before)) continue; // 有前驱，不是链首
    const chain = [];
    let cur = c;
    while (cur && !chained.has(cur)) {
      chain.push(cur);
      chained.add(cur);
      cur = byBefore.get(cur.execution.after);
    }
    chains.push(chain);
  }
  if (chained.size !== snapped.length) return { ordered: changes, orderUnknown: true }; // 成环

  // 链之间内容不连续（存在范围外修改），彼此先后只影响展示顺序，用完成时间做提示性排序
  chains.sort((x, y) => cmpBaseline(x[0], y[0]));
  const queue = chains.flat();
  const ordered = [];
  for (const c of [...changes].sort(cmpBaseline)) {
    ordered.push(c.execution?.diffAvailable ? queue.shift() : c);
  }
  return { ordered, orderUnknown: false };
}

// 逐对校验快照连续性（prev.after === next.before），不连续拆段；
// 无快照（oversized 等）的操作是断点，计入 uncovered
function buildFileDiffSegments(changes) {
  const segments = [];
  let current = null;
  let uncovered = 0;
  for (let idx = 0; idx < changes.length; idx++) {
    const exec = changes[idx].execution;
    if (!exec || !exec.diffAvailable) {
      uncovered++;
      if (current) { segments.push(current); current = null; }
      continue;
    }
    if (current && current.lastAfter === exec.before) {
      current.changes.push(idx);
      current.after = exec.after;
      current.lastAfter = exec.after;
    } else {
      if (current) segments.push(current);
      current = { before: exec.before, after: exec.after, lastAfter: exec.after, changes: [idx] };
    }
  }
  if (current) segments.push(current);
  return { segments, complete: segments.length === 1 && uncovered === 0, uncovered };
}

function summarizeFileChanges(changes) {
  const { ordered, orderUnknown } = orderFileChanges(changes);
  const uncoveredCount = ordered.filter((c) => !c.execution?.diffAvailable).length;
  if (orderUnknown) {
    return { orderUnknown, segments: [], complete: false, uncovered: uncoveredCount, added: 0, removed: 0, statsKnown: false, count: changes.length };
  }
  const { segments, complete, uncovered } = buildFileDiffSegments(ordered);
  let added = 0;
  let removed = 0;
  const segDiffs = segments.map((seg) => {
    const diff = computeLineDiff(seg.before, seg.after);
    if (!diff.degraded) {
      const s = diffStatLines(diff);
      added += s.added;
      removed += s.removed;
    }
    return { seg, diff };
  });
  const statsKnown = segDiffs.length > 0 && uncovered === 0 && segDiffs.every((s) => !s.diff.degraded);
  return { orderUnknown, segments: segDiffs, complete, uncovered, added, removed, statsKnown, count: changes.length };
}

function shortenFilePath(filePath) {
  const wd = state.sessionMeta?.workingDirectory;
  if (wd && filePath.startsWith(wd + "/")) return filePath.slice(wd.length + 1);
  return filePath;
}

// 目录渲染（幂等 upsert）：插入 bubble-wrapper 末尾（.msg-model 之后）
function renderFileDiffDirectory(character, messageId, replyEl) {
  if (!replyEl || !character || !messageId) return;
  const wrapper = replyEl.querySelector(".bubble-wrapper");
  if (!wrapper) return;
  wrapper.querySelector(".file-diff-dir")?.remove();
  const files = state.fileChanges[`${character}|${messageId}`];
  if (!files || Object.keys(files).length === 0) return;

  const dir = document.createElement("div");
  dir.className = "file-diff-dir";
  const title = document.createElement("div");
  title.className = "file-diff-dir-title";
  title.textContent = `已记录的文件修改 · ${Object.keys(files).length} 个`;
  dir.appendChild(title);

  const list = document.createElement("div");
  list.className = "file-diff-list";
  for (const filePath of Object.keys(files)) {
    const changes = files[filePath];
    const summary = summarizeFileChanges(changes);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "file-diff-item";
    item.title = filePath;
    const statHtml = summary.orderUnknown
      ? `<span class="file-diff-unknown">顺序未知</span>`
      : summary.statsKnown
      ? `<span class="file-diff-add">+${summary.added}</span> <span class="file-diff-del">-${summary.removed}</span>`
      : `<span class="file-diff-unknown">增删未知</span>`;
    // 有无快照记录时，分段只是基线排序的推断（其位置不可证），不能当结论展示
    const segLabel = summary.uncovered === 0 && summary.segments.length > 1 ? " · 分段" : "";
    item.innerHTML = `
      <span class="file-diff-path">${escapeHtml(shortenFilePath(filePath))}</span>
      <span class="file-diff-stat">${statHtml}<span class="file-diff-times">${changes.length} 次${segLabel}</span></span>
    `;
    item.addEventListener("click", () => openDiffPanel(character, messageId, filePath));
    list.appendChild(item);
  }
  dir.appendChild(list);
  wrapper.appendChild(dir);
}

// 执行结果晚于回复到达时补挂/刷新目录
function refreshFileDiffDirectory(character, messageId) {
  if (!character || !messageId) return;
  const replyId = state.replyByThinking[`${character}|${messageId}`];
  if (!replyId) return;
  renderFileDiffDirectory(character, messageId, state.messageElements[replyId]);
}

let $diffRail = null;
let _railResizeFrame = null;

function setupDiffPanel() {
  $diffCloseBtn.addEventListener("click", closeDiffPanel);
  $diffNavPrev.addEventListener("click", () => gotoDiffHunk((_diffNav?.index ?? 0) - 1));
  $diffNavNext.addEventListener("click", () => gotoDiffHunk((_diffNav?.index ?? 0) + 1));
  $diffRail = document.createElement("div");
  $diffRail.className = "diff-rail";
  $diffRail.hidden = true;
  $diffPanel.appendChild($diffRail);
  // 左缘拖动调宽：面板右缘贴着视口右边，宽度 = 视口宽 - 指针横坐标；
  // 宽度只写内联 style，CSS 的 max-width: 96vw 仍是上限
  let resizeDrag = null;
  $diffResizeHandle.addEventListener("mousedown", (e) => {
    resizeDrag = true;
    $diffResizeHandle.classList.add("active");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizeDrag) return;
    const width = Math.max(DIFF_PANEL_MIN_WIDTH, Math.round(window.innerWidth - e.clientX));
    $diffPanel.style.width = `${width}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!resizeDrag) return;
    resizeDrag = null;
    $diffResizeHandle.classList.remove("active");
    document.body.style.userSelect = "";
    // 宽度变化后长行换行改变、刻度比例失真，松手后按新布局重算一次（保留 scrollTop）
    if ($diffPanel.classList.contains("open")) rebuildDiffNav();
  });
  // resize 连续触发，刻度按布局比例定位必须重算；用 rAF 合并成一帧一次
  window.addEventListener("resize", () => {
    if (_railResizeFrame) return;
    _railResizeFrame = requestAnimationFrame(() => {
      _railResizeFrame = null;
      rebuildDiffNav();
    });
  });
}

let _closeDiffTimer = null;
// 打开面板的构建回调排队在 rAF 里，同一帧内连续打开/关闭必须只让最后一次生效
let _diffNavFrame = null;
let _diffOpenGen = 0;

// 单个 diff 块的渲染行数预算：LCS 单元格上限拦不住"窄而长"的内容
// （如 4 万个空行只产生 1×40001 矩阵），不限量会同步创建数万节点卡住面板
const MAX_DIFF_RENDER_LINES = 12000;
// 面板级总预算：单块上限拦不住"多段"场景（60 段 × 12000 行可达 72 万节点）
const MAX_PANEL_RENDER_LINES = 20000;

// 左缘拖动调宽的下限：再窄行号列 + 代码就没法看了
const DIFF_PANEL_MIN_WIDTH = 420;

function buildDiffCodeBlock(diff, budget) {
  const body = document.createElement("div");
  body.className = "diff-code";
  if (diff.degraded || !diff.lines) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = diff.reason === "time"
      ? "未计算行级 Diff（计算耗时过长）"
      : "未计算行级 Diff（内容过大）";
    body.appendChild(note);
    return body;
  }
  if (diff.lines.length === 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = "(无内容变化)";
    body.appendChild(note);
    return body;
  }
  const cap = budget ? Math.min(MAX_DIFF_RENDER_LINES, budget.left) : MAX_DIFF_RENDER_LINES;
  const shown = Math.max(0, Math.min(diff.lines.length, cap));
  for (let i = 0; i < shown; i++) {
    const line = diff.lines[i];
    const el = document.createElement("div");
    el.className = `diff-line ${line.type}`;
    if (line.type === "meta") {
      el.textContent = line.text;
    } else {
      const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
      el.textContent = `${sign} ${line.text}`;
    }
    body.appendChild(el);
  }
  if (budget) budget.left -= shown;
  body.renderedLines = shown;
  // 预算耗尽的块只剩一行提示，给它撑最小高度会堆出大片空白滚动区
  if (shown > 0) body.classList.add("has-lines");
  if (diff.lines.length > shown) {
    // 单块上限与面板预算耗尽是两种不同原因，提示必须分开说
    const blockOnly = Math.min(diff.lines.length, MAX_DIFF_RENDER_LINES);
    const byPanel = budget && shown < blockOnly;
    body.truncatedBy = byPanel ? "panel" : "block";
    const note = document.createElement("div");
    note.className = "diff-note";
    if (byPanel) {
      note.textContent = shown === 0
        ? `未渲染该块（共 ${diff.lines.length} 行）：已达到面板渲染总行数上限 ${MAX_PANEL_RENDER_LINES}`
        : `仅渲染前 ${shown} 行（共 ${diff.lines.length} 行）：面板渲染总行数上限 ${MAX_PANEL_RENDER_LINES} 已用尽`;
    } else {
      note.textContent = `仅渲染前 ${shown} 行（共 ${diff.lines.length} 行）：单个 diff 块最多渲染 ${MAX_DIFF_RENDER_LINES} 行，其余未显示以避免界面卡顿`;
    }
    body.appendChild(note);
  }
  return body;
}

// 面板内容是唯一的纵向滚动轨道（代码块不再自己滚），目标行位置 = 代码块偏移 + 行内偏移
function centerDiffLine(container, target) {
  const code = target?.closest?.(".diff-code");
  if (!container || !target || !code) return null;
  const viewH = container.clientHeight || 0;
  if (viewH <= 0) return { code, target, top: null };
  const lineH = target.offsetHeight || 0;
  const top = (code.offsetTop || 0) + (target.offsetTop || 0);
  container.scrollTop = Math.max(0, top - Math.max(0, (viewH - lineH) / 2));
  return { code, target, top };
}

// 概览刻度轨：把每处修改按内容比例画在面板右侧（含当前视口位置），点击即跳转，
// 配「上一处 / i/N / 下一处」工具条。上千行上下文里只靠滚动条找不到下一处修改。
const MAX_RAIL_TICKS = 400;

function diffLineKind(line) {
  if (line.classList.contains("del")) return "del";
  if (line.classList.contains("add")) return "add";
  if (line.classList.contains("meta")) return "meta";
  return null;
}

// 连续的增/删/meta 行算一处修改；跨片段按面板顺序收集，所以跳转天然跨片段
function collectDiffHunks(container) {
  const hunks = [];
  for (const code of container.querySelectorAll(".diff-code.has-lines")) {
    let current = null;
    for (const line of code.querySelectorAll(".diff-line")) {
      const kind = diffLineKind(line);
      if (!kind) { current = null; continue; }
      if (current) { current.lines.push(line); current.last = line; continue; }
      current = { kind, code, first: line, last: line, lines: [line] };
      hunks.push(current);
    }
  }
  return hunks;
}

// 交替修改可能产生上千处，刻度节点必须有上界：超限时按顺序合并成等大的组
function groupHunksForRail(hunks, maxTicks = MAX_RAIL_TICKS) {
  if (hunks.length <= maxTicks) {
    return hunks.map((hunk, i) => ({ start: i, end: i, kind: hunk.kind }));
  }
  const per = Math.ceil(hunks.length / maxTicks);
  const groups = [];
  for (let start = 0; start < hunks.length; start += per) {
    const slice = hunks.slice(start, start + per);
    const kinds = new Set(slice.map((hunk) => hunk.kind));
    groups.push({ start, end: start + slice.length - 1, kind: kinds.size === 1 ? slice[0].kind : "mixed" });
  }
  return groups;
}

let _diffNav = null;

function clearDiffNav() {
  const nav = _diffNav;
  _diffNav = null;
  if (!nav) return;
  nav.container.removeEventListener("scroll", nav.onScroll);
  nav.toolbar.hidden = true;
  if (nav.active) for (const line of nav.active.lines) line.classList.remove("diff-current");
  nav.rail.innerHTML = "";
  nav.rail.hidden = true;
}

function setDiffNavIndex(index) {
  const nav = _diffNav;
  if (!nav) return null;
  const next = Math.max(0, Math.min(nav.hunks.length - 1, index));
  if (nav.active) for (const line of nav.active.lines) line.classList.remove("diff-current");
  nav.index = next;
  nav.active = nav.hunks[next];
  for (const line of nav.active.lines) line.classList.add("diff-current");
  nav.counter.textContent = `${next + 1}/${nav.hunks.length}`;
  nav.ticks.forEach((tick, i) => {
    const group = nav.groups[i];
    tick.classList.toggle("active", next >= group.start && next <= group.end);
  });
  return next;
}

function gotoDiffHunk(index) {
  const nav = _diffNav;
  if (!nav) return null;
  const next = Math.max(0, Math.min(nav.hunks.length - 1, index));
  centerDiffLine(nav.container, nav.hunks[next].first);
  return setDiffNavIndex(next);
}

// 滚动时同步当前处序号与视口指示器：以面板视口中线为准，取最后一个已越过中线的修改处
function syncDiffNavToScroll() {
  const nav = _diffNav;
  if (!nav) return;
  const { container, scale, viewport, tops } = nav;
  const scrollH = container.scrollHeight || 0;
  if (scrollH <= 0 || scale <= 0) return;
  viewport.style.top = `${container.scrollTop * scale}px`;
  viewport.style.height = `${Math.max(8, (container.clientHeight || 0) * scale)}px`;
  const middle = container.scrollTop + (container.clientHeight || 0) / 2;
  let index = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] > middle) break;
    index = i;
  }
  if (index !== nav.index) setDiffNavIndex(index);
}

function buildDiffNav(restoreScrollTop = null) {
  clearDiffNav();
  const container = $diffPanelContent;
  const rail = $diffRail;
  const hunks = collectDiffHunks(container);
  if (hunks.length === 0) { rail.hidden = true; $diffNav.hidden = true; return null; }
  // 上一处/下一处在面板标题行里（index.html），不占内容高度，度量前后都不影响偏移
  $diffNav.hidden = false;

  const scrollH = container.scrollHeight || 0;
  const viewH = container.clientHeight || 0;
  const scale = scrollH > 0 && viewH > 0 ? viewH / scrollH : 0;
  rail.style.top = `${container.offsetTop || 0}px`;
  rail.style.height = `${viewH}px`;
  rail.innerHTML = "";
  rail.hidden = scale <= 0;

  const tops = hunks.map((hunk) => (hunk.code.offsetTop || 0) + (hunk.first.offsetTop || 0));
  const groups = groupHunksForRail(hunks);
  const ticks = groups.map((group) => {
    const last = hunks[group.end];
    const bottom = (last.code.offsetTop || 0) + (last.last.offsetTop || 0) + (last.last.offsetHeight || 0);
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = `diff-rail-tick ${group.kind}`;
    tick.style.top = `${tops[group.start] * scale}px`;
    tick.style.height = `${Math.max(3, (bottom - tops[group.start]) * scale)}px`;
    tick.title = group.start === group.end
      ? `第 ${group.start + 1}/${hunks.length} 处修改，点击定位`
      : `第 ${group.start + 1}–${group.end + 1} 处修改（共 ${hunks.length} 处，刻度已合并），点击定位`;
    tick.addEventListener("click", () => gotoDiffHunk(group.start));
    rail.appendChild(tick);
    return tick;
  });
  const viewport = document.createElement("div");
  viewport.className = "diff-rail-viewport";
  rail.appendChild(viewport);

  let frame = null;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; syncDiffNavToScroll(); });
  };
  container.addEventListener("scroll", onScroll, { passive: true });

  _diffNav = {
    container, rail, viewport, hunks, groups, ticks, tops, scale, onScroll,
    toolbar: $diffNav, prevBtn: $diffNavPrev, nextBtn: $diffNavNext, counter: $diffNavCount,
    index: -1, active: null,
  };

  if (restoreScrollTop != null) {
    container.scrollTop = restoreScrollTop;
    syncDiffNavToScroll();
  } else {
    gotoDiffHunk(0);
  }
  return _diffNav;
}

// 面板宽度/高度变化会改变换行与总高度，刻度比例必须重算，但要把用户留在原处
function rebuildDiffNav() {
  if (!$diffPanel.classList.contains("open") || !_diffNav) return null;
  return buildDiffNav($diffPanelContent.scrollTop);
}

function openDiffPanel(character, messageId, filePath) {
  const changes = state.fileChanges[`${character}|${messageId}`]?.[filePath] || [];
  if (_closeDiffTimer) {
    clearTimeout(_closeDiffTimer);
    _closeDiffTimer = null;
  }
  $diffPanelTitle.textContent = filePath.split("/").pop();
  $diffPanelSub.textContent = filePath;
  clearDiffNav();
  $diffPanelContent.innerHTML = "";

  const summary = summarizeFileChanges(changes);

  if (summary.orderUnknown) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = "同文件多次修改的先后顺序无法确定（快照状态重复或成环），未计算净 Diff 与合计";
    $diffPanelContent.appendChild(note);
  }
  // 只有"单段 + 全部操作都有快照"才配称文件本轮的净变化；
  // 存在无快照记录时其相对写入位置不可证，片段只能标为局部快照，不得暗示最终净变化
  const isNetDiff = summary.segments.length === 1 && summary.uncovered === 0;
  const segBudget = { left: MAX_PANEL_RENDER_LINES };
  let panelTruncated = 0;
  let blockTruncated = 0;
  if (summary.segments.length > 0) {
    const legend = document.createElement("div");
    legend.className = "diff-note diff-legend";
    legend.textContent = "行号：修改前 / 修改后（- 表示该行在对应文件中不存在）";
    $diffPanelContent.appendChild(legend);
  }
  summary.segments.forEach(({ diff }, idx) => {
    const label = document.createElement("div");
    label.className = "diff-seg-label";
    label.textContent = isNetDiff
      ? "净 Diff"
      : summary.uncovered > 0
      ? `局部快照片段 · 段 ${idx + 1}/${summary.segments.length}（该文件另有 ${summary.uncovered} 次修改无可用快照，相对位置不可证，不代表文件最终净变化）`
      : `净 Diff · 段 ${idx + 1}/${summary.segments.length}（段间存在范围外修改，未计入本轮工具变更）`;
    $diffPanelContent.appendChild(label);
    const block = buildDiffCodeBlock(diff, segBudget);
    if (block.truncatedBy === "panel") panelTruncated += 1;
    else if (block.truncatedBy === "block") blockTruncated += 1;
    $diffPanelContent.appendChild(block);
  });
  if (panelTruncated > 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = `片段区已达到面板渲染总行数上限 ${MAX_PANEL_RENDER_LINES}：${panelTruncated}/${summary.segments.length} 个片段未完整显示`;
    $diffPanelContent.appendChild(note);
  }
  if (blockTruncated > 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = `${blockTruncated}/${summary.segments.length} 个片段由单块渲染上限 ${MAX_DIFF_RENDER_LINES} 行截断`;
    $diffPanelContent.appendChild(note);
  }
  if (summary.uncovered > 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = `${summary.uncovered} 次修改无可用快照（旧记录受 80KB 限制、快照回报被拒、文件不可读或执行后已不存在），未计算行级 Diff；这些记录相对快照链的先后无法证明`;
    $diffPanelContent.appendChild(note);
  }
  if (!summary.orderUnknown && summary.segments.length === 0 && summary.uncovered === 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = "(无可用快照内容)";
    $diffPanelContent.appendChild(note);
  }

  $diffPanel.classList.add("open");
  if (_diffNavFrame) cancelAnimationFrame(_diffNavFrame);
  const gen = ++_diffOpenGen;
  _diffNavFrame = requestAnimationFrame(() => {
    _diffNavFrame = null;
    if (gen !== _diffOpenGen) return;
    // 刻度按布局比例定位，必须等面板 display:flex 之后才有 scrollHeight/clientHeight
    buildDiffNav();
    $diffPanel.classList.add("visible");
  });
}

function closeDiffPanel() {
  // 排队中的构建回调若继续执行，会把刚关掉的面板重新推成 visible
  if (_diffNavFrame) {
    cancelAnimationFrame(_diffNavFrame);
    _diffNavFrame = null;
  }
  _diffOpenGen += 1;
  $diffPanel.classList.remove("visible");
  if (_closeDiffTimer) clearTimeout(_closeDiffTimer);
  _closeDiffTimer = setTimeout(() => {
    $diffPanel.classList.remove("open");
    clearDiffNav();
    _closeDiffTimer = null;
  }, 250);
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

  const memberNames = getSessionMemberNames();
  for (const member of state.sessionMembers) {
    const name = member.name;
    const status = state.charStatus[name] || "online";
    const dotClass = status === "thinking" ? "thinking" : "online";
    const label = status === "thinking" ? "思考中" : "待命";
    const charClass = getCharClass(name);
    const metrics = member.runtimeMetrics || {};
    const cliLabel = member.model ? `${member.cli} · ${member.model}` : member.cli;
    const usageWindows = getUsageWindows(member, metrics);
    const contextTokens = metrics.contextTokens ?? null;

    const usageSection = usageWindows.length > 0 ? `
      <div class="role-card-metrics">
        ${usageWindows.map((win, index) => renderMetricBar(win, index)).join("")}
      </div>
    ` : "";

    const footerSection = member.cli === "qodercn" && contextTokens === null
      ? ""
      : `
      <div class="role-card-footer">
        ${renderCtxBar(contextTokens, member.contextWindow)}
      </div>
    `;

    const div = document.createElement("div");
    div.className = "role-card";
    div.dataset.roleId = member.id;
    div.innerHTML = `
      <div class="role-card-header">
        <div class="status-dot ${dotClass}"></div>
        <span class="role-card-title" style="color: var(--${charClass}-accent)">${escapeHtml(name)}</span>
        <span class="role-card-meta" title="${escapeAttribute(cliLabel)}">${escapeHtml(cliLabel)}</span>
        <span class="role-card-status">${label}</span>
        <button class="btn-remove-member" title="移出会话" data-role-id="${member.id}" data-name="${escapeHtml(name)}">×</button>
      </div>
      ${usageSection}
      ${footerSection}
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
        scheduleSessionRoleCardRefresh();
        setupMentionHints();
      });
      $charStatuses.appendChild(div);
    }
  }
}

function formatTokenK(value) {
  if (value === null || value === undefined) return '--';
  if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(value);
}

function formatBeijingTime(value) {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function formatFullBeijingTime(value) {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

// 角色卡片额度维度由 metrics.usageWindows 驱动，支持任意窗口数量与命名：
// codex/claude = 5h + week，kimi = 5h + month，dsh = 余额充足度，qodercn = 余额 + ctx。
// 第一个窗口有重置时间时展示时间，否则展示维度名；其余窗口展示维度名。
// 旧数据缺 usageWindows 时按
// primary/secondary 兼容还原。
function getUsageWindows(member, metrics) {
  const windows = Array.isArray(metrics.usageWindows) ? metrics.usageWindows : [];
  if (windows.length > 0) return windows;
  const supported = metrics.supportsUsageWindows ?? (member.cli === "codex");
  if (!supported) return [];
  const legacy = [];
  if (metrics.primaryUsedPercent != null || metrics.primaryResetsAt != null) {
    legacy.push({ key: "5h", label: "5h", usedPercent: metrics.primaryUsedPercent ?? null, resetsAt: metrics.primaryResetsAt ?? null });
  }
  if (metrics.secondaryUsedPercent != null || metrics.secondaryResetsAt != null) {
    legacy.push({ key: "week", label: "week", usedPercent: metrics.secondaryUsedPercent ?? null, resetsAt: metrics.secondaryResetsAt ?? null });
  }
  return legacy;
}

// ctx 上下文占用条：橙色进度条，长度 = contextTokens / contextWindow。
// contextWindow 默认 256k，可在设置中按角色调整；无数据时显示 0%（不显示 --）。
function renderCtxBar(contextTokens, contextWindow) {
  const size = Number(contextWindow) > 0 ? Number(contextWindow) : 262144;
  if (contextTokens === null || contextTokens === undefined) {
    return `
      <div class="metric-bar metric-bar-primary">
        <span class="metric-bar-label">ctx</span>
        <div class="metric-bar-track">
          <div class="metric-bar-fill metric-bar-fill-ctx" style="width: 0%"></div>
        </div>
        <span class="metric-bar-value">0%</span>
      </div>
    `;
  }
  const used = Math.max(0, Number(contextTokens) || 0);
  const pct = Math.min(100, Math.round((used / size) * 100));
  return `
    <div class="metric-bar metric-bar-primary">
      <span class="metric-bar-label" title="${escapeHtml(`ctx ${formatTokenK(used)} / ${formatTokenK(size)}`)}">ctx</span>
      <div class="metric-bar-track">
        <div class="metric-bar-fill metric-bar-fill-ctx" style="width: ${pct}%"></div>
      </div>
      <span class="metric-bar-value">${pct}%</span>
    </div>
  `;
}
function renderMetricBar(win, index) {
  const pct = win.usedPercent ?? null;
  const isPrimary = index === 0;
  const variant = isPrimary ? "primary" : "secondary";
  const isCtx = win.key === "ctx";
  const fillVariant = isCtx ? "ctx" : variant;
  const lowClass = !isCtx && pct !== null && pct < 20 ? " metric-bar-fill-low" : "";
  const hasResetTime = win.resetsAt !== null && win.resetsAt !== undefined;
  // 只有 5h 短周期窗口把时间显示在标签位做倒计时（codex key=5h；
  // claude key=primary、label=5h，所以必须判 label 而非 key）；
  // month 等长周期窗口即使居首位且有 resetsAt 也显示维度名，重置时间留在 tooltip。
  const showResetAsLabel = isPrimary && hasResetTime && win.label === "5h";
  const labelText = showResetAsLabel
    ? formatBeijingTime(win.resetsAt)
    : (win.label || win.key || "");
  const labelClass = showResetAsLabel
    ? "metric-bar-label metric-time-label"
    : "metric-bar-label";
  const title = [
    labelText,
    win.detail,
    win.resetsAt != null ? `重置 ${formatFullBeijingTime(win.resetsAt)}` : null,
  ].filter(Boolean).join(" · ");
  return `
    <div class="metric-bar metric-bar-${variant}">
      <span class="${labelClass}" title="${escapeHtml(title)}">${escapeHtml(labelText)}</span>
      <div class="metric-bar-track">
        <div class="metric-bar-fill metric-bar-fill-${fillVariant}${lowClass}" style="width: ${pct !== null ? pct + '%' : '0%'}"></div>
      </div>
      <span class="metric-bar-value">${pct !== null ? pct + '%' : (isCtx ? '0%' : '--')}</span>
    </div>
  `;
}

// ── 右侧栏：统计 ─────────────────────────────────────────
function updateStats(character) {
  state.stats.total++;
  if (!state.stats.byRole[character]) state.stats.byRole[character] = 0;
  state.stats.byRole[character]++;
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
  `;
}

// ── 左侧栏：会话列表 ─────────────────────────────────────
let sessionListLoading = false;
let sessionListRefreshTimer = null;
const groupCollapseOverrides = new Map();
const SESSION_GROUP_DEFAULT_EXPANDED_COUNT = 2;
const expandedSessionGroups = new Set();
const SESSION_GROUP_VISIBLE_COUNT = 5;
const SESSION_GROUP_LIST_VISIBLE_COUNT = 5;
let sessionGroupListExpanded = false;
const OTHER_GROUP_KEY = "__other__";
const GROUP_LIST_MORE_KEY = "__group_list_more__";

function buildSessionGroups(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const trimmed = (s.workingDirectory || "").trim();
    // 根目录 "/" 去尾斜杠后为空串，需保留为有效分组而非归入 Other。
    const dir = trimmed.replace(/\/+$/, "") || (trimmed ? "/" : "");
    const key = dir || OTHER_GROUP_KEY;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        dir,
        name: dir ? (dir.replace(/\/+$/, "").split("/").pop() || dir) : "Other",
        sessions: [],
        lastMessageAt: 0,
      });
    }
    const group = groups.get(key);
    group.sessions.push(s);
    group.lastMessageAt = Math.max(group.lastMessageAt, s.lastMessageAt || 0);
  }
  return [...groups.values()].sort((a, b) => {
    if ((a.key === OTHER_GROUP_KEY) !== (b.key === OTHER_GROUP_KEY)) {
      return a.key === OTHER_GROUP_KEY ? 1 : -1;
    }
    return b.lastMessageAt - a.lastMessageAt;
  });
}

function createSessionGroupHeader(group, collapsed) {
  const header = document.createElement("div");
  header.className = `session-group-header${collapsed ? " collapsed" : ""}`;
  header.title = group.dir || "无工作目录";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  header.dataset.groupKey = group.key;
  header.innerHTML = `
    <span class="session-group-arrow" aria-hidden="true">▾</span>
    <span class="session-group-name">${escapeHtml(group.name)}</span>
    <span class="session-group-count">${group.sessions.length}</span>
    <span class="session-group-add" role="button" tabindex="0" title="在此目录新建对话" aria-label="在 ${escapeAttribute(group.name)} 分组新建对话">+</span>
  `;
  const toggle = () => {
    const nextCollapsed = !collapsed;
    groupCollapseOverrides.set(group.key, nextCollapsed);
    if (nextCollapsed) expandedSessionGroups.delete(group.key);
    loadSessionList();
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  const addBtn = header.querySelector(".session-group-add");
  addBtn.dataset.groupKey = group.key;
  const createInGroup = (e) => {
    e.stopPropagation();
    showNewSessionModal(group.dir);
  };
  addBtn.addEventListener("click", createInGroup);
  addBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      createInGroup(e);
    }
  });
  return header;
}

function createShowMoreButton(group) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "session-group-more";
  btn.textContent = "Show more";
  btn.dataset.groupKey = group.key;
  btn.setAttribute("aria-label", `展开 ${group.name} 分组的剩余对话`);
  const expand = () => {
    expandedSessionGroups.add(group.key);
    loadSessionList();
  };
  btn.addEventListener("click", expand);
  return btn;
}

function createShowMoreGroupsButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "session-group-more session-group-more-root";
  btn.textContent = "Show more";
  btn.dataset.groupKey = GROUP_LIST_MORE_KEY;
  btn.setAttribute("aria-label", "展开剩余会话分组");
  const expand = () => {
    sessionGroupListExpanded = true;
    loadSessionList();
  };
  btn.addEventListener("click", expand);
  return btn;
}

function captureSessionListFocus() {
  const active = document.activeElement;
  if (!active || !$sessionList.contains(active)) return null;
  if (active.classList.contains("session-group-header")) {
    return { type: "header", key: active.dataset.groupKey };
  }
  if (active.classList.contains("session-group-add")) {
    return { type: "add", key: active.dataset.groupKey };
  }
  if (active.classList.contains("session-group-more")) {
    return { type: "more", key: active.dataset.groupKey };
  }
  if (active.classList.contains("session-item")) {
    return { type: "item", key: active.dataset.sessionId };
  }
  return null;
}

function restoreSessionListFocus(focus) {
  if (!focus) return;
  const match = (selector, attr) =>
    [...$sessionList.querySelectorAll(selector)].find((el) => el.dataset[attr] === focus.key);
  let target = null;
  if (focus.type === "header") target = match(".session-group-header", "groupKey");
  else if (focus.type === "item") target = match(".session-item", "sessionId");
  else if (focus.type === "add") {
    const header = match(".session-group-header", "groupKey");
    target = (header && header.querySelector(".session-group-add")) || header;
  } else if (focus.key === GROUP_LIST_MORE_KEY) {
    target = match(".session-group-more", "groupKey");
    if (!target) {
      const headers = [...$sessionList.querySelectorAll(".session-group-header")];
      target = headers[SESSION_GROUP_LIST_VISIBLE_COUNT] || headers[headers.length - 1] || null;
    }
  } else target = match(".session-group-more", "groupKey") || match(".session-group-header", "groupKey");
  if (target) target.focus();
}

function createSessionItem(s) {
  const isCurrent = s.sessionId === state.sessionId;
  const readCount = state.sessionReadCounts?.[s.sessionId] || 0;
  const unreadCount = isCurrent && document.visibilityState !== "hidden"
    ? 0
    : Math.max(0, (s.unreadMessageCount || 0) - readCount);
  const div = document.createElement("div");
  div.className = `session-item${isCurrent ? " active" : ""}`;
  div.dataset.sessionId = s.sessionId;
  const memberNames = Array.isArray(s.memberNames)
    ? s.memberNames
    : Object.entries(state.characters).filter(([, c]) => !c.archived).map(([name]) => name);
  const avatarsHtml = memberNames.map((name) => {
    const cfg = state.characters[name] || {};
    const charClass = getCharClass(name);
    const av = getAvatar(name, cfg.avatar);
    return '<span class="mini-avatar" title="' + escapeAttribute(name) + '" aria-label="' + escapeAttribute(name) + '" style="background:var(--' + charClass + '-accent)">' + escapeHtml(av) + '</span>';
  }).join('');
  const title = s.title || s.sessionId.slice(0, 12);
  const approvalBadge = s.pendingApprovalCount > 0
    ? `<span class="session-approval-badge" role="status" aria-label="${s.pendingApprovalCount} 个任务等待审批" title="${s.pendingApprovalCount} 个任务等待审批">审批</span>`
    : "";
  const taskIndicator = s.activeTaskCount > 0
    ? `<span class="session-task-spinner" role="status" aria-label="${s.activeTaskCount} 个任务执行中" title="${s.activeTaskCount} 个任务执行中"></span>`
    : "";
  const unreadBadge = unreadCount > 0
    ? `<span class="session-unread-badge" aria-label="${unreadCount} 条未读消息" title="${unreadCount} 条未读消息">${unreadCount > 99 ? "99+" : unreadCount}</span>`
    : "";
  div.innerHTML = `
    <div class="session-avatars">${avatarsHtml}</div>
    <div class="session-title-row">
      <div class="session-preview" title="${escapeAttribute(title)}">${escapeHtml(title)}${isCurrent ? " (当前)" : ""}</div>
      <div class="session-indicators">${approvalBadge}${taskIndicator}${unreadBadge}</div>
    </div>
    <div class="session-meta">
      <span>${s.messageCount} 条消息</span>
      <span>${formatTime(s.lastMessageAt)}</span>
    </div>
  `;
  div.addEventListener("click", () => switchSession(s.sessionId));
  return div;
}

function ensureSessionReadCounts(sessions) {
  if (state.sessionReadCounts !== null) return;

  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_READ_COUNTS_KEY));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      state.sessionReadCounts = saved;
      return;
    }
  } catch {
    // 首次启用或旧数据损坏时，以当前消息数建立基线。
  }

  state.sessionReadCounts = Object.fromEntries(
    sessions.map((session) => [session.sessionId, session.unreadMessageCount || 0]),
  );
  persistSessionReadCounts();
}

function persistSessionReadCounts() {
  try {
    localStorage.setItem(SESSION_READ_COUNTS_KEY, JSON.stringify(state.sessionReadCounts || {}));
  } catch {
    // localStorage 不可用时仍可在当前页面周期内维护未读状态。
  }
}

function markSessionRead(sessionId, messageCount) {
  if (!sessionId || state.sessionReadCounts === null) return;
  const nextCount = Math.max(0, Number(messageCount) || 0);
  if ((state.sessionReadCounts[sessionId] || 0) >= nextCount) return;
  state.sessionReadCounts[sessionId] = nextCount;
  persistSessionReadCounts();
}

function startSessionListRefresh() {
  if (sessionListRefreshTimer) clearInterval(sessionListRefreshTimer);
  sessionListRefreshTimer = setInterval(loadSessionList, SESSION_LIST_REFRESH_MS);
}

async function loadSessionList() {
  if (sessionListLoading) return;
  sessionListLoading = true;

  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error("加载会话列表失败");
    const data = await res.json();
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      $sessionList.innerHTML = '<div style="padding:16px;color:var(--text-light);font-size:13px">暂无对话</div>';
      return;
    }

    ensureSessionReadCounts(sessions);
    state.sessionSummaries = Object.fromEntries(sessions.map((session) => [session.sessionId, session]));

    const currentSummary = state.sessionSummaries[state.sessionId];
    if (currentSummary && document.visibilityState !== "hidden") {
      markSessionRead(state.sessionId, currentSummary.unreadMessageCount);
    }

    const listFocus = captureSessionListFocus();
    $sessionList.innerHTML = "";
    const groups = buildSessionGroups(sessions);
    const visibleGroups = sessionGroupListExpanded ? groups : groups.slice(0, SESSION_GROUP_LIST_VISIBLE_COUNT);
    for (const [index, group] of visibleGroups.entries()) {
      const collapsed = groupCollapseOverrides.has(group.key)
        ? groupCollapseOverrides.get(group.key)
        : index >= SESSION_GROUP_DEFAULT_EXPANDED_COUNT;
      $sessionList.appendChild(createSessionGroupHeader(group, collapsed));
      if (collapsed) continue;
      const expanded = expandedSessionGroups.has(group.key);
      const visible = expanded ? group.sessions : group.sessions.slice(0, SESSION_GROUP_VISIBLE_COUNT);
      for (const s of visible) {
        $sessionList.appendChild(createSessionItem(s));
      }
      if (!expanded && group.sessions.length > SESSION_GROUP_VISIBLE_COUNT) {
        $sessionList.appendChild(createShowMoreButton(group));
      }
    }
    if (!sessionGroupListExpanded && groups.length > SESSION_GROUP_LIST_VISIBLE_COUNT) {
      $sessionList.appendChild(createShowMoreGroupsButton());
    }
    restoreSessionListFocus(listFocus);
  } catch {
    // 保留上一次成功渲染的会话列表。
  } finally {
    sessionListLoading = false;
  }
}

async function switchSession(id) {
  state.sessionId = id;
  const summary = state.sessionSummaries[id];
  if (summary) markSessionRead(id, summary.unreadMessageCount);
  sessionStorage.setItem("sessionId", id);
  $sessionDisplay.textContent = id.slice(0, 8) + "...";
  clearUnreadIndicator();
  closeThread();
  closeEventSource();
  state.stats = { total: 0, byRole: {} };
  state.threads = {};
  state.messageElements = {};
  state.fileChanges = {};
  state.permRequestIndex = {};
  state.replyByThinking = {};
  clearFloatPerms();
  closeDiffPanel();

    await loadSessionMeta();
  await loadSessionMembers();
  $messages.innerHTML = `<div id="system-notice" class="system-notice">${buildSystemNoticeHtml()}</div>`;
  renderStats();
  renderCharStatuses();
  scheduleSessionRoleCardRefresh();
  setupMentionHints();
  renderStaticCharacterTexts();
  await loadHistory();
  await loadSessionList();
  await loadSkillTraces();
  connectSSE();
}

function showNewSessionModal(workingDirectory = "") {
  const roles = Object.entries(state.characters).filter(([, cfg]) => !cfg.archived);
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "new-session-modal";
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-panel">
      <h3>新建会话</h3>
      <p class="modal-desc">选择要加入的角色（可在会话中随时邀请/移除）${workingDirectory ? `<br>工作目录：${escapeHtml(workingDirectory)}` : ""}</p>
      <div id="new-session-roles">
        ${roles.map(([name, cfg]) => `
          <label class="role-checkbox">
            <input type="checkbox" value="${cfg.id}" checked>
            <span class="role-check-name">${escapeHtml(name)}</span>
            <span class="role-check-cli">(${cfg.cli})</span>
          </label>
        `).join("")}
      </div>
      <div id="new-session-error" class="settings-error hidden" role="alert"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="new-session-cancel">取消</button>
        <button class="btn-primary" id="new-session-create">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  modal.querySelector("#new-session-cancel").addEventListener("click", () => modal.remove());
  const errEl = modal.querySelector("#new-session-error");
  const createBtn = modal.querySelector("#new-session-create");
  const showErr = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  createBtn.addEventListener("click", async () => {
    const checked = modal.querySelectorAll('input[type="checkbox"]:checked');
    const memberIds = [...checked].map(cb => cb.value);
    const sessionId = crypto.randomUUID();

    createBtn.disabled = true;
    errEl.classList.add("hidden");
    try {
      const createRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, memberIds }),
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        showErr(err.error || "新建会话失败");
        return;
      }
      if (workingDirectory) {
        const patchRes = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workingDirectory }),
        });
        if (!patchRes.ok) {
          const err = await patchRes.json().catch(() => ({}));
          showErr(err.error || "设置工作目录失败");
          return;
        }
      }
    } catch {
      showErr("网络错误，新建会话失败");
      return;
    } finally {
      createBtn.disabled = false;
    }

    modal.remove();
    switchSession(sessionId);
  });
}

// ── 历史记录加载 ──────────────────────────────────────────
async function loadHistory(forSessionId = state.sessionId) {
  try {
    const res = await fetch(`/api/history?sessionId=${forSessionId}`);
    const log = await res.json();
    // 快照返回时若目标会话已切换，丢弃旧快照，避免覆盖新会话已渲染的 DOM
    if (state.sessionId !== forSessionId) return;
    state.lastEventSeq = log.lastSeq || 0;
    // 浮层以服务端内存快照为权威：历史日志中的 pending 不代表仍可审批
    //（服务重启后内存请求已不存在），不能单凭日志重建浮层
    syncFloatPerms(log.pendingApprovals || []);
    if (!log.messages || log.messages.length === 0) return;

    // 与历史同一份快照的"执行中"状态（刷新/切换会话后恢复"处理中"）
    const activeThinkingList = log.activeThinking || [];

    state.isLoadingHistory = true;
    clearUnreadIndicator();
    $messages.innerHTML = "";
    state.stats = { total: 0, byRole: {} };
    state.threads = {};
    state.messageElements = {};
    state.fileChanges = {};
    state.permRequestIndex = {};
    state.replyByThinking = {};
    closeDiffPanel();

    // 第一遍：重建 thread 数据结构
    // 线程根以 id === threadId 为准（服务端以自身 id 开线程）；旧日志缺这条时退化为
    // 该线程第一条召唤消息。同 threadId 的后续消息不得改写 originId，
    // 否则历史里的旧回复会被整体算到最新一条消息头上（计数条与面板都会错配）
    for (const msg of log.messages) {
      if (!msg.threadId || msg.depth > 0) continue;
      const isSelfRoot = msg.id === msg.threadId;
      const hasMentions = Array.isArray(msg.aiMentions) && msg.aiMentions.length > 0;
      if (!isSelfRoot && !hasMentions) continue;
      const existing = state.threads[msg.threadId];
      if (existing && (existing.rootConfirmed || !isSelfRoot)) continue;
      state.threads[msg.threadId] = {
        originId: msg.id,
        originChar: msg.character,
        originText: msg.text,
        replies: existing ? existing.replies : [],
        rootConfirmed: isSelfRoot,
      };
    }
    for (const msg of log.messages) {
      if (msg.threadId && msg.depth > 0 && state.threads[msg.threadId]) {
        // 空文本记录（如协议违规产生的 error）不构成有效回复，不进计数与面板
        if (!String(msg.text || "").trim()) continue;
        state.threads[msg.threadId].replies.push({
          id: msg.id,
          character: msg.character,
          text: msg.text,
          depth: msg.depth,
        });
      }
    }

    // 第二遍：渲染消息
    // 执行记录先按 角色+用户消息 暂存，渲染到绑定的回复/错误消息时
    // 再建容器，保证过程记录紧跟该回复，而不是留在执行期间的原位置；
    // 匹配不到回复的（如执行被中断）按原时间位置渲染
    const pendingPerms = new Map(); // key: character|messageId -> permission/thinking records[]
    const permKey = (character, messageId) => `${character}|${messageId}`;
    const activeKeys = new Set(activeThinkingList.map((t) => permKey(t.character, t.messageId)));
    // 快照 active 且回复已落盘的 key：恢复标记而不是新建空 thinking
    const activeRepliedKeys = new Set();
    const flushPerms = (character, messageId) => {
      if (!messageId) return;
      const records = pendingPerms.get(permKey(character, messageId));
      if (!records) return;
      pendingPerms.delete(permKey(character, messageId));
      const container = showArchivedThinking(character, messageId);
      for (const rec of records) {
        if (rec.role === "thinking") appendThinkingContent(container, rec);
        else appendPermRecord(container, rec);
      }
    };

    // 预判哪些执行记录能匹配到回复/错误消息（replyTo + 角色）；
    // 召唤链的 thread 深层回复同样消费其执行记录
    const replyKeys = new Set();
    for (const msg of log.messages) {
      if (msg.role === "assistant" && msg.replyTo) {
        replyKeys.add(permKey(msg.character, msg.replyTo));
      } else if (msg.role === "error" && msg.replyTo) {
        replyKeys.add(permKey(msg.character, msg.replyTo));
      }
    }

    for (const msg of log.messages) {
      if (msg.role === "user") {
        appendUserMessage(msg.text, msg.timestamp);
      } else if (msg.role === "assistant") {
        if (msg.threadId && msg.depth > 0) {
          // 召唤链的 thread 深层回复：执行记录同样嵌入该回复，不另起一行
          flushPerms(msg.character, msg.replyTo);
          appendThreadReply({
            character: msg.character,
            text: msg.text,
            replyId: msg.id,
            threadId: msg.threadId,
            depth: msg.depth,
            timestamp: msg.timestamp,
          });
          attachThinkingToReply(msg.character, msg.replyTo, state.messageElements[msg.id]);
        } else {
          flushPerms(msg.character, msg.replyTo);
          appendAssistantMessage(msg.character, msg.text, msg.id, msg.threadId, msg.aiMentions, msg.timestamp);
          // 嵌入回复内部（回复内容上方），不再另起一行
          attachThinkingToReply(msg.character, msg.replyTo, state.messageElements[msg.id]);
        }
        if (msg.replyTo) {
          state.replyByThinking[permKey(msg.character, msg.replyTo)] = msg.id;
          renderFileDiffDirectory(msg.character, msg.replyTo, state.messageElements[msg.id]);
        }
        // 快照仍 active 但回复已落盘（主线与 thread 深层回复都覆盖）：
        // 不再额外新建空 thinking，角色状态仍保持为 thinking
        const key = permKey(msg.character, msg.replyTo);
        if (msg.replyTo && activeKeys.has(key)) {
          activeRepliedKeys.add(key);
        }
        updateStats(msg.character);
        state.lastSpeaker = msg.character;
      } else if (msg.role === "error") {
        flushPerms(msg.character, msg.replyTo);
        const errorEl = appendErrorMessage(msg.character, msg.error, msg.timestamp);
        // 执行记录嵌入错误气泡内部（replyTo 即对应 thinking 的 messageId）
        if (msg.replyTo) attachThinkingToReply(msg.character, msg.replyTo, errorEl);
      } else if (msg.role === "permission") {
        // 仅聚合获批且执行成功的编辑记录；存量无 execution 的历史记录本期不展示
        if (msg.status === "allow" && msg.execution?.status === "success") recordFileChange(msg);
        else if (!msg.execution && msg.requestId && msg.status !== "deny") {
          // 审批已入历史快照但执行结果尚未回报：重建索引，
          // 否则晚到的 permission-executed 会因找不到请求而被丢弃（SSE 重连不重放历史事件）
          state.permRequestIndex[msg.requestId] = { ...msg, approved: msg.status === "allow" };
        }
        const key = permKey(msg.character, msg.messageId);
        if (replyKeys.has(key)) {
          // 有绑定回复：暂存，等渲染到该回复时再建容器
          if (!pendingPerms.has(key)) pendingPerms.set(key, []);
          pendingPerms.get(key).push(msg);
        } else if (activeKeys.has(key)) {
          // 仍在执行中：渲染为活的 thinking 容器（处理中样式 + 终止按钮）
          showThinking(msg.character, msg.messageId);
          showPermissionCard(msg);
        } else {
          // 孤儿记录（无绑定回复且已结束）：按原时间位置渲染
          const container = showArchivedThinking(msg.character, msg.messageId);
          appendPermRecord(container, msg);
        }
      } else if (msg.role === "thinking") {
        const key = permKey(msg.character, msg.messageId);
        if (replyKeys.has(key)) {
          if (!pendingPerms.has(key)) pendingPerms.set(key, []);
          pendingPerms.get(key).push(msg);
        } else if (activeKeys.has(key)) {
          showThinking(msg.character, msg.messageId);
          const container = findThinkingElement(msg.character, msg.messageId);
          if (container) appendThinkingContent(container, msg);
        } else {
          const container = showArchivedThinking(msg.character, msg.messageId);
          appendThinkingContent(container, msg);
        }
      }
    }

    // 恢复仍在执行中的 invoke（含还没有任何执行记录的），保持"处理中"可见；
    // 已有回复落盘的不再新建空 thinking
    for (const t of activeThinkingList) {
      if (!activeRepliedKeys.has(permKey(t.character, t.messageId))) {
        showThinking(t.character, t.messageId);
      }
      setCharStatus(t.character, "thinking");
    }

    // 兜底：理论上已清空，防止异常导致暂存记录丢失
    for (const records of pendingPerms.values()) {
      const container = showArchivedThinking(records[0].character, records[0].messageId);
      for (const rec of records) {
        if (rec.role === "thinking") appendThinkingContent(container, rec);
        else appendPermRecord(container, rec);
      }
    }

    // 汇总每个过程记录容器的摘要（标题 + 条数），含嵌入回复内部的
    for (const el of $messages.querySelectorAll(".thinking-finished")) {
      updateThinkingSummary(el);
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

function escapeAttribute(str) {
  return escapeHtml(String(str ?? ""))
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      const ctxK = Number(row.querySelector(".ctx-input")?.value);
      if (!roleId || !name) continue;

      const key = name.toLocaleLowerCase();
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key).push(roleId);
      updates.push({ roleId, name, model, contextWindow: Number.isFinite(ctxK) && ctxK > 0 ? Math.round(ctxK * 1024) : undefined });
    }

    for (const [key, ids] of nameMap.entries()) {
      if (ids.length > 1) {
        showSettingsError(`角色名重复：${key}。请给每个角色设置不同名称。`);
        return;
      }
    }

    hideSettingsError();

    for (const { roleId, name, model, contextWindow } of updates) {
      try {
        const res = await fetch(`/api/roles/${roleId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, model, ...(contextWindow !== undefined ? { contextWindow } : {}) }),
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
  header.innerHTML = `<div>CLI</div><div>角色名</div><div>模型</div><div>上下文(k)</div><div></div>`;
  $settingsForm.appendChild(header);

  const allRoles = Object.entries(state.characters).map(([name, cfg]) => ({
    id: cfg.id, name, cli: cfg.cli, model: cfg.model || "", archived: cfg.archived || false,
    contextWindow: cfg.contextWindow || 262144,
  }));

  for (const role of allRoles) {
    const row = document.createElement("div");
    row.className = `setting-row${role.archived ? " archived" : ""}`;
    row.setAttribute("data-role-id", role.id);
    row.innerHTML = `
      <div class="setting-cli">${role.cli}</div>
      <input class="name-input" type="text" value="${escapeHtml(role.name)}" placeholder="角色名" ${role.archived ? "disabled" : ""}>
      <input class="model-input" type="text" value="${escapeHtml(role.model)}" placeholder="模型" ${role.archived ? "disabled" : ""}>
      <input class="ctx-input" type="number" min="1" step="1" value="${Math.round((role.contextWindow || 262144) / 1024)}" title="最大上下文长度（k tokens）" ${role.archived ? "disabled" : ""}>
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
          <option value="qodercn">qodercn</option>
          <option value="dsh">dsh</option>
          <option value="kimi">kimi</option>
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
  if (cli === "qodercn") return "qodercn";
  if (cli === "dsh") return "dsh";
  if (cli === "kimi") return "kimi";
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
