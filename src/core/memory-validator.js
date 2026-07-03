"use strict";

const { readIndex } = require("./memory-store");

/**
 * Check draft reply against hard_fact / hard_preference memory entries.
 * Returns conflicts found (empty array = no conflicts).
 */
function validateDraftAgainstMemory(draftText) {
  const hardEntries = readIndex({ status: "active" }).filter(
    (e) => e.priority === "hard_fact" || e.priority === "hard_preference"
  );
  if (hardEntries.length === 0) return [];

  const conflicts = [];
  const lower = String(draftText || "").toLowerCase();

  for (const entry of hardEntries) {
    if (entry.priority === "hard_fact") {
      // Check if draft contradicts a hard fact
      const factValue = String(entry.value || entry.text || "").toLowerCase();
      if (!factValue) continue;
      // Simple negation check: draft says "not X" when memory says "X"
      if (factValue && lower.includes(`不是${factValue}`) || lower.includes(`不${factValue}`)) {
        // Only flag if the contradiction is clear
        conflicts.push({ id: entry.id, category: entry.category, key: entry.key, value: entry.value, text: entry.text, reason: "draft_may_contradict_hard_fact" });
      }
    }
    if (entry.priority === "hard_preference") {
      // Check if draft violates a hard preference
      const prefValue = String(entry.value || entry.text || "").toLowerCase();
      if (!prefValue) continue;
      // If preference says "dislike X" and draft suggests doing X
      if (entry.key.includes("dislike") || entry.key.includes("hate") || entry.key.includes("avoid")) {
        if (lower.includes(prefValue)) {
          conflicts.push({ id: entry.id, category: entry.category, key: entry.key, value: entry.value, text: entry.text, reason: "draft_may_violate_hard_preference" });
        }
      }
    }
  }

  return conflicts;
}

module.exports = { validateDraftAgainstMemory };
