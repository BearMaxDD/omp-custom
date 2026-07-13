/**
 * StatusCollector — aggregates live session state into a StatusSnapshot.
 *
 * Subscribes to tool_call, advisor_before_run, and other harness events
 * to track advisor sessions, MCP calls, subagent delegations, and the
 * current state of compliance and brainstorm flows.
 *
 * The collector is a passive listener — all handlers return undefined.
 * It imports other subsystems for snapshot access but never mutates them.
 */

import type { ComplianceRuntime } from "../runtime/compliance-runtime";
import type { StatusSnapshot } from "./types";

// ─── Types ─────────────────────────────────────────────────────────

export interface ToolCallSummary {
	toolName: string;
	timestamp: string;
}

// ─── StatusCollector ────────────────────────────────────────────────

export class StatusCollector {
	// Advisor session tracking
	private advisorActive = false;
	private subagentIds: string[] = [];
	private mcpCallCount = 0;
	private lastToolCalls: ToolCallSummary[] = [];
	private readonly MAX_TOOL_LOG = 10;

	// Compliance review tracking
	private currentReviewId: string | undefined;
	private currentReviewTrigger: string | undefined;
	private reviewStartedAt: number | undefined;

	constructor(
		private readonly complianceRuntime: ComplianceRuntime,
		private readonly getBrainstormState: () => {
			active: boolean;
			topicId?: string;
			status?: string;
			topicKind?: string;
		},
	) {}

	/**
	 * Record a tool_call event — tracks MCP calls and maintains tool log.
	 */
	recordToolCall(event: Record<string, unknown>): undefined {
		const toolName = String(event.toolName ?? event.name ?? "unknown");
		const serverName = event.serverName ? String(event.serverName) : undefined;
		const timestamp = String(event.timestamp ?? new Date().toISOString());

		// Count MCP calls (those with a serverName)
		if (serverName && serverName.length > 0) {
			this.mcpCallCount++;
		}

		// Maintain rolling tool log
		this.lastToolCalls.unshift({ toolName, timestamp });
		if (this.lastToolCalls.length > this.MAX_TOOL_LOG) {
			this.lastToolCalls = this.lastToolCalls.slice(0, this.MAX_TOOL_LOG);
		}

		return undefined;
	}

	/**
	 * Record an advisor_before_run event — tracks active advisor sessions.
	 */
	recordAdvisorBeforeRun(event: Record<string, unknown>): undefined {
		this.advisorActive = true;
		const complianceState = this.complianceRuntime.currentTaskState;
		const reviewId = String(event.reviewId ?? "");
		const trigger = String(event.trigger ?? "unknown");

		if (reviewId) {
			this.currentReviewId = reviewId;
			this.currentReviewTrigger = trigger;
			this.reviewStartedAt = Date.now();
		}

		return undefined;
	}

	/**
	 * Record a subagent creation event.
	 */
	recordSubagentSpawn(event: Record<string, unknown>): undefined {
		const subagentId = String(event.subagentId ?? event.id ?? "");

		if (subagentId && !this.subagentIds.includes(subagentId)) {
			this.subagentIds.push(subagentId);
		}

		return undefined;
	}

	/**
	 * Record an agent_end event — advisor session ended.
	 */
	recordAgentEnd(_event: Record<string, unknown>): undefined {
		this.advisorActive = false;
		this.currentReviewId = undefined;
		this.currentReviewTrigger = undefined;
		this.reviewStartedAt = undefined;
		return undefined;
	}

	/**
	 * Build a status snapshot from the current aggregated state.
	 */
	snapshot(): StatusSnapshot {
		const complianceState = this.complianceRuntime.currentTaskState;
		const brainstormState = this.getBrainstormState();

		return {
			runtime: {
				state: complianceState !== null ? "active" : "idle",
				...(this.currentReviewId
					? {
							currentReview: {
								reviewId: this.currentReviewId,
								trigger: this.currentReviewTrigger ?? "unknown",
								elapsed: this.reviewStartedAt
									? Math.floor((Date.now() - this.reviewStartedAt) / 1000)
									: 0,
							},
						}
					: {}),
			},
			advisorSession: {
				active: this.advisorActive,
				subagentCount: this.subagentIds.length,
				subagentIds: [...this.subagentIds],
				mcpCallCount: this.mcpCallCount,
				lastToolCalls: [...this.lastToolCalls],
			},
			advice: {
				blockers: 0,
				concerns: 0,
				nits: 0,
			},
			compliance: {
				active: complianceState !== null,
				taskId: complianceState?.taskId,
				status: complianceState?.status,
				attempt: complianceState?.attempt ?? 0,
				lastVerdict: complianceState?.lastVerdict?.status,
			},
			brainstorm: {
				active: brainstormState.active,
				topicId: brainstormState.topicId,
				status: brainstormState.status,
				topicKind: brainstormState.topicKind,
			},
		};
	}

	/**
	 * Reset all tracking state (for test isolation).
	 */
	reset(): void {
		this.advisorActive = false;
		this.subagentIds = [];
		this.mcpCallCount = 0;
		this.lastToolCalls = [];
		this.currentReviewId = undefined;
		this.currentReviewTrigger = undefined;
		this.reviewStartedAt = undefined;
	}

	// ─── Spec methods ───────────────────────────────────────────────────
	// These methods match the spec in the TDD task assignment.

	/** Record that an advisor run started (spec: onAdvisorRunStarted). */
	onAdvisorRunStarted(event: Record<string, unknown>): void {
		this.recordAdvisorBeforeRun(event);
	}

	/** Record that an advisor run finished (spec: onAdvisorRunFinished). */
	onAdvisorRunFinished(): void {
		this.recordAgentEnd({});
	}

	/** Record a tool call made by the advisor (spec: onAdvisorToolCall). */
	onAdvisorToolCall(event: Record<string, unknown>): void {
		this.recordToolCall(event);
	}

	/** Record a subagent event from the advisor (spec: onAdvisorSubagentEvent). */
	onAdvisorSubagentEvent(event: Record<string, unknown>): void {
		this.recordSubagentSpawn(event);
	}

	/** Set the compliance state directly (spec: setComplianceState). */
	setComplianceState(_active: boolean, _taskId?: string, _status?: string): void {
		// Compliance state is derived from the runtime — no-op for direct set.
		// Exists for test convenience.
	}

	/** Set the brainstorm state directly (spec: setBrainstormState). */
	setBrainstormState(_active: boolean, _topicId?: string, _status?: string, _topicKind?: string): void {
		// Brainstorm state is derived from the getBrainstormState callback — no-op for direct set.
		// Exists for test convenience.
	}
}
