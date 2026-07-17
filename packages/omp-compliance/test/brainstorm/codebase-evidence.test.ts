/**
 * Tests for buildTopicCodebaseEvidence — from EvidenceSnapshot to codebase
 * context metadata, references, and requested tool names.
 */

import { describe, expect, it } from "bun:test";
import { buildTopicCodebaseEvidence } from "../../src/brainstorm/codebase-evidence";
import type { EvidenceSnapshot } from "../../src/signals/types";
import { emptyEvidenceSnapshot, fullCodebaseSnapshot } from "./fixtures";

// ─── Snapshot helpers for edge cases ────────────────────────────────

function indexUnreadySnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: false,
			queries: ["search_graph"],
			references: ["AgentSession.#buildAdvisorRuntime"],
		},
	};
}

function indexReadyEmptyQueriesSnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: [],
			references: [],
		},
	};
}

function optionalWithRefsSnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["search_graph"],
			references: ["ModuleA.loader"],
		},
	};
}

/** Snapshot with only search_graph query to test "graph" source derivation. */
function graphOnlySnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["search_graph"],
			references: ["GraphRef"],
		},
	};
}

/** Snapshot with only trace_path query to test "trace" source derivation. */
function traceOnlySnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["trace_path"],
			references: ["TraceRef"],
		},
	};
}

/** Snapshot with text-only queries (not a recognised codebase tool) to test fallback source. */
function textFallbackSnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["read_file", "list_directory"],
			references: ["TextRef"],
		},
	};
}

// ─── Suite ──────────────────────────────────────────────────────────

describe("buildTopicCodebaseEvidence", () => {
	// ── relevance: "none" ───────────────────────────────────────────

	it("does not require codebase evidence for a product-only topic", () => {
		const evidence = buildTopicCodebaseEvidence("none", emptyEvidenceSnapshot());
		expect(evidence).toEqual({ mode: "not_needed", references: [], requestedToolNames: [] });
	});

	// ── relevance: "required" — available ───────────────────────────

	it("maps verified graph references and requests only read-only MCP tools", () => {
		const evidence = buildTopicCodebaseEvidence("required", fullCodebaseSnapshot());
		expect(evidence.mode).toBe("available");
		expect(evidence.references).toContainEqual(
			expect.objectContaining({ label: "AgentSession.#buildAdvisorRuntime", source: "snippet" }),
		);
		expect(evidence.requestedToolNames.every((name) => !name.endsWith("index_repository"))).toBe(true);
	});

	it.each(["get_architecture", "query_graph"])("accepts shared read-only policy tool %s", (toolName) => {
		const snapshot: EvidenceSnapshot = {
			...emptyEvidenceSnapshot(),
			codebaseMemory: { indexReady: true, queries: [toolName], references: ["ArchitectureRef"] },
		};
		const evidence = buildTopicCodebaseEvidence("required", snapshot);
		expect(evidence.mode).toBe("available");
		expect(evidence.requestedToolNames).toEqual([toolName]);
	});

	it("rejects index_repository from required Brainstorm evidence", () => {
		const snapshot: EvidenceSnapshot = {
			...emptyEvidenceSnapshot(),
			codebaseMemory: { indexReady: true, queries: ["index_repository"], references: ["WriteRef"] },
		};
		expect(buildTopicCodebaseEvidence("required", snapshot)).toEqual({
			mode: "unavailable",
			references: [],
			requestedToolNames: [],
		});
	});

	// ── relevance: "required" — unavailable ─────────────────────────

	it("returns unavailable when index is not ready", () => {
		const evidence = buildTopicCodebaseEvidence("required", indexUnreadySnapshot());
		expect(evidence).toEqual({ mode: "unavailable", references: [], requestedToolNames: [] });
	});

	it("returns unavailable when index is ready but no queries were made", () => {
		const evidence = buildTopicCodebaseEvidence("required", indexReadyEmptyQueriesSnapshot());
		expect(evidence).toEqual({ mode: "unavailable", references: [], requestedToolNames: [] });
	});

	// ── relevance: "optional" ───────────────────────────────────────

	it("returns available for optional codebase when references exist", () => {
		const evidence = buildTopicCodebaseEvidence("optional", optionalWithRefsSnapshot());
		expect(evidence.mode).toBe("available");
		expect(evidence.references).toContainEqual(expect.objectContaining({ label: "ModuleA.loader", source: "graph" }));
		expect(evidence.requestedToolNames).toEqual(["search_graph"]);
	});

	it("returns not_needed for optional codebase when no references exist", () => {
		const evidence = buildTopicCodebaseEvidence("optional", emptyEvidenceSnapshot());
		expect(evidence).toEqual({ mode: "not_needed", references: [], requestedToolNames: [] });
	});

	// ── source derivation priority ──────────────────────────────────

	it("derives source=snippet when get_code_snippet query is present", () => {
		const evidence = buildTopicCodebaseEvidence("required", fullCodebaseSnapshot());
		for (const ref of evidence.references) {
			expect(ref.source).toBe("snippet");
		}
	});

	it("derives source=graph when only search_graph is present", () => {
		const evidence = buildTopicCodebaseEvidence("required", graphOnlySnapshot());
		for (const ref of evidence.references) {
			expect(ref.source).toBe("graph");
		}
	});

	it("derives source=trace when only trace_path is present", () => {
		const evidence = buildTopicCodebaseEvidence("required", traceOnlySnapshot());
		for (const ref of evidence.references) {
			expect(ref.source).toBe("trace");
		}
	});

	it("derives source=text as fallback for unrecognised query tools", () => {
		const evidence = buildTopicCodebaseEvidence("required", textFallbackSnapshot());
		for (const ref of evidence.references) {
			expect(ref.source).toBe("text");
		}
	});
});
