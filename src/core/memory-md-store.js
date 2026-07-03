"use strict";

const fs = require("fs");
const path = require("path");
const { getMemoryDir } = require("../core/config");

const CATEGORIES = ["facts", "preferences", "patterns", "projects", "open_loops", "relationships", "profile"];

function ensureCategoryFile(category) {
  const dir = getMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${category}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${category}\n\n`, "utf8");
  }
  return file;
}

function appendToMarkdown(category, text) {
  const file = ensureCategoryFile(category);
  const ts = new Date().toISOString();
  const entry = `\n### ${ts}\n${String(text).trim()}\n`;
  fs.appendFileSync(file, entry, "utf8");
}

function readMarkdown(category) {
  const file = path.join(getMemoryDir(), `${category}.md`);
  if (!fs.existsSync(file)) return "";
  return String(fs.readFileSync(file, "utf8"));
}

function listFiles() {
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) return [];
  return CATEGORIES.filter((c) => fs.existsSync(path.join(dir, `${c}.md`)));
}

module.exports = {
  CATEGORIES,
  appendToMarkdown,
  readMarkdown,
  listFiles,
};
