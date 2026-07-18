/**
 * Task Tool Delegation Evidence Normalizer.
 *
 * Recognizes "task" tool calls and extracts subagent delegation
 * evidence from paired tool_call / tool_result events.
 *
 * Only toolName === "task" is matched. Empty calls, missing results,
 * or error results produce "insufficient" status evidence.
 *
 * Fields extracted:
 *   - agent id from result details
 *   - task summary / assignment description
 *   - exit code and aborted indicator
 *   - duration in milliseconds
 *   - output artifact references
 *   - codebase references from the result
 */

import type { TaskDelegationEvidence, ToolCallRecord, ToolResultRecord } from "./types";

const TASK_TOOL_NAME = "task";
const HUB_TOOL_NAME = "hub";

export interface NormalizedDelegationEvent {
	readonly delegationId: string;
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly toolCallId: string;
	readonly transport: "task" | "hub";
	readonly status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
	readonly workPackage?: string;
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
}

/** Normalize only official structured task/hub results into supervision events. */
export function normalizeDelegationEvents(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
): NormalizedDelegationEvent[] {
	const events: NormalizedDelegationEvent[] = [];
	for (const pair of paired) {
		if (pair.call.toolName === TASK_TOOL_NAME) events.push(...normalizeTaskEvents(pair.call, pair.result));
		if (pair.call.toolName === HUB_TOOL_NAME) events.push(...normalizeHubEvents(pair.call, pair.result));
	}
	return events;
}

/**
 * Normalize paired call/result entries into task delegation evidence.
 *
 * Filters to entries whose toolName === "task" and produces structured
 * evidence records. Batch calls can produce one entry per result plus an
 * asynchronous call-level placeholder while background work is unresolved.
 */
export function normalizeTaskDelegation(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
): TaskDelegationEvidence[] {
	const results: TaskDelegationEvidence[] = [];

	for (const { call, result } of paired) {
		if (call.toolName !== TASK_TOOL_NAME) continue;

		if (!result) {
			// Call with no result → insufficient evidence
			results.push({
				status: "insufficient",
				taskSummary: extractTaskSummary(call.params),
				outputArtifacts: [],
				codebaseRefs: [],
			});
			continue;
		}

		if (!result.success) {
			// Error result → insufficient evidence
			results.push({
				status: "insufficient",
				taskSummary: extractTaskSummary(call.params),
				outputArtifacts: [],
				codebaseRefs: [],
			});
			continue;
		}

		if (result.detailsTruncated || (result.source === "official" && !isTaskToolDetails(result.details ?? {}))) {
			results.push(emptyEvidence(call, result.detailsFailure ? "aborted" : "insufficient"));
			continue;
		}

		// Official v17 Task evidence is structured-only. Text fallback is legacy-fixture compatibility.
		const details =
			result.source === "official"
				? (result.details ?? {})
				: { ...parseResultDetails(result.resultRef), ...result.details };
		if (isTaskToolDetails(details)) {
			const asyncDetails = readRecord(details.async);
			if (details.results.length === 0) {
				results.push(asyncEvidence(call, asyncDetails));
				continue;
			}

			const evidenceCount = results.length;
			for (const value of details.results) {
				const single = readRecord(value);
				if (!single) continue;
				const exitCode = toFiniteNumber(single.exitCode);
				const aborted = single.aborted === true || hasNonEmptyString(single.error);
				const outputArtifacts = collectOutputArtifacts(single);
				const codebaseRefs = extractCodebaseRefs(`${outputArtifacts.join(" ")} ${safeStringify(single)}`);

				results.push({
					agentId: toOptionalString(single.id),
					agent: toOptionalString(single.agent),
					taskSummary: extractSingleResultSummary(single) ?? extractTaskSummary(call.params),
					status: !aborted && exitCode === 0 ? "completed" : "aborted",
					durationMs: toFiniteNumber(single.durationMs),
					exitCode,
					outputArtifacts,
					codebaseRefs,
				});
			}
			if (results.length === evidenceCount) results.push(emptyEvidence(call, "insufficient"));
			if (asyncDetails?.state === "running" || asyncDetails?.state === "failed") {
				results.push(asyncEvidence(call, asyncDetails));
			}
			continue;
		}

		const agentId = details.agentId ?? details.agent ?? call.params.agent ?? call.params.name;
		const exitCode = details.exitCode ?? details.exit ?? details.code;
		const aborted = details.aborted ?? details.cancelled ?? false;
		const durationMs = details.durationMs ?? details.duration;
		const outputArtifacts = collectOutputArtifacts(details);

		// Extract codebase references from output text
		const codebaseRefs = extractCodebaseRefs(
			`${outputArtifacts.join(" ")} ${JSON.stringify(details)} ${result.resultRef}`,
		);

		results.push({
			agentId: agentId != null ? String(agentId) : undefined,
			taskSummary: extractTaskSummary(call.params),
			status: aborted ? "aborted" : exitCode === 0 ? "completed" : "aborted",
			durationMs: durationMs != null ? Number(durationMs) : undefined,
			exitCode: exitCode != null ? Number(exitCode) : undefined,
			outputArtifacts,
			codebaseRefs,
		});
	}

	return results;
}

function normalizeTaskEvents(call: ToolCallRecord, result?: ToolResultRecord): NormalizedDelegationEvent[] {
	if (!result) {
		return [delegationEvent(call, call.toolCallId, "task", "queued", extractTaskSummary(call.params), [])];
	}
	if (
		result.source !== "official" ||
		result.detailsTruncated ||
		!result.details ||
		!isTaskToolDetails(result.details)
	) {
		return [];
	}

	const evidenceIds = [`tool-result:${call.toolCallId}`];
	const events: NormalizedDelegationEvent[] = [];
	for (const value of result.details.results) {
		const single = readRecord(value);
		if (!single) continue;
		const id = toOptionalString(single.id);
		if (!id) continue;
		events.push({
			...delegationEvent(
				call,
				id,
				"task",
				taskResultStatus(single, result.success),
				extractSingleResultSummary(single) ?? extractTaskSummary(call.params),
				evidenceIds,
			),
			agentId: id,
		});
	}

	const asyncDetails = readRecord(result.details.async);
	const jobId = toOptionalString(asyncDetails?.jobId);
	if (events.length === 0 && jobId && asyncDetails?.state === "running") {
		events.push(delegationEvent(call, jobId, "task", "running", extractTaskSummary(call.params), evidenceIds));
	}
	if (events.length === 0 && jobId && asyncDetails?.state === "failed") {
		events.push(delegationEvent(call, jobId, "task", "failed", extractTaskSummary(call.params), evidenceIds));
	}
	return events;
}

function normalizeHubEvents(call: ToolCallRecord, result?: ToolResultRecord): NormalizedDelegationEvent[] {
	if (
		!result?.success ||
		result.source !== "official" ||
		result.detailsTruncated ||
		!result.details ||
		!isHubJobDetails(result.details)
	) {
		return [];
	}

	const evidenceIds = [`tool-result:${call.toolCallId}`];
	return result.details.jobs
		.filter((job) => job.type === "task")
		.map((job) => ({
			...delegationEvent(call, job.id, "hub", hubJobStatus(job), job.label, evidenceIds),
			agentId: job.id,
		}));
}

function delegationEvent(
	call: ToolCallRecord,
	delegationId: string,
	transport: "task" | "hub",
	status: NormalizedDelegationEvent["status"],
	workPackage: string | undefined,
	toolEvidenceIds: readonly string[],
): NormalizedDelegationEvent {
	return {
		delegationId,
		sessionId: call.sessionId,
		toolCallId: call.toolCallId,
		transport,
		status,
		workPackage,
		actualFiles: [],
		toolEvidenceIds,
	};
}

function taskResultStatus(
	result: Record<string, unknown>,
	toolSucceeded: boolean,
): NormalizedDelegationEvent["status"] {
	const reason = toOptionalString(result.abortReason)?.toLowerCase() ?? "";
	if (reason.includes("timed out") || reason.includes("timeout")) return "timed_out";
	if (!toolSucceeded || hasNonEmptyString(result.error) || toFiniteNumber(result.exitCode) !== 0) return "failed";
	if (result.aborted !== true) return "completed";
	return reason.includes("cancel") ? "cancelled" : "failed";
}

interface HubTaskJob {
	readonly id: string;
	readonly type: "task" | "bash";
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	readonly durationMs: number;
	readonly errorText?: string;
}

function hubJobStatus(job: HubTaskJob): NormalizedDelegationEvent["status"] {
	if (job.status === "failed" && /timed?\s*out|timeout/i.test(job.errorText ?? "")) return "timed_out";
	return job.status;
}

function isHubJobDetails(
	details: Record<string, unknown>,
): details is Record<string, unknown> & { jobs: HubTaskJob[] } {
	if (!Array.isArray(details.jobs)) return false;
	return details.jobs.every((value) => {
		const job = readRecord(value);
		return (
			job !== undefined &&
			isNonEmptyString(job.id) &&
			(job.type === "task" || job.type === "bash") &&
			(job.status === "running" ||
				job.status === "completed" ||
				job.status === "failed" ||
				job.status === "cancelled") &&
			isNonEmptyString(job.label) &&
			isFiniteNumber(job.durationMs) &&
			(job.errorText === undefined || typeof job.errorText === "string")
		);
	});
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse result details from a result reference string.
 *
 * Tries JSON parse first; falls back to interpreting the string
 * as raw text. Returns parsed fields or empty object.
 */
function parseResultDetails(ref: string): Record<string, unknown> {
	if (!ref) return {};
	try {
		const parsed = JSON.parse(ref);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return { output: ref };
	} catch {
		// Not JSON — return as raw output
		return { output: ref };
	}
}

function collectOutputArtifacts(details: Record<string, unknown>): string[] {
	const artifacts: string[] = [];
	for (const value of [
		details.artifacts,
		details.outputs,
		details.output,
		details.outputPath,
		details.patchPath,
		details.branchName,
	]) {
		if (Array.isArray(value)) {
			artifacts.push(...value.map(String));
		} else if (typeof value === "string") {
			artifacts.push(value);
		}
	}
	return [...new Set(artifacts)];
}

const AGENT_SOURCES = new Set(["bundled", "user", "project"]);

function isTaskToolDetails(
	details: Record<string, unknown>,
): details is Record<string, unknown> & { results: unknown[] } {
	if (
		!(details.projectAgentsDir === null || typeof details.projectAgentsDir === "string") ||
		!Array.isArray(details.results) ||
		!isFiniteNumber(details.totalDurationMs)
	) {
		return false;
	}
	if (details.outputPaths !== undefined && !isStringArray(details.outputPaths)) return false;
	if (details.async !== undefined && !isTaskAsyncDetails(details.async)) return false;
	return details.results.every(isSingleResult);
}

function isSingleResult(value: unknown): value is Record<string, unknown> {
	const result = readRecord(value);
	if (!result) return false;
	if (
		!isFiniteNumber(result.index) ||
		!isNonEmptyString(result.id) ||
		!isNonEmptyString(result.agent) ||
		!AGENT_SOURCES.has(String(result.agentSource)) ||
		typeof result.task !== "string" ||
		!isFiniteNumber(result.exitCode) ||
		typeof result.output !== "string" ||
		typeof result.stderr !== "string" ||
		typeof result.truncated !== "boolean" ||
		!isFiniteNumber(result.durationMs) ||
		!isFiniteNumber(result.tokens) ||
		!isFiniteNumber(result.requests)
	) {
		return false;
	}
	for (const key of [
		"assignment",
		"description",
		"lastIntent",
		"error",
		"abortReason",
		"outputPath",
		"patchPath",
		"branchName",
		"branchBaseSha",
		"resolvedModel",
	] as const) {
		if (result[key] !== undefined && typeof result[key] !== "string") return false;
	}
	if (result.aborted !== undefined && typeof result.aborted !== "boolean") return false;
	if (result.modelOverride !== undefined && !isStringOrStringArray(result.modelOverride)) return false;
	return true;
}

function isTaskAsyncDetails(value: unknown): boolean {
	const details = readRecord(value);
	return (
		details !== undefined &&
		["running", "completed", "failed"].includes(String(details.state)) &&
		isNonEmptyString(details.jobId) &&
		details.type === "task"
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringOrStringArray(value: unknown): boolean {
	return typeof value === "string" || isStringArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function hasNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function extractSingleResultSummary(result: Record<string, unknown>): string | undefined {
	for (const value of [result.assignment, result.task, result.description]) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function emptyEvidence(call: ToolCallRecord, status: TaskDelegationEvidence["status"]): TaskDelegationEvidence {
	return {
		status,
		taskSummary: extractTaskSummary(call.params),
		outputArtifacts: [],
		codebaseRefs: [],
	};
}

function asyncEvidence(call: ToolCallRecord, asyncDetails?: Record<string, unknown>): TaskDelegationEvidence {
	return {
		...emptyEvidence(call, asyncDetails?.state === "failed" ? "aborted" : "insufficient"),
		jobId: toOptionalString(asyncDetails?.jobId),
	};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/**
 * Extract a short task summary from the call parameters.
 *
 * Looks for assignment, task, description, or name fields in order.
 */
function extractTaskSummary(params: Record<string, unknown>): string | undefined {
	const summary = String(params.assignment ?? params.task ?? params.description ?? params.name ?? "");
	return summary || undefined;
}

/**
 * Extract codebase file references from a text blob.
 *
 * Matches file paths with known extensions.
 */
function extractCodebaseRefs(text: string): string[] {
	if (!text) return [];
	const refs: string[] = [];
	const refPattern = /[\w./-]+\.[a-z]+(?::\w[\w.]*)?/gi;
	const matched = text.match(refPattern);
	if (matched) {
		for (const m of matched) {
			if (
				m.includes("/") &&
				(m.endsWith(".ts") ||
					m.endsWith(".tsx") ||
					m.endsWith(".js") ||
					m.endsWith(".jsx") ||
					m.endsWith(".py") ||
					m.endsWith(".go") ||
					m.endsWith(".rs") ||
					m.endsWith(".json") ||
					m.endsWith(".yaml") ||
					m.endsWith(".yml") ||
					m.endsWith(".md"))
			) {
				refs.push(m);
			}
		}
	}
	return [...new Set(refs)];
}
