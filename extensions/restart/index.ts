/**
 * Restart Command Extension
 *
 * Adds a /restart command that starts a fresh session, clearing conversation history.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("restart", {
		description: "Start a fresh session, clearing conversation history",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
