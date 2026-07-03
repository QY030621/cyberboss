"use strict";

// Patterns that indicate memory-process chatter that must NOT appear in WeChat replies.
const BLOCK_PATTERNS = [
  /index\.jsonl/,
  /pending\.jsonl/,
  /ops\.jsonl/,
  /memory[_-]?(store|index|classifier|validator|filter|miner)/i,
  /长期记忆/,
  /后台记忆/,
  /记忆[——]?回答时请参考以下已知信息/,
  /——后台记忆结束/,
  /记忆(系统|分类|读取|写入|整理|增量|检索)/,
  /后台(读取|写入|处理)/,
  /冲突校验/,
  /candidate\s*(extract|merge)/i,
  /batch\s*min(e|ing)/i,
  /classify(intent)?\s*\(/,
  /memory\s*slot/,
  /SLOT_RULES/,
  /\[硬(事实|偏好)\]/,
  /hard_(fact|preference)/i,
  /append(memory|pending)/i,
  /__memory_context__/,
  /pre[-_]?response/,
  /post[-_]?response/,
  /pref_\d{10}/,
  /MEMCTX:/,
  /\[硬(事实|偏好)\]/,
];

// Clean a single line of memory chatter
function cleanLine(line) {
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(line)) return "";
  }
  return line;
}

/**
 * Filter outgoing WeChat text — strip any memory-process chatter.
 * Returns the filtered text.
 */
function filterOutgoingMessage(text) {
  if (!text) return text;

  const lines = String(text).split("\n");
  const filtered = lines.map(cleanLine).filter(Boolean);
  return filtered.join("\n").trim();
}

/**
 * Quick check: would this text be blocked by the filter?
 */
function isBlocked(text) {
  return filterOutgoingMessage(text) !== String(text).trim();
}

module.exports = { filterOutgoingMessage, isBlocked };
