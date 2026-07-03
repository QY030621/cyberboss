"use strict";

/**
 * Memory Tool Host — exposes memory-store and memory-md-store to Claude via MCP.
 */

const memoryStore = require("../core/memory-store");
const mdStore = require("../core/memory-md-store");

const CATEGORIES = mdStore.CATEGORIES || ["facts", "preferences", "patterns", "projects", "open_loops", "relationships", "profile"];
const PRIORITIES = ["hard_fact", "soft_fact", "hard_preference", "soft_preference"];

class MemoryToolHost {
  listTools() {
    return [
      {
        name: "memory_search",
        description:
          "Search active memories by keyword. Returns matching memory entries with category, key, value, and text. Input: { query: string }",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search keyword for memories" },
          },
        },
      },
      {
        name: "memory_write",
        description: `Write a new memory entry. Category must be one of: ${CATEGORIES.join(", ")}. Priority: ${PRIORITIES.join(", ")}. Input: { category: string, key: string, value?: string, text: string, priority?: string }`,
        inputSchema: {
          type: "object",
          required: ["category", "key", "text"],
          properties: {
            category: {
              type: "string",
              description: `Memory category: ${CATEGORIES.join(", ")}`,
            },
            key: {
              type: "string",
              description: "Short unique key for this memory (e.g. 'prefers_coffee')",
            },
            value: {
              type: "string",
              description: "Optional structured value (JSON string okay)",
            },
            text: {
              type: "string",
              description: "Human-readable memory content",
            },
            priority: {
              type: "string",
              description: `Priority: ${PRIORITIES.join(", ")}. Default: soft_preference`,
            },
          },
        },
      },
      {
        name: "memory_list",
        description: `List all active memories, optionally filtered by category. Input: { category?: string }`,
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: `Filter by category: ${CATEGORIES.join(", ")}`,
            },
          },
        },
      },
      {
        name: "memory_forget",
        description: "Mark a memory entry as deleted by its id. Input: { id: string }",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", description: "Memory entry id to delete" },
          },
        },
      },
    ];
  }

  async invokeTool(toolName, args = {}) {
    switch (toolName) {
      case "memory_search": {
        const query = String(args.query || "").trim();
        if (!query) throw new Error("query is required");
        const results = memoryStore.searchMemory(query);
        return {
          found: results.length,
          results: results.map(formatEntry),
        };
      }
      case "memory_write": {
        const category = String(args.category || "").trim();
        const key = String(args.key || "").trim();
        const text = String(args.text || "").trim();
        if (!CATEGORIES.includes(category)) {
          throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
        }
        if (!key) throw new Error("key is required");
        if (!text) throw new Error("text is required");

        const priority = PRIORITIES.includes(String(args.priority || "").trim())
          ? String(args.priority).trim()
          : "soft_preference";

        // Check for duplicates before writing
        const existing = memoryStore.findDuplicate({ category, key });
        if (existing && existing.status === "active") {
          // Update existing instead
          memoryStore.updateMemory(key, String(args.value ?? text));
          return {
            written: false,
            updated: true,
            id: existing.id,
            key,
            message: `Updated existing memory '${key}'`,
          };
        }

        const entry = memoryStore.appendMemory({
          category,
          key,
          value: args.value ?? null,
          text,
          priority,
          source: "claude_auto",
        });

        // Also write to markdown for human readability
        const mdLines = [`**${key}** (${priority})`, text];
        if (args.value) {
          mdLines.push(`\`${String(args.value)}\``);
        }
        mdStore.appendToMarkdown(category, mdLines.join("\n"));

        return {
          written: true,
          id: entry.id,
          key: entry.key,
          category: entry.category,
          message: `Memory '${key}' stored in ${category}.`,
        };
      }
      case "memory_list": {
        const category = String(args.category || "").trim();
        let entries;
        if (category && CATEGORIES.includes(category)) {
          entries = memoryStore.readIndex({ category, status: "active" });
        } else {
          entries = memoryStore.readIndex({ status: "active" });
        }
        return {
          count: entries.length,
          memories: entries.map(formatEntry),
        };
      }
      case "memory_forget": {
        const id = String(args.id || "").trim();
        if (!id) throw new Error("id is required");
        const result = memoryStore.markDeleted(id);
        return {
          forgotten: Boolean(result),
          id,
          message: result ? `Memory '${id}' marked as deleted.` : `Memory '${id}' not found.`,
        };
      }
      default:
        throw new Error(`Unknown memory tool: ${toolName}`);
    }
  }
}

function formatEntry(e) {
  return {
    id: e.id,
    category: e.category,
    key: e.key,
    value: e.value,
    priority: e.priority,
    text: e.text,
    createdAt: e.createdAt,
  };
}

module.exports = { MemoryToolHost };
