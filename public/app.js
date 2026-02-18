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
};
const PROFILE_STORAGE_KEY = "characterProfilesV1";

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
const $chatSubtitle = $("#chat-subtitle");
const $settingsBtn = $("#settings-btn");
const $settingsModal = $("#settings-modal");
const $settingsForm = $("#settings-form");
const $settingsError = $("#settings-error");
const $settingsSaveBtn = $("#settings-save-btn");
const $settingsCancelBtn = $("#settings-cancel-btn");

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
  setupSettings();

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
async function sendMessage() {
  const rawText = $input.value.trim();
  if (!rawText) return;
  const text = normalizeMentions(rawText);

  $input.value = "";
  autoResize($input);
  $mentionHints.classList.add("hidden");

  appendUserMessage(rawText);

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
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
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
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
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
  scrollToBottom();
}

// ── Thinking ──────────────────────────────────────────────
function showThinking(character, messageId) {
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.id = `thinking-${character}-${messageId}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
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

// ── 权限审批卡片 ────────────────────────────────────────
function showPermissionCard({ requestId, character, toolName, input, timestamp }) {
  const charClass = getCharClass(character);
  const avatar = getAvatar(character);
  const displayName = getDisplayName(character);
  const time = formatTimeShort(timestamp || Date.now());

  // 根据工具类型格式化展示内容
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
    // 通用：显示 JSON 参数
    const inputStr = JSON.stringify(input, null, 2);
    detail = `<div class="perm-detail-label">参数</div><pre class="perm-code">${escapeHtml(truncate(inputStr, 400))}</pre>`;
  }

  const div = document.createElement("div");
  div.className = `message assistant ${charClass}`;
  div.id = `perm-${requestId}`;
  div.innerHTML = `
    <div class="avatar ${charClass}">${avatar}</div>
    <div class="bubble-wrapper">
      <div class="msg-header">
        <span class="character-name ${charClass}">${escapeHtml(displayName)}</span>
        <span class="msg-time">${time}</span>
        <span class="perm-badge">需要权限</span>
      </div>
      <div class="perm-card">
        <div class="perm-tool-name">
          <svg class="perm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v2m0 4h.01M5.07 19h13.86c1.14 0 1.83-1.23 1.23-2.2L13.23 4.6a1.39 1.39 0 0 0-2.46 0L3.84 16.8c-.6.97.09 2.2 1.23 2.2z"/></svg>
          ${escapeHtml(toolName)}
        </div>
        ${detail}
        <div class="perm-actions" id="perm-actions-${requestId}">
          <button class="perm-btn perm-deny" onclick="respondPermission('${requestId}', 'deny')">拒绝</button>
          <button class="perm-btn perm-allow" onclick="respondPermission('${requestId}', 'allow')">允许</button>
        </div>
      </div>
    </div>
  `;
  $messages.appendChild(div);
  scrollToBottom();
}

async function respondPermission(requestId, behavior) {
  const actionsEl = document.getElementById(`perm-actions-${requestId}`);
  if (actionsEl) {
    actionsEl.innerHTML = `<span class="perm-pending">${behavior === "allow" ? "已允许 ✓" : "已拒绝 ✗"}</span>`;
  }

  try {
    await fetch("/api/permission-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, behavior }),
    });
  } catch {
    if (actionsEl) {
      actionsEl.innerHTML = '<span class="perm-pending" style="color:var(--error-text)">发送失败</span>';
    }
  }
}

function resolvePermissionCard(requestId, behavior, message) {
  const actionsEl = document.getElementById(`perm-actions-${requestId}`);
  if (actionsEl) {
    const label = behavior === "allow" ? "已允许 ✓" : "已拒绝 ✗";
    const color = behavior === "allow" ? "var(--green)" : "var(--error-text)";
    actionsEl.innerHTML = `<span class="perm-pending" style="color:${color}">${label}</span>`;
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
      <span class="char-status-name" style="color: var(--${charClass}-accent)">${escapeHtml(getDisplayName(name))} (${config.cli})</span>
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
  $messages.innerHTML = `<div id="system-notice" class="system-notice">${buildSystemNoticeHtml()}</div>`;
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

function initProfiles() {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  })();

  state.profiles = {};
  for (const [character] of Object.entries(state.characters)) {
    const nickname = String(saved[character]?.nickname || character).trim() || character;
    state.profiles[character] = { nickname };
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
    const rows = $settingsForm.querySelectorAll(".setting-row");
    const nextProfiles = {};
    const nicknameMap = new Map();
    for (const row of rows) {
      const character = row.getAttribute("data-character");
      const nickname = row.querySelector(".nickname-input")?.value?.trim();
      if (!character) continue;
      const safeName = nickname || character;
      nextProfiles[character] = { nickname: safeName };

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
  for (const [character, config] of Object.entries(state.characters)) {
    const row = document.createElement("div");
    row.className = "setting-row";
    row.setAttribute("data-character", character);
    row.innerHTML = `
      <div class="setting-cli">${config.cli}</div>
      <input class="nickname-input" type="text" value="${escapeHtml(getDisplayName(character))}" placeholder="昵称">
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

function getCharClass(character) {
  const cli = state.characters[character]?.cli;
  if (cli === "trae") return "qijige";
  if (cli === "codex") return "yyf";
  return "faker";
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
