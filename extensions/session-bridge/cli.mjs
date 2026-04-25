#!/usr/bin/env node
import {
  cleanupStaleSessionRecords,
  describeSession,
  loadActiveSessions,
  queueExternalMessage,
  resolveTargetSession,
} from "./shared.js";

function usage() {
  console.log(`session-bridge CLI

Usage:
  node ~/.pi/agent/extensions/session-bridge/cli.mjs list [--json] [--all]
  node ~/.pi/agent/extensions/session-bridge/cli.mjs cleanup
  node ~/.pi/agent/extensions/session-bridge/cli.mjs send <target> [--mode steer|followUp] [--sender name] <message>

Notes:
  - slash commands like /reload are not supported by this bridge yet
  - titles from set_tab_title and the current active tool are shown in session listings

Target matching:
  - full or partial session id
  - session name substring
  - session file substring
  - exact pid
`);
}

function parseFlag(args, name, defaultValue = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return { value: defaultValue, args };
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    return { value: true, args: [...args.slice(0, index), ...args.slice(index + 1)] };
  }
  return {
    value,
    args: [...args.slice(0, index), ...args.slice(index + 2)],
  };
}

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}

if (command === "list") {
  const includeStale = argv.includes("--all");
  const asJson = argv.includes("--json");
  const sessions = loadActiveSessions({ includeStale });
  if (asJson) {
    console.log(JSON.stringify(sessions, null, 2));
    process.exit(0);
  }
  if (sessions.length === 0) {
    console.log("No active bridged sessions.");
    process.exit(0);
  }
  for (const session of sessions) {
    console.log(`${session.active ? "*" : "x"} ${describeSession(session)}`);
    if (session.sessionFile) console.log(`    file: ${session.sessionFile}`);
  }
  process.exit(0);
}

if (command === "cleanup") {
  const removed = cleanupStaleSessionRecords();
  console.log(`Removed ${removed} stale session record(s).`);
  process.exit(0);
}

if (command === "send") {
  let args = argv.slice(1);
  const modeResult = parseFlag(args, "--mode", "steer");
  args = modeResult.args;
  const senderResult = parseFlag(args, "--sender", "external-cli");
  args = senderResult.args;

  if (args.length < 2) {
    usage();
    process.exit(1);
  }

  const target = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!message) {
    console.error("Message is required.");
    process.exit(1);
  }

  const sessions = loadActiveSessions();
  let session;
  try {
    session = resolveTargetSession(target, sessions);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let queued;
  try {
    queued = queueExternalMessage({
      sessionId: session.sessionId,
      content: message,
      deliverAs: modeResult.value === "followUp" ? "followUp" : "steer",
      sender: typeof senderResult.value === "string" ? senderResult.value : "external-cli",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    deliverAs: queued.payload.deliverAs,
    queueFile: queued.path,
    messageId: queued.id,
  }, null, 2));
  process.exit(0);
}

usage();
process.exit(1);
