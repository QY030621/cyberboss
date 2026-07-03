const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = "conversations";

class ConversationStore {
  constructor({ dirPath = "" } = {}) {
    const resolved = (typeof dirPath === "string" && dirPath.trim()) ? dirPath.trim() : "";
    if (!resolved) {
      throw new Error("conversation store requires a dirPath");
    }
    this.dirPath = resolved;
  }

  /**
   * Append one message line to today's JSONL file.
   * @param {{ from: "rey"|"yanyan", text: string, time?: string, attachments?: Array<{kind:string,absolutePath:string}> }} entry
   */
  append(entry) {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const from = normalizeRole(entry.from);
    if (!from) {
      return;
    }
    const text = String(entry.text || "").trim();
    if (!text) {
      return;
    }

    const now = new Date();
    const today = formatDate(now);
    const timestamp = resolveTimestamp(entry.time, now);
    const filePath = path.join(this.dirPath, `${today}.jsonl`);

    const record = {
      timestamp,
      from,
      text,
    };

    if (Array.isArray(entry.attachments) && entry.attachments.length) {
      record.attachments = entry.attachments.map((att) => ({
        kind: att.kind || "file",
        path: att.absolutePath || att.path || "",
      }));
    }

    try {
      fs.mkdirSync(this.dirPath, { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
      console.error(`[conversation-store] write failed: ${error.message}`);
    }
  }

  /**
   * Read all messages for a given date, sorted by timestamp ASC.
   * @param {string} date "YYYY-MM-DD"
   * @returns {{ timestamp: string, from: string, text: string, attachments?: Array }[]}
   */
  readDate(date = "") {
    const normalized = normalizeDateString(date) || formatDate(new Date());
    const filePath = path.join(this.dirPath, `${normalized}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const records = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && parsed.from && parsed.text) {
            // Normalize legacy "time" → "timestamp"
            if (!parsed.timestamp && parsed.time) {
              parsed.timestamp = parsed.time.length <= 8
                ? `${normalized}T${parsed.time}`
                : parsed.time;
            }
            if (parsed.timestamp) {
              records.push(parsed);
            }
          }
        } catch {
          // skip malformed lines
        }
      }
      records.sort((a, b) => {
        const ta = Date.parse(a.timestamp) || 0;
        const tb = Date.parse(b.timestamp) || 0;
        return ta - tb;
      });
      return records;
    } catch {
      return [];
    }
  }

  /**
   * List all available date files.
   * @returns {string[]} sorted date strings "YYYY-MM-DD"
   */
  listDates() {
    try {
      const entries = fs.readdirSync(this.dirPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.replace(/\.jsonl$/i, ""))
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort();
    } catch {
      return [];
    }
  }
}

function normalizeRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "rey" || normalized === "yanyan") {
    return normalized;
  }
  return "";
}

function normalizeDateString(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveTimestamp(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  const str = String(value || "").trim();
  // Already a full ISO timestamp
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str)) {
    return str;
  }
  // Legacy HH:MM:SS — convert using fallback date
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(str)) {
    const base = fallback instanceof Date && !Number.isNaN(fallback.getTime())
      ? fallback.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return `${base}T${str}`;
  }
  // If fallback is a Date, use it; otherwise current time
  if (fallback instanceof Date && !Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return new Date().toISOString();
}

module.exports = { ConversationStore };
