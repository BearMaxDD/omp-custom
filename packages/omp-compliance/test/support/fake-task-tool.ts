/**
 * Fake TaskTool — simulates "task" tool call/result pairs for testing.
 *
 * Provides methods to record task delegations through the existing
 * ToolEventCollector public API (recordCall/recordResult), producing
 * evidence that aligns with the official normalizeTaskDelegation normalizer.
 *
 * Each generated record matches the result format expected by
 * task-delegation.ts: toolName === "task", resultRef is a JSON
 * string with agentId, exitCode, outputArtifacts, codebaseRefs.
 *
 * NEVER calls collector internals directly — only the public API.
 */

import { ToolEventCollector } from "../../src/signals/tool-event-collector";

/** Parameters for recording a single task delegation. */
export interface FakeDelegationParams {
	agentId: string;
	taskSummary: string;
	exitCode?: number;
	aborted?: boolean;
	outputArtifacts?: string[];
	codebaseRefs?: string[];
	durationMs?: number;
}

let callCounter = 0;

/**
 * Generate a unique toolCallId for each fake task call.
 */
function nextCallId(): string {
	callCounter++;
	return `fake-task-${Date.now()}-${callCounter}`;
}

export class FakeTaskTool {
	constructor(private readonly collector: ToolEventCollector) {}

	/**
	 * Record a single task delegation through the collector.
	 *
	 * Produces a tool_call with toolName "task" and a paired tool_result
	 * whose resultRef contains the delegation metadata the normalizer
	 * expects.
	 */
	recordDelegation(params: FakeDelegationParams): void {
		const toolCallId = nextCallId();
		const {
			agentId,
			taskSummary,
			exitCode = 0,
			aborted = false,
			outputArtifacts = [],
			codebaseRefs = [],
			durationMs,
		} = params;

		this.collector.recordCall({
			toolName: "task",
			toolCallId,
			params: { assignment: taskSummary, name: agentId },
			timestamp: new Date().toISOString(),
		});

		const resultPayload: Record<string, unknown> = {
			agentId,
			exitCode: aborted ? 1 : exitCode,
			outputArtifacts,
			codebaseRefs,
		};
		if (durationMs !== undefined) {
			resultPayload.durationMs = durationMs;
		}

		this.collector.recordResult({
			toolCallId,
			success: !aborted && exitCode === 0,
			resultRef: JSON.stringify(resultPayload),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a task call that produced no result (orphan call).
	 * The normalizer will mark this as "insufficient".
	 */
	recordOrphanCall(taskSummary: string): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "task",
			toolCallId,
			params: { assignment: taskSummary },
			timestamp: new Date().toISOString(),
		});
		// No matching recordResult — normalizer flags as insufficient
	}

	/**
	 * Record a task delegation that failed with an error result.
	 */
	recordFailedDelegation(agentId: string, taskSummary: string): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "task",
			toolCallId,
			params: { assignment: taskSummary, name: agentId },
			timestamp: new Date().toISOString(),
		});

		this.collector.recordResult({
			toolCallId,
			success: false,
			resultRef: JSON.stringify({
				agentId,
				exitCode: 1,
				error: "Subagent failed to complete the task",
			}),
			timestamp: new Date().toISOString(),
		});
	}
}
