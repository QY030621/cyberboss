"use strict";

/**
 * AutoDigest — automatic memory dehydration scheduler.
 *
 * Counts user messages. Every N messages, enqueues a system message that
 * prompts Claude to review recent conversation and extract memories using
 * the memory_* MCP tools.
 *
 * Pattern: just like TurnTracker + AutoDigest in auto_digest.py, but for Node.js.
 */

const fs = require("fs");
const path = require("path");

const DIGEST_EVERY = 20;

class AutoDigest {
  /**
   * @param {object} opts
   * @param {string} opts.stateDir — path to state dir for persisting turn count
   * @param {object} opts.conversationStore — ConversationStore instance
   * @param {function} opts.enqueueSystemMessage — (text: string) => void
   * @param {string} [opts.senderId] — user id for the system message
   * @param {string} [opts.workspaceRoot] — workspace root
   */
  constructor({ stateDir, conversationStore, enqueueSystemMessage, senderId = "", workspaceRoot = "" }) {
    this.stateDir = stateDir;
    this.conversationStore = conversationStore;
    this.enqueueSystemMessage = enqueueSystemMessage;
    this.senderId = senderId;
    this.workspaceRoot = workspaceRoot;
    this._trackerPath = path.join(stateDir, "autodigest-tracker.json");
    this._data = this._load();
    this._lastUserText = "";
  }

  _load() {
    try {
      if (fs.existsSync(this._trackerPath)) {
        return JSON.parse(fs.readFileSync(this._trackerPath, "utf8"));
      }
    } catch { /* ignore */ }
    return { totalUserMessages: 0, digests: [] };
  }

  _save() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this._trackerPath, JSON.stringify(this._data, null, 2), "utf8");
    } catch (e) {
      console.error(`[autodigest] failed to persist tracker: ${e.message}`);
    }
  }

  /**
   * Call after each user message is recorded.
   * Returns true if a digest was triggered.
   */
  recordTurn(userText = "") {
    const text = String(userText || "").trim();
    if (!text) return false;

    // Dedup: tool-call rounds send the same user text repeatedly
    if (text === this._lastUserText) return false;
    this._lastUserText = text;

    this._data.totalUserMessages += 1;
    this._save();

    const total = this._data.totalUserMessages;
    console.log(`[autodigest] turn ${total} | next digest at ${Math.ceil(total / DIGEST_EVERY) * DIGEST_EVERY}`);

    if (total % DIGEST_EVERY === 0) {
      this._triggerDigest(total);
      return true;
    }
    return false;
  }

  _triggerDigest(turnCount) {
    const prompt = [
      "🔁 自动记忆提炼 #" + (this._data.digests.length + 1),
      "",
      "⚠️ 优先回宝宝的消息。如果她正在跟你说话，先回她——记忆提炼等闲下来再做。",
      "",
      "你已经和宝宝聊了 " + turnCount + " 轮了。如果有空，请做一次记忆提炼：",
      "",
      "1. 回顾最近的对话（conversations/ 目录下今天的 JSONL 文件），找出值得长期记住的信息",
      "2. 使用 memory_write 工具写入记忆，分类参考：",
      "   - facts: 关于她的事实（生日、地址、喜欢的东西等）",
      "   - preferences: 她的偏好（喜欢什么、讨厌什么）",
      "   - patterns: 她的行为模式（几点起床、什么情况会熬夜等）",
      "   - projects: 进行中的项目和任务",
      "   - open_loops: 还没解决的事、约定了但没完成的",
      "   - relationships: 人际关系（朋友、家人等）",
      "   - profile: 她的个人档案（ADHD、MBTI等）",
      "3. 不要重复写入已经存在的记忆——先用 memory_search 查一下",
      "4. 每条记忆写一句简洁的话，key 要短（如 prefers_coffee）",
      "5. 写完后用 memory_list 确认一遍",
      "6. 最后在微信里告诉她一句话就够了，不要列清单",
      "",
      "做完这些就当做内部工作，不要在微信里逐条汇报。只告诉她一句总结。",
    ].join("\n");

    // Enqueue as a system message — will be delivered when thread is idle
    if (typeof this.enqueueSystemMessage === "function") {
      this.enqueueSystemMessage(prompt);
    }

    this._data.digests.push({
      index: this._data.digests.length + 1,
      turnCount,
      triggeredAt: new Date().toISOString(),
    });
    // Keep last 20 digest records
    this._data.digests = this._data.digests.slice(-20);
    this._save();

    console.log(`[autodigest] digest #${this._data.digests.length} triggered at turn ${turnCount}`);
  }

  /** Public stats for debugging */
  getStats() {
    return {
      totalUserMessages: this._data.totalUserMessages,
      digestsCompleted: this._data.digests.length,
      nextDigestAt: (Math.floor(this._data.totalUserMessages / DIGEST_EVERY) + 1) * DIGEST_EVERY,
      remaining: DIGEST_EVERY - (this._data.totalUserMessages % DIGEST_EVERY),
    };
  }
}

module.exports = { AutoDigest, DIGEST_EVERY };
