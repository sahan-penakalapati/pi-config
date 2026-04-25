import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALE_MS = 15000;
export const QUEUE_POLL_INTERVAL_MS = 1000;

export function getBridgeRoot() {
  return join(homedir(), ".pi", "agent", "runtime", "session-bridge");
}

export function getActiveDir() {
  return join(getBridgeRoot(), "active");
}

export function getQueueRoot() {
  return join(getBridgeRoot(), "queue");
}

export function getProcessedRoot() {
  return join(getBridgeRoot(), "processed");
}

export function getFailedRoot() {
  return join(getBridgeRoot(), "failed");
}

export function ensureBridgeDirs() {
  mkdirSync(getActiveDir(), { recursive: true });
  mkdirSync(getQueueRoot(), { recursive: true });
  mkdirSync(getProcessedRoot(), { recursive: true });
  mkdirSync(getFailedRoot(), { recursive: true });
}

export function ensureSessionDirs(sessionId) {
  ensureBridgeDirs();
  mkdirSync(queueDirFor(sessionId), { recursive: true });
  mkdirSync(processedDirFor(sessionId), { recursive: true });
  mkdirSync(failedDirFor(sessionId), { recursive: true });
}

export function activeFileFor(sessionId) {
  return join(getActiveDir(), `${sessionId}.json`);
}

export function queueDirFor(sessionId) {
  return join(getQueueRoot(), sessionId);
}

export function processedDirFor(sessionId) {
  return join(getProcessedRoot(), sessionId);
}

export function failedDirFor(sessionId) {
  return join(getFailedRoot(), sessionId);
}

export function defaultSessionName(record) {
  const fromName = typeof record?.sessionName === "string" ? record.sessionName.trim() : "";
  if (fromName) return fromName;
  const file = typeof record?.sessionFile === "string" ? record.sessionFile : "";
  if (file) return basename(file, ".jsonl");
  return typeof record?.sessionId === "string" ? record.sessionId : "unknown";
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {}
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isRecordActive(record, now = Date.now()) {
  if (!record || typeof record !== "object") return false;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
  if (now - updatedAt > HEARTBEAT_STALE_MS) return false;
  return isPidAlive(record.pid);
}

export function loadActiveSessions({ includeStale = false } = {}) {
  ensureBridgeDirs();
  const files = readdirSync(getActiveDir())
    .filter((name) => name.endsWith(".json"))
    .sort();
  const now = Date.now();
  const sessions = [];

  for (const file of files) {
    const path = join(getActiveDir(), file);
    try {
      const record = readJson(path);
      const active = isRecordActive(record, now);
      if (!active && !includeStale) continue;
      sessions.push({
        ...record,
        active,
        stale: !active,
        sessionName: defaultSessionName(record),
      });
    } catch {}
  }

  sessions.sort((a, b) => {
    const aTime = typeof a.updatedAt === "number" ? a.updatedAt : 0;
    const bTime = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return bTime - aTime;
  });
  return sessions;
}

export function cleanupStaleSessionRecords() {
  const sessions = loadActiveSessions({ includeStale: true });
  let removed = 0;
  for (const session of sessions) {
    if (session.active) continue;
    removeFile(activeFileFor(session.sessionId));
    removed++;
  }
  return removed;
}

export function resolveTargetSession(target, sessions) {
  const query = target.trim().toLowerCase();
  if (!query) throw new Error("Target is required");

  const matches = sessions.filter((session) => {
    const sessionId = String(session.sessionId ?? "").toLowerCase();
    const sessionName = String(session.sessionName ?? "").toLowerCase();
    const sessionFile = String(session.sessionFile ?? "").toLowerCase();
    const pid = String(session.pid ?? "");
    return (
      sessionId === query ||
      sessionId.startsWith(query) ||
      sessionName === query ||
      sessionName.includes(query) ||
      sessionFile.includes(query) ||
      pid === query
    );
  });

  if (matches.length === 0) {
    throw new Error(`No active session matched \"${target}\"`);
  }
  if (matches.length > 1) {
    const labels = matches.slice(0, 5).map((session) => `${session.sessionId} (${session.sessionName})`).join(", ");
    throw new Error(`Target \"${target}\" is ambiguous: ${labels}`);
  }
  return matches[0];
}

export function normalizeDeliveryMode(mode) {
  return mode === "followUp" ? "followUp" : "steer";
}

export function queueExternalMessage({ sessionId, content, deliverAs = "steer", sender = "external" }) {
  if (!sessionId?.trim()) throw new Error("sessionId is required");
  if (!content?.trim()) throw new Error("content is required");
  if (content.trim().startsWith("/")) {
    throw new Error("session-bridge cannot execute slash commands yet; send a normal message instead");
  }

  ensureSessionDirs(sessionId);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const file = join(queueDirFor(sessionId), `${id}.json`);
  const payload = {
    id,
    kind: "message",
    sessionId,
    sender,
    deliverAs: normalizeDeliveryMode(deliverAs),
    content,
    createdAt: new Date().toISOString(),
  };
  writeJson(file, payload);
  return { id, path: file, payload };
}

export function claimQueuedMessage(path) {
  const claimed = `${path}.processing-${process.pid}`;
  renameSync(path, claimed);
  return claimed;
}

export function archiveProcessedMessage(claimedPath, sessionId, messageId) {
  ensureSessionDirs(sessionId);
  const archived = join(processedDirFor(sessionId), `${messageId}.json`);
  renameSync(claimedPath, archived);
  return archived;
}

export function archiveFailedMessage(claimedPath, sessionId, messageId, error) {
  ensureSessionDirs(sessionId);
  const failedPath = join(failedDirFor(sessionId), `${messageId}.json`);
  let payload;
  try {
    payload = readJson(claimedPath);
  } catch {
    payload = { id: messageId, sessionId };
  }
  payload.failedAt = new Date().toISOString();
  payload.error = error instanceof Error ? error.message : String(error);
  writeJson(failedPath, payload);
  removeFile(claimedPath);
  return failedPath;
}

export function listQueuedMessages(sessionId) {
  ensureSessionDirs(sessionId);
  return readdirSync(queueDirFor(sessionId))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(queueDirFor(sessionId), name));
}

export function describeSession(record) {
  const updatedAgoMs = Date.now() - (typeof record.updatedAt === "number" ? record.updatedAt : 0);
  const ageSeconds = Math.max(0, Math.round(updatedAgoMs / 1000));
  const ageLabel = ageSeconds < 60 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}m`;
  const state = record.isIdle ? "idle" : "busy";
  const title = typeof record.title === "string" && record.title.trim()
    ? `  title=${JSON.stringify(record.title.trim())}`
    : "";
  const activeTool = typeof record.activeTool === "string" && record.activeTool.trim()
    ? `  tool=${record.activeTool.trim()}`
    : "";
  return `${record.sessionId}  ${record.sessionName}  pid=${record.pid}  ${state}${activeTool}${title}  seen=${ageLabel} ago`;
}

export function tryReadJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

export function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
