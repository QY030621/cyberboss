// Restore memories on cloud — run once: node scripts/restore-memories.js
const fs = require("fs");
const path = require("path");
const os = require("os");

const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const memDir = path.join(stateDir, "memory");
const indexPath = path.join(memDir, "index.jsonl");

fs.mkdirSync(memDir, { recursive: true });

const data = require("./restore-memories-data.json");

let written = 0;
for (const m of data) {
  const record = {
    id: m.id || ("mem_r_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)),
    category: m.category,
    key: m.key,
    value: m.value || null,
    priority: m.priority || "soft_preference",
    scope: "user",
    source: "cloud_restore",
    createdAt: m.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    text: m.text || "",
  };
  fs.appendFileSync(indexPath, JSON.stringify(record) + "\n", "utf8");
  written++;
}

console.log("Restored " + written + " memories to " + indexPath);
