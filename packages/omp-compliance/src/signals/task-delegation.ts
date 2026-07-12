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
 * evidence records. Every call produces exactly one evidence entry.
 */
export function normalizeTaskDelegation(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
): TaskDelegationEvidence[] {
	const results: TaskDelegationEvidence[] = [];

	for (const { call, result } of paired) {
		// Only match the official "task" tool
		const shortName = call.toolName.includes(".") ? call.toolName.split(".").pop()! : call.toolName;
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

		// Parse result details from the resultRef (JSON)
		const details = parseResultDetails(result.resultRef);

		const agentId = details.agentId ?? details.agent ?? call.params.agent ?? call.params.name;
		const exitCode = details.exitCode ?? details.exit ?? details.code;
		const aborted = details.aborted ?? details.cancelled ?? false;
		const durationMs = details.durationMs ?? details.duration;
		const output = details.output ?? details.outputs ?? details.artifacts;
		const outputArtifacts = Array.isArray(output)
			? output.map(String)
			: typeof output === "string"
				? [output]
				: [];

		// Extract codebase references from output text
		const codebaseRefs = extractCodebaseRefs(
			outputArtifacts.join(" ") + " " + result.resultRef,
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

/**
 * Extract a short task summary from the call parameters.
 *
 * Looks for assignment, task, description, or name fields in order.
 */
function extractTaskSummary(params: Record<string, unknown>): string | undefined {
	const summary =
		String(params.assignment ?? params.task ?? params.description ?? params.name ?? "");
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
	return refs;
}
