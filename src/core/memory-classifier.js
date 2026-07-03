"use strict";

const { readIndex } = require("./memory-store");
const { readMarkdown } = require("./memory-md-store");

// Rules-based intent classifier — no LLM calls.
// Determines which memory slots to read based on keywords.

const SLOT_RULES = [
  {
    slot: "identity",
    category: "profile",
    keywords: ["我是", "我叫", "我的名字", "我的身份", "我是谁"],
  },
  {
    slot: "relationship",
    category: "relationships",
    keywords: ["你是我", "我是你的", "我们是什么", "你和我", "我们的关系", "老公", "老婆", "男朋友", "女朋友", "闺蜜", "妈妈", "爸爸", "家人"],
  },
  {
    slot: "preference",
    category: "preferences",
    keywords: ["喜欢", "不喜欢", "讨厌", "最爱", "最讨厌", "偏好", "习惯", "经常", "总是", "从不", "爱吃", "爱喝", "想要"],
  },
  {
    slot: "project",
    category: "projects",
    keywords: ["项目", "在做", "开发", "任务", "进度", "计划", "下次", "接下来", "TODO", "待办", "简历", "网站", "resume", "面试", "考试", "证书"],
  },
  {
    slot: "pattern",
    category: "patterns",
    keywords: ["每次都", "我总是", "我发现我", "我的模式", "老毛病", "又来了", "又这样"],
  },
  {
    slot: "open_loop",
    category: "open_loops",
    keywords: ["之前说", "上次", "还没", "忘了", "记得提醒", "别忘了", "还没做", "还没改"],
  },
  {
    slot: "fact",
    category: "facts",
    keywords: ["我住在", "我的地址", "我的电话", "我的邮箱", "我在", "我去过", "我住在"],
  },
];

const STRONG_SIGNAL_PATTERNS = [
  /记住[我你]/,
  /别忘了/,
  /不要忘了/,
  /这是我[的]?/,
  /我[真就]的?很?[爱喜讨厌][欢厌]/,
  /以后[都要别]/,
  /永远[不要别]/,
  /[从今以后]/,
  /我的底线/,
  /我的边界/,
  /我不[能会要]/,
];

/**
 * Classify user text -> which slots to read.
 * Returns { slots: string[], isStrongSignal: boolean, categories: string[] }
 */
function classifyIntent(text) {
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, "");
  if (!normalized) return { slots: [], isStrongSignal: false, categories: [] };

  const slots = [];
  const categories = new Set();

  for (const rule of SLOT_RULES) {
    for (const kw of rule.keywords) {
      if (normalized.includes(kw.toLowerCase())) {
        if (!slots.includes(rule.slot)) slots.push(rule.slot);
        categories.add(rule.category);
        break;
      }
    }
  }

  // Always add general slots for every message (lightweight)
  if (!slots.includes("preference")) slots.push("preference");
  if (!slots.includes("pattern")) slots.push("pattern");

  const isStrongSignal = STRONG_SIGNAL_PATTERNS.some((re) => re.test(normalized));

  return { slots, isStrongSignal, categories: [...categories] };
}

/**
 * Read memory entries relevant to the classified slots.
 * Returns a context string suitable for prepending to the reply prompt.
 */
function resolveMemoryContext(slots) {
  if (!slots || slots.length === 0) return "";

  const entries = readIndex({ status: "active" });
  if (entries.length === 0) return "";

  const relevant = entries.filter((e) => {
    if (e.priority === "hard_fact" || e.priority === "hard_preference") return true;
    return slots.includes(e.category) || (e.category && slots.includes(e.category));
  });

  if (relevant.length === 0) return "";

  // Sort: hard items first
  const priorityOrder = { hard_fact: 0, hard_preference: 1, soft_preference: 2, pattern: 3, project: 4, open_loop: 5 };
  relevant.sort((a, b) => (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9));

  // Build compact context — cap at 8 to avoid crowding the context window
  const lines = relevant.slice(0, 8).map((e) => {
    const label = e.priority === "hard_fact" ? "[硬事实]" : e.priority === "hard_preference" ? "[硬偏好]" : "";
    return `${label} [${e.category}] ${e.key}: ${e.text}`.trim();
  });

  return lines.join("\n");
}

module.exports = {
  classifyIntent,
  resolveMemoryContext,
  SLOT_RULES,
  STRONG_SIGNAL_PATTERNS,
};
