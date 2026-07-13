/**
 * Status types for the StatusCollector and CLI renderer.
 *
 * Defines the composite StatusSnapshot shape produced by the collector
 * and consumed by the CLI panel renderer for the status command.
 */

export interface StatusSnapshot {
	runtime: {
		state: "active" | "idle";
		currentReview?: {
			reviewId: string;
			trigger: string;
			elapsed: number;
		};
		progress?: {
			current: number;
			total: number;
			phase: string;
		};
	};
	advisorSession: {
		active: boolean;
		subagentCount: number;
		subagentIds: string[];
		mcpCallCount: number;
		lastToolCalls: Array<{ toolName: string; timestamp: string }>;
	};
	advice: {
		blockers: number;
		concerns: number;
		nits: number;
	};
	compliance: {
		active: boolean;
		taskId?: string;
		status?: string;
		attempt: number;
		lastVerdict?: string;
	};
	brainstorm: {
		active: boolean;
		topicId?: string;
		status?: string;
		topicKind?: string;
	};
}
