import type { SupervisionHook, SupervisionFinding } from "../types";

/**
 * Detects `write` and `edit` tool calls and raises a concern.
 */
export const codeWriteDetector: SupervisionHook = {
	id: "code_write",
	onToolResult(event: { toolName: string; success: boolean }): SupervisionFinding | undefined {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		return {
			id: "code_write",
			detector: "code-write-detector",
			severity: "concern",
			message: `Tool "${event.toolName}" was called (success=${event.success})`,
			timestamp: new Date().toISOString(),
		};
	},
};
