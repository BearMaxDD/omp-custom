import type { SupervisionHook, SupervisionFinding } from "../types";

/**
 * Detects repeated advisement of the same message content.
 * Returns undefined (truncates) when the identical message has been
 * seen 3 or more times consecutively.
 */
export function createRepeatAdviseDetector(): SupervisionHook {
	let lastMessage: string | undefined;
	let repeatCount = 0;

	return {
		id: "repeat_advise",
		onToolResult(event: { toolName: string; success: boolean }): SupervisionFinding | undefined {
			const msg = `Tool "${event.toolName}" succeeded=${event.success}`;

			if (msg === lastMessage) {
				repeatCount++;
			} else {
				lastMessage = msg;
				repeatCount = 1;
			}

			if (repeatCount >= 3) return undefined;

			return {
				id: "repeat_advise",
				detector: "repeat-advise-detector",
				severity: "nit",
				message: msg,
				timestamp: new Date().toISOString(),
			};
		},
	};
}
