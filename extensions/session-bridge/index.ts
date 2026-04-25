import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { unlinkSync } from "node:fs";
import {
  HEARTBEAT_INTERVAL_MS,
  QUEUE_POLL_INTERVAL_MS,
  activeFileFor,
  archiveFailedMessage,
  archiveProcessedMessage,
  claimQueuedMessage,
  cleanupStaleSessionRecords,
  defaultSessionName,
  describeSession,
  ensureSessionDirs,
  getBridgeRoot,
  listQueuedMessages,
  loadActiveSessions,
  queueExternalMessage,
  readJson,
  resolveTargetSession,
  writeJson,
} from "./shared.js";

interface RuntimeState {
  sessionId: string | null;
  sessionFile?: string;
  startedAt: number;
  title?: string;
  activeTool?: string;
}

interface QueuedExternalMessage {
  id?: string;
  kind?: "message";
  sessionId?: string;
  sender?: string;
  deliverAs?: "steer" | "followUp";
  content?: string;
  createdAt?: string;
}

export default function sessionBridgeExtension(pi: ExtensionAPI) {
  let latestCtx: ExtensionContext | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let queuePollTimer: ReturnType<typeof setInterval> | null = null;
  const state: RuntimeState = {
    sessionId: null,
    sessionFile: undefined,
    startedAt: Date.now(),
    title: undefined,
    activeTool: undefined,
  };

  function updateStatus() {
    if (!latestCtx) return;
    if (!state.sessionId) {
      latestCtx.ui.setStatus("session-bridge", "");
      return;
    }
    const titleSuffix = state.title ? ` ${state.title}` : "";
    latestCtx.ui.setStatus("session-bridge", `📡 ${state.sessionId.slice(0, 8)}${titleSuffix}`);
  }

  function currentSessionRecord(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    return {
      sessionId,
      sessionFile,
      sessionName: defaultSessionName({
        sessionId,
        sessionFile,
        sessionName: pi.getSessionName(),
      }),
      title: state.title,
      activeTool: state.activeTool,
      pid: process.pid,
      cwd: ctx.cwd,
      isIdle: ctx.isIdle(),
      startedAt: state.startedAt,
      updatedAt: Date.now(),
      bridgeRoot: getBridgeRoot(),
    };
  }

  function writeHeartbeat(ctx: ExtensionContext) {
    const record = currentSessionRecord(ctx);
    state.sessionId = record.sessionId;
    state.sessionFile = record.sessionFile;
    ensureSessionDirs(record.sessionId);
    writeJson(activeFileFor(record.sessionId), record);
    updateStatus();
  }

  function removeCurrentRecord() {
    if (!state.sessionId) return;
    try {
      unlinkSync(activeFileFor(state.sessionId));
    } catch {}
    state.sessionId = null;
    state.sessionFile = undefined;
    state.title = undefined;
    state.activeTool = undefined;
    updateStatus();
  }

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (queuePollTimer) {
      clearInterval(queuePollTimer);
      queuePollTimer = null;
    }
  }

  async function processQueuedMessages() {
    if (!latestCtx || !state.sessionId) return;
    const sessionId = state.sessionId;
    const files = listQueuedMessages(sessionId);

    for (const file of files) {
      let claimedPath: string | null = null;
      try {
        claimedPath = claimQueuedMessage(file);
      } catch {
        continue;
      }

      try {
        const message = readJson(claimedPath) as QueuedExternalMessage;
        const content = typeof message.content === "string" ? message.content.trim() : "";
        if (!content) {
          archiveFailedMessage(claimedPath, sessionId, message.id ?? "invalid", "Missing message content");
          continue;
        }

        if (content.startsWith("/")) {
          archiveFailedMessage(
            claimedPath,
            sessionId,
            message.id ?? "invalid-command",
            "Slash commands are not supported by session-bridge injection; use a normal message or a future RPC bridge",
          );
          continue;
        }

        const deliverAs = message.deliverAs === "followUp" ? "followUp" : "steer";
        if (latestCtx.isIdle()) {
          await pi.sendUserMessage(content);
        } else {
          await pi.sendUserMessage(content, { deliverAs });
        }

        archiveProcessedMessage(claimedPath, sessionId, message.id ?? `processed-${Date.now()}`);
      } catch (error) {
        if (claimedPath) {
          archiveFailedMessage(claimedPath, sessionId, `failed-${Date.now()}`, error);
        }
        latestCtx.ui.notify(
          `[session-bridge] Failed to inject external message: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
  }

  function startLoops(ctx: ExtensionContext) {
    latestCtx = ctx;
    clearTimers();
    writeHeartbeat(ctx);
    cleanupStaleSessionRecords();

    heartbeatTimer = setInterval(() => {
      if (!latestCtx) return;
      writeHeartbeat(latestCtx);
    }, HEARTBEAT_INTERVAL_MS);

    queuePollTimer = setInterval(() => {
      processQueuedMessages().catch(() => {});
    }, QUEUE_POLL_INTERVAL_MS);
  }

  function refreshSession(ctx: ExtensionContext) {
    const nextSessionId = ctx.sessionManager.getSessionId();
    if (state.sessionId && state.sessionId !== nextSessionId) {
      removeCurrentRecord();
    }
    state.startedAt = Date.now();
    state.activeTool = undefined;
    startLoops(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    refreshSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearTimers();
    removeCurrentRecord();
  });

  pi.on("agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    writeHeartbeat(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    latestCtx = ctx;
    state.activeTool = undefined;
    writeHeartbeat(ctx);
  });

  pi.on("queue_update", async (_event, ctx) => {
    latestCtx = ctx;
    writeHeartbeat(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    latestCtx = ctx;
    state.activeTool = event.toolName;
    writeHeartbeat(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    latestCtx = ctx;
    state.activeTool = undefined;
    writeHeartbeat(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    latestCtx = ctx;
    if (event.toolName === "set_tab_title") {
      const title = typeof event.input?.title === "string" ? event.input.title.trim() : "";
      if (title) {
        state.title = title;
        writeHeartbeat(ctx);
      }
    }
  });

  pi.registerCommand("session-bridge", {
    description: "Show active bridged sessions and external messaging info",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const trimmed = args.trim();
      if (trimmed === "cleanup") {
        const removed = cleanupStaleSessionRecords();
        ctx.ui.notify(`[session-bridge] Removed ${removed} stale session record(s).`, "info");
        return;
      }

      writeHeartbeat(ctx);
      const sessions = loadActiveSessions();
      const currentId = ctx.sessionManager.getSessionId();
      const lines = [
        `Bridge root: ${getBridgeRoot()}`,
        `Current session: ${currentId}`,
        `Current file: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`,
        state.title ? `Current title: ${state.title}` : undefined,
        "",
        "Active bridged sessions:",
        ...(sessions.length > 0 ? sessions.map((session) => `${session.sessionId === currentId ? "*" : "-"} ${describeSession(session)}`) : ["- none"]),
        "",
        "External CLI:",
        `node ~/.pi/agent/extensions/session-bridge/cli.mjs list`,
        `node ~/.pi/agent/extensions/session-bridge/cli.mjs send ${currentId.slice(0, 8)} --mode steer \"your message\"`,
        `note: external slash commands like /reload are not supported by this bridge yet`,
      ].filter(Boolean) as string[];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("session-send", {
    description: "Queue a message into another active bridged session: /session-send <target> [--mode steer|followUp] <message>",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /session-send <target> [--mode steer|followUp] <message>", "warning");
        return;
      }

      const modeMatch = trimmed.match(/(?:^|\s)--mode\s+(steer|followUp)(?=\s|$)/);
      const mode = modeMatch?.[1] === "followUp" ? "followUp" : "steer";
      const withoutMode = modeMatch
        ? `${trimmed.slice(0, modeMatch.index)} ${trimmed.slice((modeMatch.index ?? 0) + modeMatch[0].length)}`.trim()
        : trimmed;
      const firstSpace = withoutMode.indexOf(" ");
      if (firstSpace === -1) {
        ctx.ui.notify("Usage: /session-send <target> [--mode steer|followUp] <message>", "warning");
        return;
      }

      const target = withoutMode.slice(0, firstSpace).trim();
      const message = withoutMode.slice(firstSpace + 1).trim();
      if (!message) {
        ctx.ui.notify("Message is required.", "warning");
        return;
      }

      const sessions = loadActiveSessions();
      let targetSession;
      try {
        targetSession = resolveTargetSession(target, sessions);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      let queued;
      try {
        queued = queueExternalMessage({
          sessionId: targetSession.sessionId,
          content: message,
          deliverAs: mode,
          sender: `session:${ctx.sessionManager.getSessionId()}`,
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      ctx.ui.notify(
        `[session-bridge] queued ${mode} message for ${targetSession.sessionName} (${targetSession.sessionId.slice(0, 8)})`,
        "success",
      );
      ctx.ui.notify(queued.path, "info");
    },
  });

  pi.registerTool({
    name: "session_bridge_list",
    label: "Session Bridge List",
    description: "List active pi sessions tracked by the session-bridge extension, including idle/busy state, title, active tool, cwd, and session file.",
    parameters: Type.Object({
      includeStale: Type.Optional(Type.Boolean({ description: "Include stale/dead session records. Default: false." })),
    }),

    async execute(_id, params) {
      const sessions = loadActiveSessions({ includeStale: params.includeStale ?? false });
      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No active bridged sessions." }],
          details: { sessions: [] },
        };
      }

      const text = sessions.map((session) => {
        const lines = [describeSession(session)];
        if (session.cwd) lines.push(`  cwd: ${session.cwd}`);
        if (session.sessionFile) lines.push(`  file: ${session.sessionFile}`);
        return lines.join("\n");
      }).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { sessions },
      };
    },
  });

  pi.registerTool({
    name: "session_bridge_send",
    label: "Session Bridge Send",
    description: "Send a text instruction into another active pi session through session-bridge. Supports steer and followUp delivery. Slash commands are intentionally not supported.",
    parameters: Type.Object({
      target: Type.String({ description: "Session id/prefix, session name substring, session file substring, or exact pid." }),
      message: Type.String({ description: "Normal text message to inject into the target session. Slash commands like /reload are not supported." }),
      mode: Type.Optional(Type.Union([
        Type.Literal("steer"),
        Type.Literal("followUp"),
      ], { description: "Delivery mode. steer is default; followUp waits for the current run to finish." })),
      sender: Type.Optional(Type.String({ description: "Optional sender label recorded in the queue payload." })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessions = loadActiveSessions();
      let targetSession;
      try {
        targetSession = resolveTargetSession(params.target, sessions);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { error: true, message: error instanceof Error ? error.message : String(error) },
        };
      }

      try {
        const queued = queueExternalMessage({
          sessionId: targetSession.sessionId,
          content: params.message,
          deliverAs: params.mode ?? "steer",
          sender: params.sender ?? `tool:${ctx.sessionManager.getSessionId()}`,
        });

        return {
          content: [{
            type: "text",
            text: `Queued ${(params.mode ?? "steer")} message for ${targetSession.sessionName} (${targetSession.sessionId.slice(0, 8)}).`,
          }],
          details: {
            target: targetSession,
            queueFile: queued.path,
            messageId: queued.id,
            deliverAs: queued.payload.deliverAs,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { error: true, message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  });
}
