/**
 * Remind the agent to use edit instead of write for existing files.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let writeCount = 0;

	pi.on("tool_result", async (event) => {
		if (event.toolName === "write") writeCount++;
	});

	return {
		on: "tool_execution_end",
		when: () => writeCount >= 50,
		message: "You've used write 50+ times. Prefer edit for surgical changes to existing files.",
		cooldown: 5,
	};
}
