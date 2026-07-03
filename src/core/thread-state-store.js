const fs = require("fs");
const path = require("path");

class ThreadStateStore {
  constructor({ filePath = "" } = {}) {
    this.stateByThreadId = new Map();
    this.latestContextByRuntime = new Map();
    this.filePath = typeof filePath === "string" ? filePath.trim() : "";
    this._load();
  }

  _save() {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = {
        updatedAt: new Date().toISOString(),
        threads: Array.from(this.stateByThreadId.entries()).map(([id, state]) => [
          id,
          {
            threadId: state.threadId,
            turnId: state.turnId,
            status: state.status,
            lastReplyText: state.lastReplyText,
            lastError: state.lastError,
            pendingApprovals: state.pendingApprovals,
            updatedAt: state.updatedAt,
          },
        ]),
      };
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (_err) {
      // best-effort persistence
    }
  }

  _load() {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const threads = Array.isArray(parsed?.threads) ? parsed.threads : [];
      for (const [id, state] of threads) {
        if (!id || !state) continue;
        this.stateByThreadId.set(id, {
          threadId: state.threadId || id,
          turnId: state.turnId || "",
          status: normalizePersistedStatus(state.status),
          lastReplyText: state.lastReplyText || "",
          lastError: state.lastError || "",
          context: null,
          pendingApprovals: Array.isArray(state.pendingApprovals) ? state.pendingApprovals : [],
          updatedAt: state.updatedAt || new Date().toISOString(),
        });
      }
    } catch (_err) {
      // best-effort — start with empty state on corruption
    }
  }

  _maybeSave() {
    if (this.filePath) {
      setImmediate(() => this._save());
    }
  }

  applyRuntimeEvent(event) {
    if (event?.type === "runtime.context.updated") {
      const updatedAt = new Date().toISOString();
      const runtimeId = normalizeRuntimeId(event?.payload?.runtimeId);
      const snapshot = {
        ...event.payload,
        updatedAt,
      };
      if (runtimeId) {
        this.latestContextByRuntime.set(runtimeId, snapshot);
      }
      const threadId = normalizeThreadId(event?.payload?.threadId);
      if (threadId) {
        const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
        this.stateByThreadId.set(threadId, {
          ...current,
          context: snapshot,
          updatedAt,
        });
      }
      return;
    }
    if (!event || !event.payload || !event.payload.threadId) {
      return;
    }

    const threadId = event.payload.threadId;
    const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
    const next = {
      ...current,
      updatedAt: new Date().toISOString(),
    };

    switch (event.type) {
      case "runtime.turn.started":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = "";
        break;
      case "runtime.reply.delta":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.reply.completed":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.approval.requested": {
        next.status = "waiting_approval";
        const approvalEntry = {
          kind: event.payload.kind || "command",
          requestId: event.payload.requestId ?? null,
          reason: event.payload.reason || "",
          command: event.payload.command || "",
          commandTokens: Array.isArray(event.payload.commandTokens) ? event.payload.commandTokens : [],
          filePath: event.payload.filePath || "",
          filePaths: Array.isArray(event.payload.filePaths) ? event.payload.filePaths.slice() : [],
          elicitation: event.payload.elicitation || null,
          responseTemplate: event.payload.responseTemplate || null,
        };
        const existingQueue = Array.isArray(current.pendingApprovals) ? current.pendingApprovals : [];
        if (existingQueue.some((entry) => entry.requestId === approvalEntry.requestId)) {
          break;
        }
        // Replace stale entries with the same command but different requestId
        // (claude code was respawned and assigned new requestIds)
        const freshQueue = existingQueue.filter(
          (entry) => entry.kind !== approvalEntry.kind || entry.command !== approvalEntry.command
        );
        next.pendingApprovals = [...freshQueue, approvalEntry];
        break;
      }
      case "runtime.turn.completed":
        next.status = "idle";
        next.turnId = event.payload.turnId || next.turnId;
        next.pendingApprovals = [];
        break;
      case "runtime.turn.failed":
        next.status = "failed";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = event.payload.text || "❌ Execution failed";
        next.pendingApprovals = [];
        break;
      default:
        break;
    }

    this.stateByThreadId.set(threadId, next);
    // Only persist on meaningful state transitions (skip reply.delta — fires per token)
    if (
      event.type === "runtime.approval.requested" ||
      event.type === "runtime.turn.started" ||
      event.type === "runtime.turn.completed" ||
      event.type === "runtime.turn.failed"
    ) {
      this._maybeSave();
    }
  }

  getThreadState(threadId) {
    return this.stateByThreadId.get(threadId) || null;
  }

  resolveApproval(threadId, status = "running", requestId = "") {
    const current = this.stateByThreadId.get(threadId);
    if (!current) {
      return null;
    }
    const pendingApprovals = Array.isArray(current.pendingApprovals) ? current.pendingApprovals : [];
    const remaining = requestId
      ? pendingApprovals.filter((entry) => entry.requestId !== requestId)
      : [];
    const nextStatus = remaining.length > 0 ? "waiting_approval" : status;
    const next = {
      ...current,
      status: nextStatus,
      pendingApprovals: remaining,
      updatedAt: new Date().toISOString(),
    };
    this.stateByThreadId.set(threadId, next);
    this._maybeSave();
    return next;
  }

  snapshot() {
    return Array.from(this.stateByThreadId.values()).map((entry) => ({ ...entry }));
  }

  getLatestContext(runtimeId) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) {
      return null;
    }
    const snapshot = this.latestContextByRuntime.get(normalizedRuntimeId);
    return snapshot ? { ...snapshot } : null;
  }
}

function createEmptyThreadState(threadId) {
  return {
    threadId,
    turnId: "",
    status: "idle",
    lastReplyText: "",
    lastError: "",
    context: null,
    pendingApprovals: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRuntimeId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeThreadId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePersistedStatus(status) {
  const allowed = new Set(["idle", "running", "waiting_approval", "failed"]);
  return allowed.has(status) ? status : "idle";
}

module.exports = { ThreadStateStore };
