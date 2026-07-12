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
 * Input types accepted by normalizeCodebaseMemory.
 *
 * Array form: paired tool_call / tool_result records from the collector.
 * Single form: convenience for tests — a tool name and its result object.
 */
type PairedInput = ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>;
interface SingleInput {
	toolName: string;
	result: { success: boolean; status?: string };
}

/**
 * Determine whether a codebase-memory tool result indicates the index is ready.
 *
 * - index_repository: success + status in ["indexed", "ready"] → ready
 * - index_status:     success + status === "ready" → ready
 * - other tools:      never considered index-readiness
 */
export function codebaseIndexReady(toolName: string, result: { success: boolean; status?: string }): boolean {
	return (
		result.success === true &&
		((toolName === "index_repository" && (result.status === "indexed" || result.status === "ready")) ||
			(toolName === "index_status" && result.status === "ready"))
	);
}

/**
 * Parse a `status` field from a resultRef string if it contains JSON.
 */
function parseStatusFromRef(resultRef: string): string | undefined {
	try {
		const parsed = JSON.parse(resultRef);
		if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
			return parsed.status;
		}
	} catch {
		// Not valid JSON — no status to extract
	}
	return undefined;
}

/**
 * Normalize paired call/result entries into codebase-memory evidence.
 *
 * Returns index readiness flag, query names, and file references.
 */
export function normalizeCodebaseMemory(paired: PairedInput | SingleInput): {
	indexReady: boolean;
	queries: string[];
	references: string[];
} {
	// Single-input convenience (test path)
	if ("toolName" in paired) {
		return {
			indexReady: codebaseIndexReady(paired.toolName, paired.result),
			queries: [],
			references: [],
		};
	}

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
		const shortName = toolName.includes(".") ? (toolName.split(".").pop() ?? toolName) : toolName;
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

	// Determine indexReady: match on tool name and result status.
	let isIndexReady = false;
	for (const ev of evidences) {
		const status = parseStatusFromRef(ev.resultRef);
		if (codebaseIndexReady(ev.toolName, { success: ev.success, status })) {
			isIndexReady = true;
			break;
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
	const refs: string[] = [];
	const fileRefPattern = /\bfile:(?:[a-zA-Z]:[\\/])?([^\s,;)]+)/g;
	for (const match of text.matchAll(fileRefPattern)) {
		refs.push(match[1].replace(/^[\\/]+|\.$/, ""));
	}
	const pathPattern =
		/(?:^|[\s,;])((?:src|app|lib|packages|test)[^\s,;)]+\.(?:ts|tsx|js|jsx|py|rs|go|rb|css|scss|json|md|toml|yaml|yml))/g;
	for (const match of text.matchAll(pathPattern)) {
		refs.push(match[1]);
	}
	return refs;
}
