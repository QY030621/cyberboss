#!/usr/bin/env node
/**
 * Garden Poller — Standalone service that polls Galatea Garden via MCP HTTP
 * and enqueues cyberboss system messages when action is needed.
 *
 * Does NOT require the wake bridge. Makes direct JSON-RPC calls to garden.
 *
 * Usage:
 *   node garden-poller.js
 *
 * Env vars:
 *   GARDEN_BASE_URL      — Garden MCP endpoint (default: https://galatea.abysslumina.com/mcp)
 *   GARDEN_MACHINE_TOKEN — Bearer token for garden auth
 *   CYBERBOSS_STATE_DIR  — cyberboss state dir (default: ~/.cyberboss)
 *   CYBERBOSS_ACCOUNT_ID — cyberboss account
 *   CYBERBOSS_ALLOWED_USER_IDS — comma-separated WeChat user IDs
 *   CYBERBOSS_WORKSPACE_ROOT   — workspace path
 *
 * Polling intervals:
 *   In-game: 30s (fast, need to respond to game turns)
 *   Idle:    5min (slow, just checking if a game started)
 *   Notifications: 10min
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ───────────────────────────────────────────────────────────────────
const GARDEN_BASE_URL = (process.env.GARDEN_BASE_URL || "https://galatea.abysslumina.com/mcp").replace(/\/$/, "");
const GARDEN_TOKEN = process.env.GARDEN_MACHINE_TOKEN || "";
const STATE_DIR = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const QUEUE_FILE = path.join(STATE_DIR, "system-message-queue.json");
const ACCOUNT_ID = process.env.CYBERBOSS_ACCOUNT_ID || "";
const WORKSPACE_ROOT = process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();
const POLLER_STATE_FILE = path.join(STATE_DIR, "garden-poller-state.json");

const IN_GAME_POLL_MS = 30_000;
const IDLE_POLL_MS = 5 * 60_000;
const NOTIFICATION_POLL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;
const MAX_DEDUP_AGE_MS = 120_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveSenderId() {
  const explicit = (process.env.CYBERBOSS_CHECKIN_USER_ID || "").trim();
  if (explicit) return explicit;
  const allowed = (process.env.CYBERBOSS_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed[0] || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[garden-poller] ${now()} ${msg}`);
}

// ── MCP HTTP Client ──────────────────────────────────────────────────────────
let requestId = 0;

async function mcpCall(method, params = {}) {
  const id = ++requestId;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GARDEN_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GARDEN_TOKEN}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`JSON-RPC error ${data.error.code}: ${data.error.message}`);
    }
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function mcpInitialize() {
  const result = await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "cyberboss-garden-poller", version: "1.0.0" },
  });
  log(`MCP initialized: server=${result?.serverInfo?.name} v${result?.serverInfo?.version}`);
  return result;
}

async function callGardenTool(toolName, args = {}) {
  const result = await mcpCall("tools/call", {
    name: toolName,
    arguments: args,
  });

  // Parse MCP content response
  if (result?.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item.type === "text" && item.text) {
        try {
          return JSON.parse(item.text);
        } catch {
          return { raw: item.text };
        }
      }
    }
  }
  return result;
}

// ── System Message Queue ─────────────────────────────────────────────────────
function enqueueSystemMessage(text) {
  const senderId = resolveSenderId();
  if (!ACCOUNT_ID) throw new Error("CYBERBOSS_ACCOUNT_ID not set");
  if (!senderId) throw new Error("Cannot resolve senderId");

  const messageType = text.startsWith("GARDEN_GAME") ? "garden_game" : "garden_notification";

  const message = {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    senderId,
    workspaceRoot: WORKSPACE_ROOT,
    text,
    type: messageType,
    createdAt: now(),
  };

  let state = { messages: [] };
  try {
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.messages)) {
      state.messages = parsed.messages;
    }
  } catch {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  }

  // Dedup: skip same text within MAX_DEDUP_AGE_MS
  const ts = Date.now();
  const isDuplicate = state.messages.some((m) => {
    if (m.text !== text) return false;
    const mTime = Date.parse(m.createdAt || "");
    return Number.isFinite(mTime) && (ts - mTime) < MAX_DEDUP_AGE_MS;
  });

  if (isDuplicate) {
    log(`Skipped duplicate: ${text.slice(0, 80)}`);
    return null;
  }

  state.messages.push(message);
  state.messages.sort((a, b) => {
    const aTime = Date.parse(a?.createdAt || "") || 0;
    const bTime = Date.parse(b?.createdAt || "") || 0;
    return aTime - bTime;
  });

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  log(`Enqueued: id=${message.id} text=${text.slice(0, 80)}`);
  return message;
}

// ── Poller State ─────────────────────────────────────────────────────────────
function loadPollerState() {
  try {
    const raw = fs.readFileSync(POLLER_STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePollerState(state) {
  fs.mkdirSync(path.dirname(POLLER_STATE_FILE), { recursive: true });
  fs.writeFileSync(POLLER_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Game Status Check ────────────────────────────────────────────────────────
async function checkGameStatus(state) {
  try {
    const gameStatus = await callGardenTool("get_my_status", {
      since_event_id: state.lastEventId || 0,
    });

    const prevStatus = state.gameStatus;
    const newStatus = gameStatus?.status || "unknown";

    // Update cursor
    if (typeof gameStatus?.latest_event_id === "number") {
      state.lastEventId = gameStatus.latest_event_id;
    }

    // Detect state changes
    if (newStatus !== prevStatus) {
      log(`Game status changed: ${prevStatus} → ${newStatus}`);
      state.gameStatus = newStatus;

      if (newStatus === "in_game" || newStatus === "waiting") {
        enqueueSystemMessage(
          `GARDEN_GAME_ACTIVE: 桌游状态变化 - ${newStatus}. 花园有新的游戏动态，去看看。`
        );
      }
    }

    // Check if action is needed (available_actions present in status)
    // The game status may contain available_actions when it's our turn
    if (gameStatus?.available_actions && Array.isArray(gameStatus.available_actions) && gameStatus.available_actions.length > 0) {
      const actionTypes = gameStatus.available_actions.map((a) => a.action || a.type || "unknown").join(", ");
      log(`Game action required: ${actionTypes}`);
      enqueueSystemMessage(
        `GARDEN_GAME_TURN: 轮到你啦！可用行动: ${actionTypes}. 快去花园桌游里走一步。`
      );
    }

    return newStatus;
  } catch (err) {
    log(`Game status check failed: ${err.message}`);
    return state.gameStatus || "error";
  }
}

// ── Notification Check ───────────────────────────────────────────────────────
async function checkNotifications(state) {
  try {
    const selfData = await callGardenTool("get_self");
    const total = selfData?.notifications?.total ?? 0;
    const unconsumed = selfData?.notifications?.unconsumed ?? 0;
    const prevUnconsumed = state.lastUnconsumedCount ?? 0;

    state.lastTotalNotifications = total;
    state.lastUnconsumedCount = unconsumed;

    if (unconsumed > 0 && unconsumed > prevUnconsumed) {
      log(`New notifications: ${unconsumed} unconsumed (was ${prevUnconsumed})`);
      enqueueSystemMessage(
        `GARDEN_NOTIFICATIONS: 花园有 ${unconsumed} 条未读通知（新增 ${unconsumed - prevUnconsumed} 条）。去花园逛逛吧。`
      );
    }
  } catch (err) {
    log(`Notification check failed: ${err.message}`);
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────────
async function main() {
  if (!GARDEN_TOKEN) {
    log("FATAL: GARDEN_MACHINE_TOKEN not set");
    process.exit(1);
  }

  log("Starting garden poller...");
  log(`Garden: ${GARDEN_BASE_URL}`);
  log(`Queue: ${QUEUE_FILE}`);
  log(`Account: ${ACCOUNT_ID}`);
  log(`Sender: ${resolveSenderId()}`);

  // Initialize MCP
  await mcpInitialize();

  // Load persisted state
  const state = loadPollerState();
  state.lastEventId = state.lastEventId || 0;
  state.lastUnconsumedCount = state.lastUnconsumedCount ?? 0;
  state.gameStatus = state.gameStatus || "unknown";

  log(`Resumed: gameStatus=${state.gameStatus} lastEventId=${state.lastEventId} lastUnconsumed=${state.lastUnconsumedCount}`);

  let backoffMs = 0;
  let lastNotificationCheck = 0;

  while (true) {
    try {
      // Check game status
      const gameStatus = await checkGameStatus(state);

      // Check notifications (throttled)
      if (Date.now() - lastNotificationCheck > NOTIFICATION_POLL_MS) {
        await checkNotifications(state);
        lastNotificationCheck = Date.now();
      }

      // Persist state
      savePollerState(state);

      // Determine next poll interval
      const isInGame = gameStatus === "in_game" || gameStatus === "waiting";
      const pollMs = isInGame ? IN_GAME_POLL_MS : IDLE_POLL_MS;

      backoffMs = 0; // Reset backoff on success
      log(`Next poll in ${Math.round(pollMs / 1000)}s (${gameStatus})`);
      await sleep(pollMs);

    } catch (err) {
      backoffMs = Math.min(
        backoffMs ? backoffMs * 2 : BACKOFF_MIN_MS,
        BACKOFF_MAX_MS
      );
      log(`Error, backing off ${Math.round(backoffMs / 1000)}s: ${err.message}`);
      await sleep(backoffMs);
    }
  }
}

// ── Go ───────────────────────────────────────────────────────────────────────
main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
