/**
 * Fixes thinking.type for newer Anthropic models (opus-4-7+, sonnet-4-7+)
 * that require adaptive thinking but aren't yet recognized by pi-ai.
 *
 * pi-ai's supportsAdaptiveThinking() only checks for opus-4-6 / sonnet-4-6.
 * Newer models like claude-opus-4-7 fall through to budget-based
 * thinking.type:"enabled", which Anthropic rejects with:
 *   "thinking.type.enabled" is not supported for this model.
 *
 * This extension intercepts before_provider_request and patches the payload:
 *   thinking: { type: "enabled", budget_tokens: N }
 *     → thinking: { type: "adaptive" } + output_config: { effort: "high" }
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Model ID substrings that need adaptive thinking but pi-ai doesn't know about yet. */
const ADAPTIVE_PATTERNS = [
	"opus-4-7", "opus-4.7",
	"opus-4-8", "opus-4.8",
	"opus-4-9", "opus-4.9",
	"sonnet-4-7", "sonnet-4.7",
	"sonnet-4-8", "sonnet-4.8",
	"sonnet-4-9", "sonnet-4.9",
];

function needsAdaptiveFix(modelId: string): boolean {
	return ADAPTIVE_PATTERNS.some((p) => modelId.includes(p));
}

/** Map budget_tokens to a rough effort level. */
function budgetToEffort(budget: number, modelId: string): string {
	if (budget <= 1024) return "low";
	if (budget <= 8192) return "medium";
	if (budget <= 32768) return "high";
	// "max" only valid on Opus
	return modelId.includes("opus") ? "max" : "high";
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as Record<string, any>;
		const modelId: string = payload?.model ?? "";

		if (!needsAdaptiveFix(modelId)) return;

		const thinking = payload?.thinking;
		if (!thinking || thinking.type !== "enabled") return;

		// Patch: enabled → adaptive
		const effort = budgetToEffort(thinking.budget_tokens ?? 1024, modelId);
		payload.thinking = { type: "adaptive" };
		payload.output_config = { ...(payload.output_config ?? {}), effort };

		return payload;
	});
}
