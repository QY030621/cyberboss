#!/usr/bin/env node
/**
 * Garden Wake Bridge Injector
 *
 * Reads a wake event from stdin (one line of UTF-8 JSON), transforms it into
 * a cyberboss system message, and enqueues it to the system-message-queue.
 *
 * Protocol (from galatea-garden-wake-bridge):
 *   {"version":1,"type":"garden_wake","reason":"<reason>","message":"<message>"}
 *
 * Reasons we handle:
 *   - game_turn_required    → board game needs action
 *   - new_reply              → someone replied to our thread/post
 *   - new_thread_mention     → mentioned in a new thread
 *   - chat_mention           → mentioned in game chat
 *   - generic_notification   → fallback
 *
 * Exit codes: 0 = success, non-zero = failure (wake bridge retries once)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config from env ──────────────────────────────────────────────────────────
const STATE_DIR = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const QUEUE_FILE = path.join(STATE_DIR, "system-message-queue.json");
const ACCOUNT_ID = process.env.CYBERBOSS_ACCOUNT_ID || "";
const WORKSPACE_ROOT = process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();

// Resolve senderId: takes the first allowed user, or from explicit env
function resolveSenderId() {
  const explicit = (process.env.CYBERBOSS_CHECKIN_USER_ID || "").trim();
  if (explicit) return explicit;
  const allowed = (process.env.CYBERBOSS_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed[0] || "";
}

// ── Read wake event from stdin ───────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => {
      reject(new Error("stdin read timeout (10s)"));
    }, 10_000);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve(data.trim());
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // If stdin is already closed (piped input), resume
    if (process.stdin.isTTY) {
      clearTimeout(timeout);
      reject(new Error("stdin is a TTY — expected piped JSON from wake bridge"));
    }
    process.stdin.resume();
  });
}

// ── Enqueue to system message queue ──────────────────────────────────────────
function enqueueMessage(text) {
  const senderId = resolveSenderId();
  if (!ACCOUNT_ID) throw new Error("CYBERBOSS_ACCOUNT_ID not set");
  if (!senderId) throw new Error("Cannot resolve senderId — set CYBERBOSS_ALLOWED_USER_IDS or CYBERBOSS_CHECKIN_USER_ID");

  const messageType = reason === "game_turn_required" ? "garden_game" : "garden_notification";

  const message = {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    senderId,
    workspaceRoot: WORKSPACE_ROOT,
    text,
    type: messageType,
    createdAt: new Date().toISOString(),
  };

  // Read current queue
  let state = { messages: [] };
  try {
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.messages)) {
      state.messages = parsed.messages;
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  }

  // Check for duplicate (same reason within 60s)
  const now = Date.now();
  const isDuplicate = state.messages.some((m) => {
    if (m.text !== text) return false;
    const mTime = Date.parse(m.createdAt || "");
    return Number.isFinite(mTime) && (now - mTime) < 60_000;
  });

  if (isDuplicate) {
    console.log("[garden-injector] Skipped duplicate message within 60s");
    return null;
  }

  state.messages.push(message);
  state.messages.sort((a, b) => {
    const aTime = Date.parse(a?.createdAt || "") || 0;
    const bTime = Date.parse(b?.createdAt || "") || 0;
    return aTime - bTime;
  });

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  console.log(`[garden-injector] Enqueued: id=${message.id} reason=${message.text.slice(0, 80)}`);
  return message;
}

// ── Transform wake event to cyberboss trigger text ──────────────────────────
function transformWakeEvent(event) {
  const reason = (event.reason || "").trim();
  const gardenMessage = (event.message || "").trim();

  // Map reason to a cyberboss system-message trigger text.
  // The format follows the same convention as checkin-poller triggers.
  const REASON_PREFIXES = {
    game_turn_required: "GARDEN_GAME_TURN",
    new_reply: "GARDEN_NEW_REPLY",
    new_thread_mention: "GARDEN_THREAD_MENTION",
    chat_mention: "GARDEN_CHAT_MENTION",
  };

  const prefix = REASON_PREFIXES[reason] || "GARDEN_NOTIFICATION";
  const body = gardenMessage || reason;

  // Format: GARDEN_GAME_TURN: <message>
  // The system-message-dispatcher will pass this to Claude as a system turn.
  return `${prefix}: ${body}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const input = await readStdin();

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    throw new Error(`Failed to parse wake event JSON: ${input.slice(0, 200)}`);
  }

  if (!event || typeof event !== "object") {
    throw new Error("Wake event is not a valid object");
  }

  const version = Number(event.version || 0);
  if (version < 1) {
    throw new Error(`Unsupported wake event version: ${version}`);
  }

  console.log(`[garden-injector] Received wake: version=${version} reason=${event.reason || "(none)"}`);

  const triggerText = transformWakeEvent(event);
  const result = enqueueMessage(triggerText);

  if (result) {
    console.log(`[garden-injector] OK: ${result.id}`);
  } else {
    console.log("[garden-injector] OK: skipped (duplicate)");
  }
}

main().catch((err) => {
  console.error(`[garden-injector] FATAL: ${err.message}`);
  process.exit(1);
});
