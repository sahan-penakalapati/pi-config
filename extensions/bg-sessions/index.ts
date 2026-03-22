/**
 * Background Sessions Extension
 *
 * Adds a `/bg` command and intercepts session switches to offer running
 * the current session in the background before switching away.
 *
 * Usage:
 *   /bg          - list background sessions
 *   /bg kill     - kill all background sessions
 *   /bg kill <n> - kill session #n
 *
 * When switching sessions via /resume or /new, you'll be asked whether
 * to keep the current session running in the background.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";

interface BgSession {
	id: number;
	sessionFile: string;
	sessionName: string;
	pid: number;
	status: "running" | "done" | "failed";
	exitCode: number | null;
	startedAt: number;
}

let nextId = 1;
const bgSessions: BgSession[] = [];
let latestUI: ExtensionUIContext | null = null;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function shortName(sessionFile: string): string {
	return path.basename(sessionFile, ".jsonl");
}

function refreshStatus(): void {
	if (!latestUI) return;
	const running = bgSessions.filter((s) => s.status === "running");
	if (running.length === 0) {
		latestUI.setStatus("bg-sessions", "");
		return;
	}
	const label = running.length === 1 ? "1 bg session" : `${running.length} bg sessions`;
	latestUI.setStatus("bg-sessions", `⚡ ${label} running — /bg to manage`);
}

function spawnBackground(sessionFile: string, sessionName: string, cwd: string): BgSession {
	const inv = getPiInvocation([
		"--session", sessionFile,
		"--mode", "json",
		"-p", "Continue autonomously. The user has switched to another session and will check back later.",
	]);

	const proc = spawn(inv.command, inv.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	proc.unref();

	const bg: BgSession = {
		id: nextId++,
		sessionFile,
		sessionName,
		pid: proc.pid ?? -1,
		status: "running",
		exitCode: null,
		startedAt: Date.now(),
	};

	proc.on("close", (code) => {
		bg.status = code === 0 ? "done" : "failed";
		bg.exitCode = code;
		refreshStatus();
	});

	bgSessions.push(bg);
	return bg;
}

export default function (pi: ExtensionAPI) {
	// Keep a reference to the latest UI context for background callbacks
	const saveUI = (ui: ExtensionUIContext) => {
		latestUI = ui;
	};

	// Intercept session switches and offer to keep current session running
	pi.on("session_before_switch", async (event, ctx) => {
		saveUI(ctx.ui);
		if (!ctx.hasUI) return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		// Only offer when idle
		if (!ctx.isIdle()) return;

		const sessionName = pi.getSessionName() ?? shortName(sessionFile);
		const action = event.reason === "new" ? "create a new session" : "switch sessions";

		const ok = await ctx.ui.confirm(
			"Keep current session running in background?",
			`You're about to ${action}.\n\nSpawn a background process to continue "${sessionName}"?`,
		);

		if (!ok) return;

		const bg = spawnBackground(sessionFile, sessionName, ctx.cwd);
		refreshStatus();
		ctx.ui.notify(`Session #${bg.id} "${sessionName}" running in background (PID ${bg.pid})`, "info");
	});

	// Refresh status after switch
	pi.on("session_switch", (_event, ctx) => {
		saveUI(ctx.ui);
		refreshStatus();
	});

	pi.on("session_start", (_event, ctx) => {
		saveUI(ctx.ui);
		refreshStatus();
	});

	// /bg command
	pi.registerCommand("bg", {
		description: "Manage background sessions. Usage: /bg | /bg kill [n]",
		handler: async (args, ctx) => {
			saveUI(ctx.ui);
			const trimmed = args.trim();

			// Kill subcommand
			if (trimmed.startsWith("kill")) {
				const rest = trimmed.slice(4).trim();
				if (rest === "") {
					// Kill all
					const running = bgSessions.filter((s) => s.status === "running");
					if (running.length === 0) {
						ctx.ui.notify("No background sessions running.", "info");
						return;
					}
					const ok = await ctx.ui.confirm(
						"Kill all background sessions?",
						`This will kill ${running.length} running session(s).`,
					);
					if (!ok) return;
					for (const bg of running) {
						try { process.kill(bg.pid, "SIGTERM"); } catch { /* already dead */ }
						bg.status = "failed";
						bg.exitCode = -1;
					}
					refreshStatus();
					ctx.ui.notify(`Killed ${running.length} background session(s).`, "success");
				} else {
					const n = parseInt(rest, 10);
					const bg = bgSessions.find((s) => s.id === n);
					if (!bg) {
						ctx.ui.notify(`No background session #${n}`, "error");
						return;
					}
					try { process.kill(bg.pid, "SIGTERM"); } catch { /* already dead */ }
					bg.status = "failed";
					bg.exitCode = -1;
					refreshStatus();
					ctx.ui.notify(`Killed session #${n} "${bg.sessionName}"`, "success");
				}
				return;
			}

			// List
			if (bgSessions.length === 0) {
				ctx.ui.notify("No background sessions.", "info");
				return;
			}

			const lines = bgSessions.map((bg) => {
				const age = Math.round((Date.now() - bg.startedAt) / 1000);
				const ageStr = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;
				const icon = bg.status === "running" ? "⚡" : bg.status === "done" ? "✓" : "✗";
				const pidStr = bg.status === "running" ? ` (PID ${bg.pid})` : ` (exit ${bg.exitCode ?? "?"})`;
				return `  ${icon} #${bg.id} ${bg.sessionName}${pidStr} — ${ageStr} ago`;
			});

			ctx.ui.notify(
				["Background sessions:", ...lines].join("\n"),
				"info",
			);
		},
	});
}
