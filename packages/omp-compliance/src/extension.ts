import type { ExtensionAPI } from "./types";
import { CollectorRuntime } from "./signals/collector-runtime";

/**
 * Activate the OMP Compliance extension.
 * Registers compliance command, completion tool,
 * and passive event handlers for tool event collection.
 */
export default function activate(api: ExtensionAPI): void {
	const runtime = new CollectorRuntime();

	// Register compliance command
	api.registerCommand("compliance", {
		description: "Run compliance checks for Oh My Pi repository",
		handler: async (_args: string[]) => {
			// Placeholder — compliance check logic added in subsequent tasks
		},
	});

	// Register compliance completion tool
	api.registerTool({
		name: "compliance_complete",
		description: "Notify the compliance system that a task has been completed and recheck compliance",
		handler: async (_params: Record<string, unknown>) => {
			// Placeholder — completion handling added in subsequent tasks
			return { success: true };
		},
	});

	// Passive event handlers — all return undefined (no blocking)
	api.on("tool_call", (event) => runtime.recordToolCall(event as Record<string, unknown>));
	api.on("tool_result", (event) => runtime.recordToolResult(event as Record<string, unknown>));
	api.on("turn_end", (event) => runtime.recordTurnEnd(event as Record<string, unknown>));
	api.on("agent_end", () => runtime.refreshPresentation());
}
