import { describe, expect, it } from "bun:test";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";
import type { ToolCallRecord, ToolResultRecord } from "../../src/signals/types";

/** Build a tool_call event for the codebase-memory MCP server. */
function mcpCall(
	toolName: string,
	params: Record<string, unknown> = {},
	toolCallId?: string,
): Record<string, unknown> {
	return {
		toolName,
		toolCallId: toolCallId ?? `cb-${Date.now()}`,
		serverName: "codebase-memory",
		params,
	};
}

/** Build a tool_result event. */
function mcpResult(
	toolCallId: string,
	resultOrContent: unknown,
	isError?: boolean,
): Record<string, unknown> {
	const content =
		typeof resultOrContent === "string"
			? resultOrContent
			: JSON.stringify(resultOrContent);
	return {
		toolCallId,
		content,
		result: resultOrContent,
		isError,
	};
}

describe("codebase-memory 证据采集 — 仅工具名匹配，不基于自然语言", () => {
	it("识别 index_repository 工具调用", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_repository", { path: "/repo" }, "i1"));
		collector.recordResult(mcpResult("i1", { status: "ok" }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).not.toContain("index_repository");
		// index_status should show readiness
	});

	it("index_status 成功时设置 indexReady", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_status", {}, "idx-ok"));
		collector.recordResult(mcpResult("idx-ok", { ready: true }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.indexReady).toBe(true);
	});

	it("index_status 失败时不设 indexReady", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_status", {}, "idx-fail"));
		collector.recordResult(mcpResult("idx-fail", undefined, true));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.indexReady).toBe(false);
	});

	it("仅在 index、搜索、源码或调用链证据连续存在时标记 codebase evidence complete", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(
			mcpCall("index_status", {}, "idx-1"),
		);
		collector.recordResult(mcpResult("idx-1", { ready: true }));
		collector.recordCall(
			mcpCall("search_graph", { query: "TaskTool" }, "sg-1"),
		);
		collector.recordResult(
			mcpResult("sg-1", {
				references: ["src/task/index.ts:TaskTool"],
			}),
		);
		collector.recordCall(
			mcpCall("get_code_snippet", { qualified_name: "TaskTool.execute" }, "gcs-1"),
		);
		collector.recordResult(mcpResult("gcs-1", { code: "function execute()" }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory).toMatchObject({
			indexReady: true,
			queries: ["search_graph", "get_code_snippet"],
			references: ["src/task/index.ts:TaskTool"],
		});
	});

	it("search_code 也被识别为查询证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(
			mcpCall("search_code", { query: "find" }, "sc-1"),
		);
		collector.recordResult(mcpResult("sc-1", { matches: [] }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toContain("search_code");
	});

	it("trace_path 也被识别为调用链证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(
			mcpCall("trace_path", { symbol: "main" }, "tp-1"),
		);
		collector.recordResult(
			mcpResult("tp-1", { trace: ["src/main.ts:main -> src/util.ts:helper"] }),
		);
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toContain("trace_path");
		expect(snap.codebaseMemory.references.length).toBeGreaterThanOrEqual(1);
	});

	it("不识别未知工具名", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(
			mcpCall("unknown_tool", {}, "ut-1"),
		);
		collector.recordResult(mcpResult("ut-1", { ok: true }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toHaveLength(0);
		expect(snap.codebaseMemory.references).toHaveLength(0);
	});

	it("不识别其他服务器的同名工具（如非 codebase-memory 的 search_graph）", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({
			toolName: "search_graph",
			toolCallId: "non-cb",
			serverName: "other-server",
			params: {},
		});
		collector.recordResult(mcpResult("non-cb", { ok: true }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toHaveLength(0);
	});

	it("自然语言输出中出现 search_graph 不建立证据", () => {
		const collector = new ToolEventCollector();
		// A completion/chat tool mentioning search_graph in text — not a tool call
		collector.recordCall({
			toolName: "completion",
			toolCallId: "nlp",
			params: { prompt: 'I searched the graph using search_graph and found results' },
		});
		collector.recordResult(mcpResult("nlp", { text: 'I used search_graph to find' }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toHaveLength(0);
	});

	it("相同查询名去重", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(
			mcpCall("search_graph", { query: "a" }, "sg-a"),
		);
		collector.recordResult(mcpResult("sg-a", { references: [] }));
		collector.recordCall(
			mcpCall("search_graph", { query: "b" }, "sg-b"),
		);
		collector.recordResult(mcpResult("sg-b", { references: [] }));
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).toEqual(["search_graph"]);
	});
});
