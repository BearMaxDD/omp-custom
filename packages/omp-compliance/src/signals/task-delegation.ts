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
		// Only match the official "task" tool
		const shortName = call.toolName.includes(".") ? (call.toolName.split(".").pop() ?? call.toolName) : call.toolName;
		if (shortName !== TASK_TOOL_NAME) continue;

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

function isTaskToolDetails(
	details: Record<string, unknown>,
): details is Record<string, unknown> & { results: unknown[] } {
	return Array.isArray(details.results);
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
