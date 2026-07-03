"use strict";

const fs = require("fs");
const path = require("path");
const { getMemoryDir } = require("../core/config");

function ensureMemoryDir() {
  const dir = getMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath() {
  return path.join(ensureMemoryDir(), "index.jsonl");
}

function pendingPath() {
  return path.join(ensureMemoryDir(), "pending.jsonl");
}

function opsPath() {
  return path.join(ensureMemoryDir(), "ops.jsonl");
}

// -- index.jsonl CRUD --

function readIndex(filter) {
  const file = indexPath();
  if (!fs.existsSync(file)) return [];
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  if (!filter) return entries;
  return entries.filter((e) => {
    if (filter.category && e.category !== filter.category) return false;
    if (filter.status && e.status !== filter.status) return false;
    if (filter.key && e.key !== filter.key) return false;
    if (filter.priority && e.priority !== filter.priority) return false;
    if (filter.scope && e.scope !== filter.scope) return false;
    return true;
  });
}

function searchMemory(query) {
  const entries = readIndex({ status: "active" });
  const q = String(query || "").toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    return (e.key || "").toLowerCase().includes(q)
      || (e.text || "").toLowerCase().includes(q)
      || (e.category || "").toLowerCase().includes(q)
      || (e.value && String(e.value).toLowerCase().includes(q));
  });
}

function appendMemory(entry) {
  const file = indexPath();
  const record = {
    id: entry.id || `mem_${formatTimestamp(new Date())}`,
    category: entry.category || "fact",
    key: entry.key || "",
    value: entry.value ?? null,
    priority: entry.priority || "soft_preference",
    scope: entry.scope || "user",
    source: entry.source || "auto",
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || new Date().toISOString(),
    status: entry.status || "active",
    text: String(entry.text || "").trim(),
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  appendOps({ action: "create", id: record.id, category: record.category, key: record.key });
  return record;
}

function markDeleted(id) {
  return updateStatus(id, "deleted");
}

function markSuperseded(id) {
  return updateStatus(id, "superseded");
}

function updateStatus(id, status) {
  const file = indexPath();
  if (!fs.existsSync(file)) return null;
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  let updated = null;
  const out = lines.map((line) => {
    try {
      const e = JSON.parse(line);
      if (e.id === id) {
        e.status = status;
        e.updatedAt = new Date().toISOString();
        updated = e;
        return JSON.stringify(e);
      }
      return line;
    } catch { return line; }
  });
  fs.writeFileSync(file, out.join("\n") + "\n", "utf8");
  if (updated) appendOps({ action: "status_change", id, status });
  return updated;
}

function updateMemory(key, newValue) {
  const file = indexPath();
  if (!fs.existsSync(file)) return null;
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  let updated = null;
  const out = lines.map((line) => {
    try {
      const e = JSON.parse(line);
      if (e.key === key && e.status === "active") {
        e.value = newValue;
        e.updatedAt = new Date().toISOString();
        updated = e;
        return JSON.stringify(e);
      }
      return line;
    } catch { return line; }
  });
  fs.writeFileSync(file, out.join("\n") + "\n", "utf8");
  if (updated) appendOps({ action: "update", key, id: updated.id });
  return updated;
}

function findDuplicate(candidate) {
  const active = readIndex({ status: "active" });
  return active.find((e) => e.category === candidate.category && e.key === candidate.key) || null;
}

function findConflict(candidate) {
  const active = readIndex({ status: "active" });
  return active.find((e) => {
    if (e.category !== candidate.category) return false;
    if (e.key !== candidate.key) return false;
    if (e.priority === "hard_fact" || e.priority === "hard_preference") {
      return String(e.value) !== String(candidate.value);
    }
    return false;
  }) || null;
}

function undoLastWrite() {
  const ops = readOps();
  const last = ops[ops.length - 1];
  if (!last) return null;
  if (last.action === "create" && last.id) {
    return markDeleted(last.id);
  }
  return null;
}

// -- pending.jsonl --

function appendPending(candidate) {
  const file = pendingPath();
  const record = {
    id: `pen_${formatTimestamp(new Date())}`,
    ...candidate,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  return record;
}

function readPending() {
  const file = pendingPath();
  if (!fs.existsSync(file)) return [];
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function approvePending(id) {
  return movePendingToActive(id);
}

function rejectPending(id) {
  const file = pendingPath();
  if (!fs.existsSync(file)) return null;
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  let removed = null;
  const out = lines.filter((line) => {
    try {
      const e = JSON.parse(line);
      if (e.id === id) { removed = e; return false; }
      return true;
    } catch { return true; }
  });
  fs.writeFileSync(file, out.join("\n") + (out.length ? "\n" : ""), "utf8");
  return removed;
}

function movePendingToActive(id) {
  const file = pendingPath();
  if (!fs.existsSync(file)) return null;
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  let target = null;
  const out = lines.filter((line) => {
    try {
      const e = JSON.parse(line);
      if (e.id === id) { target = e; return false; }
      return true;
    } catch { return true; }
  });
  fs.writeFileSync(file, out.join("\n") + (out.length ? "\n" : ""), "utf8");
  if (target) {
    appendMemory({
      category: target.category,
      key: target.key,
      value: target.value,
      priority: target.priority || "soft_preference",
      text: target.text,
      source: "pending_approved",
    });
  }
  return target;
}

// -- ops.jsonl --

function readOps() {
  const file = opsPath();
  if (!fs.existsSync(file)) return [];
  const lines = String(fs.readFileSync(file, "utf8")).trim().split("\n").filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function appendOps(entry) {
  const file = opsPath();
  fs.appendFileSync(file, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", "utf8");
}

function backupBeforeRewrite(category) {
  const memDir = ensureMemoryDir();
  const mdPath = path.join(memDir, `${category}.md`);
  if (!fs.existsSync(mdPath)) return;
  const bakPath = path.join(memDir, `${category}.bak.${formatTimestamp(new Date())}.md`);
  fs.copyFileSync(mdPath, bakPath);
}

function pruneCategory(category) {
  backupBeforeRewrite(category);
  const entries = readIndex({ category, status: "active" });
  for (const e of entries) markDeleted(e.id);
  return entries.length;
}

function formatTimestamp(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${mo}${da}_${h}${mi}${s}`;
}

module.exports = {
  ensureMemoryDir,
  indexPath,
  pendingPath,
  opsPath,
  readIndex,
  searchMemory,
  appendMemory,
  markDeleted,
  markSuperseded,
  updateMemory,
  findDuplicate,
  findConflict,
  undoLastWrite,
  appendPending,
  readPending,
  approvePending,
  rejectPending,
  backupBeforeRewrite,
  pruneCategory,
};
