"use strict";

const { appendMemory, findDuplicate, findConflict, appendPending } = require("./memory-store");
const { appendToMarkdown } = require("./memory-md-store");
const { STRONG_SIGNAL_PATTERNS } = require("./memory-classifier");

const MINING_GATES = {
  minMinutesSinceLast: 30,
  minMessageCount: 20,
  minCharCount: 4000,
};

let lastMiningTime = null;
let messageBuffer = [];

function addToMiningBuffer(userText) {
  messageBuffer.push({ text: userText, ts: new Date().toISOString() });
  // Keep max 50 in buffer
  if (messageBuffer.length > 50) messageBuffer.shift();
}

function getMiningWindow() {
  // Return messages since last mining
  if (!lastMiningTime) return [...messageBuffer];
  return messageBuffer.filter((m) => new Date(m.ts) >= lastMiningTime);
}

/**
 * Check if batch mining should fire.
 */
function shouldRunBatchMining() {
  if (!lastMiningTime) {
    return messageBuffer.length >= 10; // First run: 10 messages
  }

  const minutesSince = (Date.now() - lastMiningTime.getTime()) / 60000;
  if (minutesSince >= MINING_GATES.minMinutesSinceLast) return true;

  const window = getMiningWindow();
  if (window.length >= MINING_GATES.minMessageCount) return true;

  const totalChars = window.reduce((sum, m) => sum + m.text.length, 0);
  if (totalChars >= MINING_GATES.minCharCount) return true;

  return false;
}

/**
 * Check if a message has a strong memory signal.
 */
function hasStrongMemorySignal(text) {
  if (!text) return false;
  return STRONG_SIGNAL_PATTERNS.some((re) => re.test(String(text)));
}

/**
 * Extract candidates from a single turn (strong signal).
 */
function extractCandidatesFromTurn(userText, replyText) {
  const candidates = [];
  const fullText = String(userText || "");

  // Rule-based extraction — no LLM needed for clear signals
  if (/记住/.test(fullText)) {
    const keyMatch = fullText.match(/记住[我你]?[喜欢爱好讨厌]?(.+)/);
    if (keyMatch) {
      const value = keyMatch[1].trim();
      candidates.push({
        category: "preferences",
        key: `pref_${hashKey(value)}`,
        value: value,
        priority: "soft_preference",
        text: `宝宝说：${value}`,
        source: "strong_signal",
      });
    }
  }

  if (/这是我的/.test(fullText)) {
    const factMatch = fullText.match(/这是[我你]的?(.+)/);
    if (factMatch) {
      const value = factMatch[1].trim();
      candidates.push({
        category: "facts",
        key: `fact_${hashKey(value)}`,
        value: value,
        priority: "hard_fact",
        text: value,
        source: "strong_signal",
      });
    }
  }

  if (/[从今][后以]/.test(fullText)) {
    candidates.push({
      category: "preferences",
      key: `pref_${hashKey(fullText)}`,
      value: fullText,
      priority: "hard_preference",
      text: fullText,
      source: "strong_signal",
    });
  }

  return candidates;
}

/**
 * Extract candidates from a batch window.
 */
function extractCandidatesFromWindow(window) {
  const candidates = [];
  const merged = window.map((m) => m.text).join("\n");

  // Only extract explicit preference patterns: "我喜欢/不喜欢/爱吃/讨厌 + specific thing"
  const prefPattern = /我(?:喜欢|不喜欢|讨厌|爱吃|爱喝|最[爱怕]|偏好|习惯).{2,15}/g;
  const prefMatches = merged.match(prefPattern);
  if (prefMatches) {
    const unique = [...new Set(prefMatches)];
    const filtered = unique.filter((s) => s.length >= 4 && !/[?？!！~～]/.test(s));
    for (const item of filtered.slice(0, 3)) {
      candidates.push({
        category: "preferences",
        key: `pref_like_${hashKey(item)}`,
        value: item,
        priority: "soft_preference",
        text: item,
        source: "batch_mining",
      });
    }
  }

  // Only extract explicit project patterns
  const projectPattern = /(?:在做|开发|改简历|改网站|投简历|面试|考证|考试).{2,20}/g;
  const projectMatches = merged.match(projectPattern);
  if (projectMatches) {
    const unique = [...new Set(projectMatches)];
    for (const item of unique.slice(0, 2)) {
      candidates.push({
        category: "projects",
        key: `proj_${hashKey(item)}`,
        value: item,
        priority: "pattern",
        text: item,
        source: "batch_mining",
      });
    }
  }

  return mergeCandidates(candidates);
}

function mergeCandidates(candidates) {
  const merged = [];
  const seen = new Set();
  for (const c of candidates) {
    const sig = `${c.category}:${c.key}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      merged.push(c);
    }
  }
  return merged;
}

/**
 * Write candidates with conflict checking.
 */
function writeCandidatesWithConflictCheck(candidates) {
  const written = [];
  for (const c of candidates) {
    if (findDuplicate(c)) continue;
    const conflict = findConflict(c);
    if (conflict) {
      // Don't overwrite hard items — go to pending
      appendPending(c);
      continue;
    }
    const entry = appendMemory(c);
    appendToMarkdown(c.category, `**${c.key}**: ${c.text}`);
    written.push(entry);
  }
  return written;
}

function markMiningComplete() {
  lastMiningTime = new Date();
}

function hashKey(text) {
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 100); i++) {
    h = (h * 31 + text.charCodeAt(i)) & 0x7fffffff;
  }
  return String(h);
}

module.exports = {
  getMiningWindow,
  addToMiningBuffer,
  shouldRunBatchMining,
  hasStrongMemorySignal,
  extractCandidatesFromTurn,
  extractCandidatesFromWindow,
  writeCandidatesWithConflictCheck,
  markMiningComplete,
};
