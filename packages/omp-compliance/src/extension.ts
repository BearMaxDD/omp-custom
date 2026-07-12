import type { ExtensionAPI, ToolCallEventResult } from "./types";

/**
 * Activate the OMP Compliance extension.
 * Registers placeholder compliance command, completion tool,
 * and passive event handlers that do not block built-in behavior.
 */
export default function activate(api: ExtensionAPI): void {
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
	api.on("tool_call", () => {
		// Listen-only: never block tool execution
		return undefined as unknown as ToolCallEventResult;
	});

	api.on("tool_result", () => {
		// Listen-only: no action on tool results
		return undefined;
	});

	api.on("turn_end", () => {
		// Listen-only: observe turn boundaries
		return undefined;
	});

	api.on("agent_end", () => {
		// Listen-only: observe agent lifecycle
		return undefined;
	});
}
