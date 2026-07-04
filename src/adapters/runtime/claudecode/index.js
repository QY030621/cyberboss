const path = require("path");
const os = require("os");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByWorkspace = new Map();
  const pendingApprovals = new Map();
  let globalListener = null;
  const stateDir = config.stateDir || path.join(os.homedir(), ".cyberboss");
  const isWindows = process.platform === "win32";
  const ipcSocketPath = isWindows
    ? "\\\\.\\pipe\\cyberboss-claudecode-runtime"
    : path.join(stateDir, "claudecode-runtime.sock");
  const ipcServer = new ClaudeCodeIpcServer({ socketPath: ipcSocketPath, tokenDir: stateDir });

  ipcServer.on("clientMessage", (msg) => {
    if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
      }
    }
    if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
      }
    }
  });

  function ensureClient(workspaceRoot) {
    if (clientsByWorkspace.has(workspaceRoot)) {
      return clientsByWorkspace.get(workspaceRoot);
    }
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: workspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: config.claudeModel || "",
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot,
    });
    client.onMessage((event, raw) => {
      if (event.type !== "session.id" && event.type !== "context.updated" && event.type !== "thinking") {
        console.log(`[claudecode-lifecycle] EVENT type=${event.type} session=${event.sessionId || raw?.session_id || "?"}`);
      }
      if (event.type === "session.id") {
        for (const binding of sessionStore.listBindings()) {
          if (binding.activeWorkspaceRoot === workspaceRoot) {
            const pendingThreadId = normalizeThreadId(
              sessionStore.getPendingThreadIdForWorkspace(binding.bindingKey, workspaceRoot)
            );
            if (pendingThreadId) {
              if (pendingThreadId === normalizeThreadId(event.sessionId)) {
                sessionStore.setThreadIdForWorkspace(binding.bindingKey, workspaceRoot, event.sessionId);
                sessionStore.clearPendingThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
              }
            } else {
              sessionStore.setThreadIdForWorkspace(binding.bindingKey, workspaceRoot, event.sessionId);
            }
          }
        }
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = workspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, workspaceRoot);
      }
      if (mapped?.type === "runtime.turn.failed") {
        console.log(`[claudecode-lifecycle] TURN-FAILED on-message — closing workspace ${workspaceRoot}`);
        closeWorkspaceClient(workspaceRoot).catch((err) => {
          console.error(`[claudecode-runtime] failed to close client after turn failure: ${err.message}`);
        });
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
    });
    clientsByWorkspace.set(workspaceRoot, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "") {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    console.log(`[claudecode-lifecycle] ATTACH ws=${normalizedWorkspaceRoot} threadId=${normalizedThreadId || "(none)"} existingAlive=${Boolean(existingClient?.alive)} existingSession=${existingClient?.sessionId || "(none)"}`);

    if (normalizedThreadId && clientMatchesThread(existingClient, normalizedThreadId)) {
      console.log(`[claudecode-lifecycle] ATTACH REUSE — client matches thread`);
      return { client: existingClient, threadId: normalizedThreadId };
    }

    console.log(`[claudecode-lifecycle] ATTACH NO-MATCH — existingSession=${existingClient?.sessionId||"(none)"} wanted=${normalizedThreadId||"(none)"} existingAlive=${Boolean(existingClient?.alive)}`);

    if (!normalizedThreadId && existingClient?.alive) {
      console.log(`[claudecode-lifecycle] ATTACH CLOSE-OLD — no threadId, closing alive client`);
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    const client = ensureClient(normalizedWorkspaceRoot);
    if (!client.alive || (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))) {
      if (client.alive && normalizedThreadId && !clientMatchesThread(client, normalizedThreadId)) {
        console.log(`[claudecode-lifecycle] ATTACH RECONNECT — thread mismatch after ensureClient, closing`);
        await closeWorkspaceClient(normalizedWorkspaceRoot);
      }
      const freshClient = ensureClient(normalizedWorkspaceRoot);
      const needConnect = !freshClient.alive || (normalizedThreadId && !clientMatchesThread(freshClient, normalizedThreadId));
      if (needConnect) {
        console.log(`[claudecode-lifecycle] ATTACH FRESH — calling connect with resumeId=${normalizedThreadId || "(none)"}`);
        await freshClient.connect(normalizedThreadId);
      } else {
        console.log(`[claudecode-lifecycle] ATTACH FRESH — ensureClient returned alive matching client, no connect needed`);
      }
      if (normalizedThreadId) {
        return { client: freshClient, threadId: normalizedThreadId };
      }
      return { client: freshClient, threadId: freshClient.sessionId || normalizedThreadId };
    }

    console.log(`[claudecode-lifecycle] ATTACH REUSE — ensureClient returned alive client`);
    return { client, threadId: client.sessionId || normalizedThreadId };
  }
  async function closeWorkspaceClient(workspaceRoot) {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!normalizedWorkspaceRoot) {
      return;
    }
    const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
    console.log(`[claudecode-lifecycle] CLOSE-WORKSPACE ws=${normalizedWorkspaceRoot} hasClient=${Boolean(client)} clientAlive=${Boolean(client?.alive)}`);
    if (!client) {
      return;
    }
    await client.close();
    clientsByWorkspace.delete(normalizedWorkspaceRoot);
    for (const [requestId, candidateWorkspaceRoot] of pendingApprovals.entries()) {
      if (candidateWorkspaceRoot === normalizedWorkspaceRoot) {
        pendingApprovals.delete(requestId);
      }
    }
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
      };
    },
    async close() {
      for (const client of clientsByWorkspace.values()) {
        await client.close();
      }
      clientsByWorkspace.clear();
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      for (const binding of sessionStore.listBindings()) {
        if (binding.activeWorkspaceRoot === workspaceRoot) {
          sessionStore.clearPendingThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        }
      }
      await closeWorkspaceClient(workspaceRoot);
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      const workspaceRoot = pendingApprovals.get(requestId);
      const candidates = workspaceRoot
        ? [clientsByWorkspace.get(workspaceRoot)]
        : [...clientsByWorkspace.values()];
      for (const client of candidates) {
        if (client?.alive) {
          const responsePayload = result && typeof result === "object"
            ? result
            : { decision };
          await client.sendResponse(requestId, responsePayload);
          pendingApprovals.delete(requestId);
          return {
            requestId,
            ...(result && typeof result === "object"
              ? { result: responsePayload }
              : { decision: decision === "accept" ? "accept" : "decline" }),
          };
        }
      }
      throw new Error("no active claudecode session to respond to approval");
    },
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      if (workspaceRoot) {
        await closeWorkspaceClient(workspaceRoot);
        return { threadId, turnId };
      }
      for (const [workspaceRoot, client] of clientsByWorkspace.entries()) {
        if (client.sessionId === threadId) {
          await client.close();
          clientsByWorkspace.delete(workspaceRoot);
          return { threadId, turnId };
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot }) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const attached = await attachClientToThread(workspaceRoot, threadId);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId);
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      let openingTurn = !threadId;
      console.log(`[claudecode-lifecycle] SEND-TURN ws=${workspaceRoot} threadId=${threadId || "(none)"} openingTurn=${openingTurn} text=${String(text||"").slice(0,40)}`);
      let attached;
      try {
        attached = await attachClientToThread(workspaceRoot, threadId);
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
        openingTurn = true;
        attached = await attachClientToThread(workspaceRoot, "");
      }
      const { client, threadId: activeThreadId } = attached;
      const outboundText = openingTurn ? buildOpeningTurnText(config, text) : text;
      const outboundThreadId = activeThreadId || threadId || `pending-${Date.now()}`;
      await client.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      if (!openingTurn) {
        const confirmedSessionId = normalizeThreadId(
          client.sessionId || await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
        );
        if (confirmedSessionId !== normalizeThreadId(outboundThreadId)) {
          await closeWorkspaceClient(workspaceRoot);
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
          throw new Error(`claudecode resumed unexpected session id: ${confirmedSessionId || "(empty)"}`);
        }
      }
      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        outboundThreadId,
        metadata,
      );
      return {
        threadId: outboundThreadId,
        turnId: client.pendingTurnId,
      };
    },
  };
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { createClaudeCodeRuntimeAdapter };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}
