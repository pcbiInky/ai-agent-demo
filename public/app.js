// ── 状态 ──────────────────────────────────────────────────
const state = {
  sessionId: null,
  characters: {},
  eventSource: null,
  // 右侧栏统计
  stats: { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 },
  // 角色状态: "online" | "thinking"
  charStatus: {},
  // thinking 中的 messageId -> Set<character>
  thinkingMap: {},
};

// ── DOM 元素 ──────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $messages = $("#messages");
const $input = $("#message-input");
const $sendBtn = $("#send-btn");
const $sessionDisplay = $("#session-id-display");
const $newSessionBtn = $("#new-session-btn");
const $sessionList = $("#session-list");
const $mentionHints = $("#mention-hints");
const $charStatuses = $("#character-statuses");

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  const res = await fetch("/api/characters");
  const data = await res.json();
  state.characters = data.characters;

  // 初始化角色状态
  for (const name of Object.keys(state.characters)) {
    state.charStatus[name] = "online";
  }
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
    removeThinking(data.character, data.messageId);
    appendAssistantMessage(data.character, data.text, data.verified);
    updateStats(data.character, data.verified);
    loadSessionList();
  });

  es.addEventListener("error", (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      setCharStatus(data.character, "online");
      removeThinking(data.character, data.messageId);
      appendErrorMessage(data.character, data.error);
    }
  });
}

// ── 发送消息 ──────────────────────────────────────────────
async function sendMessage() {
  const text = $input.value.trim();
  if (!text) return;

  $input.value = "";
  autoResize($input);
  $mentionHints.classList.add("hidden");

  appendUserMessage(text);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionId: state.sessionId }),
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
  const time = formatTimeShort(Date.now());
  const div = document.createElement("div");
  div.className = "message user";
  div.innerHTML = `
    <div class="avatar user-avatar">你</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="msg-time">${time}</span>
      </div>
      <div class="bubble">${escapeHtml(text)}</div>
    </div>
  `;
  $messages.appendChild(div);
  scrollToBottom();
  state.stats.total++;
  renderStats();
}

function appendAssistantMessage(character, text, verified) {
  const charClass = getCharClass(character);
  const avatar = state.characters[character]?.avatar || character[0];
  const time = formatTimeShort(Date.now());
  const cli = state.characters[character]?.cli || "";

  let verifiedHtml = "";
  if (verified === true) verifiedHtml = '<span class="verified-badge pass">verified</span>';
  else if (verified === false) verifiedHtml = '<span class="verified-badge fail">unverified</span>';

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(character)}</span>
        <span class="msg-time">${time}</span>
        ${verifiedHtml}
      </div>
      <div class="bubble">${escapeHtml(text)}</div>
      <div class="msg-model">${cli}</div>
    </div>
  `;
  $messages.appendChild(div);
  scrollToBottom();
}

function appendErrorMessage(character, error) {
  const charClass = getCharClass(character);
  const avatar = state.characters[character]?.avatar || "!";

  const div = document.createElement("div");
  div.className = `message assistant error-msg ${charClass}`;
  div.innerHTML = `
    <div class="avatar ${charClass}" style="background:var(--error-text)">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name">${escapeHtml(character)}</span>
        <span class="msg-time">${formatTimeShort(Date.now())}</span>
      </div>
      <div class="bubble">${escapeHtml(error)}</div>
    </div>
  `;
  $messages.appendChild(div);
  scrollToBottom();
}

// ── Thinking ──────────────────────────────────────────────
function showThinking(character, messageId) {
  const charClass = getCharClass(character);
  const avatar = state.characters[character]?.avatar || character[0];

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.id = `thinking-${character}-${messageId}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(character)}</span>
        <span class="msg-time">思考中...</span>
      </div>
      <div class="thinking-bubble">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    </div>
  `;
  $messages.appendChild(div);
  scrollToBottom();
}

function removeThinking(character, messageId) {
  const el = document.getElementById(`thinking-${character}-${messageId}`);
  if (el) el.remove();
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
      <span class="char-status-name" style="color: var(--${charClass}-accent)">${name} (${config.cli})</span>
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
          <span class="mini-avatar" style="background:var(--faker-accent)">F</span>
          <span class="mini-avatar" style="background:var(--qijige-accent)">奇</span>
          <span class="mini-avatar" style="background:var(--yyf-accent)">Y</span>
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
  $messages.innerHTML = `
    <div class="system-notice">
      输入 <code>@Faker</code> 调用 Claude，<code>@奇迹哥</code> 调用 Trae，<code>@YYF</code> 调用 Codex
    </div>
  `;
  state.stats = { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 };
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

    $messages.innerHTML = "";
    state.stats = { total: 0, faker: 0, qijige: 0, yyf: 0, verified: 0 };

    for (const msg of log.messages) {
      if (msg.role === "user") {
        appendUserMessage(msg.text);
      } else if (msg.role === "assistant") {
        appendAssistantMessage(msg.character, msg.text, msg.verified);
        updateStats(msg.character, msg.verified);
      } else if (msg.role === "error") {
        appendErrorMessage(msg.character, msg.error);
      }
    }
  } catch { /* ignore */ }
}

// ── @mention 提示 ─────────────────────────────────────────
function setupMentionHints() {
  $mentionHints.innerHTML = "";
  for (const [name] of Object.entries(state.characters)) {
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
      e.preventDefault();
      sendMessage();
    }
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

function getCharClass(character) {
  if (character === "奇迹哥") return "qijige";
  if (character === "YYF") return "yyf";
  return (character || "").toLowerCase();
}

function scrollToBottom() {
  const container = document.getElementById("chat-container");
  container.scrollTop = container.scrollHeight;
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
