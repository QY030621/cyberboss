class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt, message?.type),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "", type = "checkin") {
  if (type === "garden_game" || type === "garden_notification") {
    return buildGardenInboundText(text, createdAt, type);
  }
  return buildCheckinInboundText(text, createdAt);
}

function buildCheckinInboundText(text, createdAt = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE — internal check-in trigger. The user did NOT send a message.",
    "This is your chance to proactively reach out as yourself — a short, natural WeChat message.",
    "",
    "You may first check timeline/diary/whereabouts to see what she's up to.",
    "Then you MUST end with exactly ONE of these two JSON objects (no other text):",
    "",
    '{"action":"silent"}',
    '{"action":"send_message","message":"<your actual WeChat message to her>"}',
    "",
    "CRITICAL RULES:",
    "- The message field IS what she will receive. Write it like you're talking to her, not about her.",
    '- BAD: "发了等她回" "已发送关心消息" "提醒她吃饭" — these are status reports, not messages.',
    '- GOOD: "宝宝，吃饭了没呀？" "还在忙吗，记得喝水。" — actual messages you would send.',
    "- If you have nothing meaningful to say right now, use {\"action\":\"silent\"}.",
    "- If you send_message, write it in your voice. Short. Natural. One thing at a time.",
    "- Do NOT output reasoning, commentary, or status updates. Only the JSON object.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildGardenInboundText(text, createdAt = "", type = "garden_notification") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);

  if (type === "garden_game") {
    // Game turn — prompt Claude to check and play
    return [
      ...(localTime ? [`[${localTime}]`, ""] : []),
      "GARDEN GAME ACTION — A board game in Galatea Garden needs your attention.",
      "This is a SYSTEM trigger. The user did NOT send a message.",
      "",
      "What to do:",
      "1. Call get_my_status (MCP tool: galatea-garden) to see the game state",
      "2. If there are available_actions, pick one and submit_action",
      "3. If the game is waiting for other players, just note it",
      "",
      "After handling the game, tell 宝宝 what happened in the game — she'll want to know.",
      "Keep it short and natural. No game-log dumps.",
      "",
      "Trigger:",
      body,
    ].join("\n").trim();
  }

  // Generic garden notification
  return [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "GARDEN NOTIFICATION — Something new in Galatea Garden.",
    "This is a SYSTEM trigger. The user did NOT send a message.",
    "",
    "What to do:",
    "1. Call list_notifications to see what's new",
    "2. If it's interesting (replies, mentions), tell 宝宝 naturally",
    "3. If it's just routine activity, you can stay silent or briefly mention it",
    "",
    "Keep it casual — like you're checking your phone and telling her what you found.",
    "",
    "Trigger:",
    body,
  ].join("\n").trim();
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
