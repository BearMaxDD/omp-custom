/**
 * Core type definitions for Tool Event Collection and Signal Processing.
 *
 * Defines the raw event shapes observed from the extension event system,
 * the normalized evidence structures, and the composite snapshot produced
 * by the ToolEventCollector.
 *
 * The collector processes three families of events:
 * - tool_call / tool_result pairs (linked by toolCallId)
 * - turn_end bookends
 * - agent_end for presentation refresh
 *
 * Normalized evidence is produced by specialized modules (codebase-memory,
 * task-delegation, verification) feeding off the same raw event stream.
 */

/** A captured tool_call event with selected fields. */
export interface ToolCallRecord {
	/** The tool name as emitted by the harness. */
	toolName: string;
	/** Unique call id used to correlate with the result. */
	toolCallId: string;
	/** The server name, if this was an MCP tool call. */
	serverName?: string;
	/** Canonical server-qualified tool identity, when the call was recognized. */
	qualifiedName?: string;
	/** Fingerprint of the full canonical arguments before parameter truncation. */
	argsFingerprint?: `sha256:${string}`;
	/** A redacted / limited parameter summary (keys preserved, values truncated). */
	params: Record<string, unknown>;
	/** Working directory supplied by the extension context. */
	cwd?: string;
	/** Active session id supplied by the extension context. */
	sessionId?: string;
	/** ISO timestamp of the call. */
	timestamp: string;
}

/** A captured tool_result event linked back to its call. */
export interface ToolResultRecord {
	/** Matches the toolCallId in the corresponding ToolCallRecord. */
	toolCallId: string;
	/** Whether the tool call completed without a known error indication. */
	success: boolean;
	/** A reference or truncated representation of the result payload. */
	resultRef: string;
	/** Bounded JSON-safe structured result details retained for downstream normalizers. */
	details?: Record<string, unknown>;
	/** ISO timestamp of the result. */
	timestamp: string;
}

/** Normalized evidence for one codebase-memory tool interaction. */
export interface CodebaseMemoryEvidence {
	/** The MCP server name that provided the tool. */
	serverName: string;
	/** The exact tool name recognized by the normalizer. */
	toolName: string;
	/** Whether the tool completed successfully. */
	success: boolean;
	/** A limited parameter summary (keys preserved, values truncated). */
	params: Record<string, unknown>;
	/** A reference to the original result artifact. */
	resultRef: string;
}

/** Normalized evidence for one task (subagent) delegation. */
export interface TaskDelegationEvidence {
	/** The agent id assigned to the subtask, if available. */
	agentId?: string;
	/** The background job id assigned to an asynchronous task call, if available. */
	jobId?: string;
	/** The agent definition used by the host, kept separate from the run id. */
	agent?: string;
	/** A short summary or assignment string. */
	taskSummary?: string;
	/** The exit status: "completed", "aborted", or "insufficient". */
	status: "completed" | "aborted" | "insufficient";
	/** Duration in seconds, if available. */
	durationMs?: number;
	/** Exit code from the subagent process. */
	exitCode?: number;
	/** Output artifact references produced by the subtask. */
	outputArtifacts: string[];
	/** Codebase references mentioned in the result (e.g. file paths). */
	codebaseRefs: string[];
}

/** Normalized evidence for one verification command execution. */
export interface VerificationEvidence {
	/** The command that was executed. */
	command: string;
	/** The exit code produced. */
	exitCode: number;
	/** A summary of changed paths, if available. */
	changedPaths: string[];
	/** Whether the verification passed (exit code 0). */
	passed: boolean;
}

/**
 * Composite snapshot produced by ToolEventCollector.snapshot().
 */
export interface EvidenceSnapshot {
	/** Raw call records (for debugging / downstream normalization). */
	calls: ToolCallRecord[];
	/** Raw result records linked to calls. */
	results: ToolResultRecord[];
	/** Normalized codebase-memory evidence. */
	codebaseMemory: {
		/** Whether at least one index_status result indicated readiness. */
		indexReady: boolean;
		/** Distinct tool names used for queries. */
		queries: string[];
		/** Codebase references collected from search / snippet results. */
		references: string[];
	};
	/** Normalized task delegation evidence. */
	subagentDelegations: TaskDelegationEvidence[];
	/** Normalized verification evidence. */
	verifications: VerificationEvidence[];
}
