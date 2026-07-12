/**
 * Codebase Memory MCP Evidence Normalizer.
 *
 * Recognizes codebase-memory tool interactions by exact tool name
 * matching (not natural language content). Produces a structured
 * evidence summary from paired tool_call / tool_result events.
 *
 * Only these tool names are recognized:
 *   - index_repository, index_status     (indexing)
 *   - search_graph, search_code          (search)
 *   - get_code_snippet, trace_path       (source/call-chain)
 *
 * The normalizer NEVER matches based on natural language output
 * (e.g. standalone "search_graph" in a response). Only the server
 * + toolName field from a tool_call event is used.
 */

import type { CodebaseMemoryEvidence, ToolCallRecord, ToolResultRecord } from "./types";

/** The set of recognized codebase-memory tool names. */
const RECOGNIZED_TOOLS: ReadonlySet<string> = new Set([
	"index_repository",
	"index_status",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
]);

/** The MCP server name expected for codebase-memory tools. */
const EXPECTED_SERVER = "codebase-memory";

/**
 * Normalize paired call/result entries into codebase-memory evidence.
 *
 * Returns a flat list of CodebaseMemoryEvidence for each recognized
 * tool call that was successfully matched.
 */
export function normalizeCodebaseMemory(paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>): {
	indexReady: boolean;
	queries: string[];
	references: string[];
} {
	const indexReady = false;
	const queryNames: string[] = [];
	const allRefs: string[] = [];
	const evidences: CodebaseMemoryEvidence[] = [];

	for (const { call, result } of paired) {
		const toolName = call.toolName;
		const serverName = call.serverName ?? "";

		// Only consider codebase-memory server tools
		if (!serverName && toolName.indexOf(".") < 0 && toolName.indexOf("_") >= 0) {
			// When serverName is absent but the tool name contains underscores
			// typical of MCP tools, we still check the RECOGNIZED_TOOLS set.
			// This handles harness variants that don't set serverName explicitly.
			if (!RECOGNIZED_TOOLS.has(toolName)) {
				// Also check if toolName ends with a recognized stem
				const stem = toolName.split(".").pop() ?? "";
				if (!RECOGNIZED_TOOLS.has(stem)) continue;
			}
		} else if (serverName !== EXPECTED_SERVER) {
			continue;
		}

		// Extract the short tool name (strip server prefix if FQN)
		const shortName = toolName.includes(".") ? toolName.split(".").pop()! : toolName;
		if (!RECOGNIZED_TOOLS.has(shortName)) continue;

		const success = result?.success ?? false;

		// Extract references from result text for search / snippet tools
		if (result && shortName !== "index_repository" && shortName !== "index_status") {
			const refs = extractReferences(result.resultRef);
			allRefs.push(...refs);
		}

		if (
			shortName === "search_graph" ||
			shortName === "search_code" ||
			shortName === "get_code_snippet" ||
			shortName === "trace_path"
		) {
			queryNames.push(shortName);
		}

		evidences.push({
			serverName,
			toolName,
			success,
			params: call.params,
			resultRef: result?.resultRef ?? "",
		});
	}

	// Determine indexReady: we need at least one index_status call whose
	// result indicates the index is ready.
	let isIndexReady = false;
	for (const ev of evidences) {
		if (ev.toolName === "index_status" && ev.success) {
			isIndexReady = true;
		}
	}

	return {
		indexReady: isIndexReady,
		queries: [...new Set(queryNames)],
		references: [...new Set(allRefs)],
	};
}

// ─── Helpers ────────────────────────────────────────────────────

/** Naive reference extraction from result text. Looks for file:path or path/to/file patterns. */
function extractReferences(text: string): string[] {
	if (!text) return [];
	const refs: string[] = [];
	// Match "path/to/file.ts:Symbol" patterns (common in search_graph / trace_path results)
	const refPattern = /[\w./-]+\.[a-z]+(?::\w[\w.]*)?/gi;
	const matched = text.match(refPattern);
	if (matched) {
		for (const m of matched) {
			// Check extension against the file portion (before optional :Symbol suffix)
			const filePart = m.includes(":") ? m.slice(0, m.indexOf(":")) : m;
			if (
				filePart.includes("/") &&
				(filePart.endsWith(".ts") ||
					filePart.endsWith(".js") ||
					filePart.endsWith(".tsx") ||
					filePart.endsWith(".jsx") ||
					filePart.endsWith(".py") ||
					filePart.endsWith(".go") ||
					filePart.endsWith(".rs") ||
					filePart.endsWith(".json"))
			) {
				refs.push(m);
			}
		}
	}
	return refs;
}
