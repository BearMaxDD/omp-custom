/**
 * Codebase Evidence Builder — maps ToolEventCollector evidence snapshots
 * into structured codebase context for brainstorm topics.
 *
 * @see 2026-07-13-omp-advisor-brainstorm-topic-review-trd.md §5.2
 */

import type { EvidenceSnapshot } from "../signals/types";

// ─── Read-Only Tool Suffixes ───────────────────────────────────────

/**
 * Suffixes of read-only codebase-memory tools that the advisor MAY use.
 * `index_repository` is deliberately excluded — it is a write operation.
 */
const READ_ONLY_CODEBASE_SUFFIXES = [
	"index_status",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
] as const;

// ─── Types ─────────────────────────────────────────────────────────

export interface CodebaseEvidenceResult {
	mode: "not_needed" | "available" | "unavailable";
	references: Array<{ label: string; source: "graph" | "snippet" | "trace" | "text" }>;
	requestedToolNames: string[];
}

// ─── Builder ───────────────────────────────────────────────────────

/**
 * Build codebase evidence context from an evidence snapshot.
 *
 * Rules (TRD §5.2):
 * - `relevance === "none"`        → mode: "not_needed", empty references/tools.
 * - `relevance === "required"`    → "available" if indexReady AND at least one
 *                                   search/snippet/trace query was made;
 *                                   "unavailable" otherwise.
 * - `relevance === "optional"`    → "available" if snapshot has references;
 *                                   "not_needed" otherwise.
 *
 * References derive their source from the most specific query tool present.
 */
export function buildTopicCodebaseEvidence(
	relevance: "required" | "optional" | "none",
	snapshot: EvidenceSnapshot,
): CodebaseEvidenceResult {
	if (relevance === "none") {
		return { mode: "not_needed", references: [], requestedToolNames: [] };
	}

	const { codebaseMemory } = snapshot;
	const references = codebaseMemory.references.map(label => ({
		label,
		source: deriveSource(codebaseMemory.queries),
	}));

	if (relevance === "required") {
		if (codebaseMemory.indexReady && hasRelevantQuery(codebaseMemory.queries)) {
			return {
				mode: "available",
				references,
				requestedToolNames: filterReadOnlyTools(codebaseMemory.queries),
			};
		}
		return { mode: "unavailable", references: [], requestedToolNames: [] };
	}

	// relevance === "optional"
	if (codebaseMemory.references.length > 0) {
		return {
			mode: "available",
			references,
			requestedToolNames: filterReadOnlyTools(codebaseMemory.queries),
		};
	}
	return { mode: "not_needed", references: [], requestedToolNames: [] };
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Derive the source tag for references based on which queries ran.
 * Priority: snippet > trace > search > text.
 */
function deriveSource(queries: string[]): "graph" | "snippet" | "trace" | "text" {
	if (queries.includes("get_code_snippet")) return "snippet";
	if (queries.includes("trace_path")) return "trace";
	if (queries.some(q => q.startsWith("search_"))) return "graph";
	return "text";
}

/** True when at least one query is a recognised read-only codebase tool. */
function hasRelevantQuery(queries: string[]): boolean {
	return queries.some(q =>
		(READ_ONLY_CODEBASE_SUFFIXES as readonly string[]).includes(q),
	);
}

/** Keep only recognised read-only codebase tool names. */
function filterReadOnlyTools(queries: string[]): string[] {
	return queries.filter(q =>
		(READ_ONLY_CODEBASE_SUFFIXES as readonly string[]).includes(q),
	);
}
