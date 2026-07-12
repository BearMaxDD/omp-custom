/**
 * Fake CodebaseMemory — simulates codebase-memory MCP tool calls.
 *
 * Produces tool_call/tool_result pairs for the codebase-memory server
 * through the existing ToolEventCollector public API (recordCall/recordResult).
 *
 * Only uses recognized tool names (index_repository, index_status,
 * search_graph, search_code, get_code_snippet, trace_path) and
 * populates the EvidenceSnapshot's codebaseMemory field through
 * the normalizer (normalizeCodebaseMemory), not direct property access.
 *
 * NEVER calls collector internals directly — only the public API.
 */

import type { ToolEventCollector } from "../../src/signals/tool-event-collector";

/** Recognized codebase-memory MCP server name. */
const SERVER_NAME = "codebase-memory";

let callCounter = 0;

function nextCallId(): string {
	callCounter++;
	return `fake-cbm-${Date.now()}-${callCounter}`;
}

export class FakeCodebaseMemory {
	constructor(private readonly collector: ToolEventCollector) {}

	/**
	 * Record an index_repository call with success.
	 */
	recordIndexRepository(): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "index_repository",
			toolCallId,
			serverName: SERVER_NAME,
			params: {},
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({ indexedFiles: 42, duration: "1.2s" }),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record an index_status call that indicates the index is ready.
	 */
	recordIndexReady(): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "index_status",
			toolCallId,
			serverName: SERVER_NAME,
			params: {},
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({ status: "ready", indexedFiles: 42 }),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record an index_status call that indicates the index is not ready.
	 */
	recordIndexNotReady(): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "index_status",
			toolCallId,
			serverName: SERVER_NAME,
			params: {},
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: false,
			resultRef: JSON.stringify({ status: "indexing", error: "still building" }),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a search_graph query with results.
	 */
	recordSearchGraph(query: string, results?: string[]): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "search_graph",
			toolCallId,
			serverName: SERVER_NAME,
			params: { query },
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({
				query,
				results: results ?? [],
				totalResults: results?.length ?? 0,
			}),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a search_code query with results.
	 */
	recordSearchCode(query: string, results?: string[]): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "search_code",
			toolCallId,
			serverName: SERVER_NAME,
			params: { query },
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({
				query,
				results: results ?? [],
			}),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a get_code_snippet call for a specific file/symbol.
	 */
	recordGetSnippet(path: string, symbol?: string): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "get_code_snippet",
			toolCallId,
			serverName: SERVER_NAME,
			params: { path, symbol },
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({
				path,
				symbol,
				content: `// code from ${path}${symbol ? `::${symbol}` : ""}`,
			}),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a trace_path call following a symbol's call chain.
	 */
	recordTracePath(symbol: string, chain?: string[]): void {
		const toolCallId = nextCallId();
		this.collector.recordCall({
			toolName: "trace_path",
			toolCallId,
			serverName: SERVER_NAME,
			params: { symbol },
			timestamp: new Date().toISOString(),
		});
		this.collector.recordResult({
			toolCallId,
			success: true,
			resultRef: JSON.stringify({
				symbol,
				callChain: chain ?? [],
			}),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Record a complete set of codebase-memory interactions: index +
	 * search + snippet + trace. This simulates the full evidence path.
	 */
	recordFullSet(queries: string[], snippets: string[], traces: string[]): void {
		this.recordIndexRepository();
		this.recordIndexReady();
		for (const q of queries) {
			this.recordSearchGraph(q);
		}
		for (const p of snippets) {
			this.recordGetSnippet(p);
		}
		for (const s of traces) {
			this.recordTracePath(s);
		}
	}
}
