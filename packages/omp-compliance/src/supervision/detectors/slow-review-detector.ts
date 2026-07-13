import type { SupervisionHook, SupervisionFinding } from "../types";

/**
 * Detects tool results that arrived >60 s after the previous tool result,
 * raising a nit.
 */
export function createSlowReviewDetector(): SupervisionHook {
	let lastTimestamp = Date.now();

	return {
		id: "slow_review",
		onToolResult(_event: { toolName: string; success: boolean }): SupervisionFinding | undefined {
			const now = Date.now();
			const elapsed = now - lastTimestamp;
			lastTimestamp = now;
			if (elapsed <= 60_000) return undefined;
			return {
				id: "slow_review",
				detector: "slow-review-detector",
				severity: "nit",
				message: `Tool result arrived after ${Math.round(elapsed / 1000)} s (>60 s threshold)`,
				timestamp: new Date().toISOString(),
			};
		},
	};
}
