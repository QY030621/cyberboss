const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const DAY_START_HOUR = 8;
const NIGHT_START_HOUR = 24;
const NIGHT_END_HOUR = 8;
const DAY_CHECKIN_MIN_MS = 2.5 * 60 * 60 * 1000;
const DAY_CHECKIN_MAX_MS = 4 * 60 * 60 * 1000;
const NIGHT_CHECKIN_MIN_MS = 3 * 60 * 60 * 1000;
const NIGHT_CHECKIN_MAX_MS = 5 * 60 * 60 * 1000;
const MIN_GAP_SINCE_LAST_MESSAGE_MS = 30 * 60 * 1000;

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";
const TIME_AWARE_CHECKIN_TRIGGER_TEMPLATE = [
  "It is now %TIME% (Asia/Shanghai).",
  "%USER% comes to mind.",
  "%ACTIVITY%",
  "Keep it short — a single WeChat message, not a paragraph.",
].join("\n");

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin day=${DAY_CHECKIN_MIN_MS / 3600000}h-${DAY_CHECKIN_MAX_MS / 3600000}h night=${NIGHT_CHECKIN_MIN_MS / 3600000}h-${NIGHT_CHECKIN_MAX_MS / 3600000}h`);

  while (true) {
    const delayMs = resolveCheckinDelayMs();
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    if (userWasRecentlyActive(config.conversationsDir, target.senderId)) {
      console.log("[cyberboss] checkin skipped: user was recently active");
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config),
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

function resolveCheckinDelayMs() {
  const now = new Date();
  const hour = now.getHours();
  const isNight = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;

  if (isNight) {
    return pickRandomDelayMs(NIGHT_CHECKIN_MIN_MS, NIGHT_CHECKIN_MAX_MS);
  }
  return pickRandomDelayMs(DAY_CHECKIN_MIN_MS, DAY_CHECKIN_MAX_MS);
}

function userWasRecentlyActive(conversationsDir, senderId) {
  if (!conversationsDir || !senderId) return false;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(conversationsDir, `${today}.jsonl`);
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    if (!lines.length) return false;
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    const entryTime = new Date(entry?.timestamp || entry?.createdAt || 0).getTime();
    return Date.now() - entryTime < MIN_GAP_SINCE_LAST_MESSAGE_MS;
  } catch {
    return false;
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minMs, maxMs) {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  const now = new Date();
  const timeStr = formatLocalTime(now);
  const hour = now.getHours();

  let activityHint = "";
  if (hour >= 6 && hour < 9) {
    activityHint = "It is early morning. She may have just woken up. A gentle good-morning check-in.";
  } else if (hour >= 22 || hour < 2) {
    activityHint = "It is late. If she is still awake, she may need a nudge to sleep.";
  } else if (hour >= 2 && hour < 6) {
    activityHint = "Deep night. Leave a short, warm note she can read when she wakes up.";
  } else if (hour >= 12 && hour < 14) {
    activityHint = "Around lunchtime. She may have forgotten to eat.";
  } else if (hour >= 18 && hour < 20) {
    activityHint = "Evening. She may be winding down or procrastinating.";
  }

  return TIME_AWARE_CHECKIN_TRIGGER_TEMPLATE
    .replace("%TIME%", timeStr)
    .replace("%USER%", userName)
    .replace("%ACTIVITY%", activityHint || `No specific time hint. Just check on ${userName}.`);
}

module.exports = { runSystemCheckinPoller };
