"use strict";

const {
  searchMemory,
  readIndex,
  readPending,
  approvePending,
  rejectPending,
  undoLastWrite,
  pruneCategory,
  markDeleted,
} = require("./memory-store");
const { listFiles } = require("./memory-md-store");

/**
 * Route /memory commands. Returns a reply string or null if not a memory command.
 */
function routeMemoryCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/memory")) return null;

  const args = raw.replace(/^\/memory\s*/, "").trim();

  if (!args) {
    return showHelp();
  }

  if (args.startsWith("search ")) {
    const query = args.replace(/^search\s+/, "").trim();
    return handleSearch(query);
  }

  if (args.startsWith("show ")) {
    const category = args.replace(/^show\s+/, "").trim();
    return handleShow(category);
  }

  if (args.startsWith("forget ")) {
    const key = args.replace(/^forget\s+/, "").trim();
    return handleForget(key);
  }

  if (args === "pending") {
    return handlePending();
  }

  if (args.startsWith("approve ")) {
    const id = args.replace(/^approve\s+/, "").trim();
    return handleApprove(id);
  }

  if (args.startsWith("reject ")) {
    const id = args.replace(/^reject\s+/, "").trim();
    return handleReject(id);
  }

  if (args === "undo last") {
    return handleUndo();
  }

  if (args.startsWith("prune ")) {
    const category = args.replace(/^prune\s+/, "").trim();
    return handlePrune(category);
  }

  if (args === "mine") {
    return "Mining will run on next post-response cycle.";
  }

  return "Unknown /memory command. Type /memory for help.";
}

function showHelp() {
  return [
    "📝 **Memory Commands**",
    "/memory search <关键词>  — 搜索记忆",
    "/memory show <category>   — 查看分类 (facts/preferences/patterns/projects/open_loops/relationships/profile)",
    "/memory forget <关键词>   — 删除记忆",
    "/memory pending           — 查看待确认记忆",
    "/memory approve <id>      — 批准待确认记忆",
    "/memory reject <id>       — 拒绝待确认记忆",
    "/memory undo last         — 撤销上次写入",
    "/memory prune <category>  — 清空分类",
    "/memory mine              — 手动触发挖掘",
  ].join("\n");
}

function handleSearch(query) {
  const results = searchMemory(query);
  if (results.length === 0) return `No memories found for: ${query}`;
  const lines = results.map((e) => `[${e.category}] **${e.key}**: ${e.text} (${e.status})`).slice(0, 20);
  return `Found ${results.length} memories:\n${lines.join("\n")}`;
}

function handleShow(category) {
  const entries = readIndex({ category, status: "active" });
  if (entries.length === 0) return `No active memories in: ${category}`;
  const lines = entries.map((e) => `- **${e.key}**: ${e.text}`).slice(0, 20);
  return `**${category}** (${entries.length}):\n${lines.join("\n")}`;
}

function handleForget(key) {
  const entries = searchMemory(key);
  if (entries.length === 0) return `No memories match: ${key}`;
  let count = 0;
  for (const e of entries) {
    markDeleted(e.id);
    count++;
  }
  return `Deleted ${count} memories matching: ${key}`;
}

function handlePending() {
  const items = readPending();
  if (items.length === 0) return "No pending memories.";
  const lines = items.map((e) => `[${e.id}] **${e.key}**: ${e.text}`).slice(0, 15);
  return `Pending (${items.length}):\n${lines.join("\n")}`;
}

function handleApprove(id) {
  const result = approvePending(id);
  return result ? `Approved: ${result.key}` : `Not found: ${id}`;
}

function handleReject(id) {
  const result = rejectPending(id);
  return result ? `Rejected: ${result.key}` : `Not found: ${id}`;
}

function handleUndo() {
  const result = undoLastWrite();
  return result ? `Undone: ${result.key}` : "Nothing to undo.";
}

function handlePrune(category) {
  const count = pruneCategory(category);
  return `Pruned ${count} entries from: ${category}`;
}

module.exports = { routeMemoryCommand };
