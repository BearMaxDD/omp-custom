import { describe, expect, it, test } from "bun:test";
import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { codebaseIndexReady, normalizeCodebaseMemory } from "../../src/signals/codebase-memory";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";

function mcpCall(shortName: string, input: Record<string, unknown>, toolCallId: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: `mcp__codebase_memory_mcp__${shortName}`,
		toolCallId,
		input,
	};
}

function mcpResult(
	toolCallId: string,
	shortName: string,
	details: unknown,
	content = "ok",
	isError = false,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: `mcp__codebase_memory_mcp__${shortName}`,
		toolCallId,
		input: {},
		content: [{ type: "text", text: content }],
		isError,
		details,
	};
}

describe("codebase-memory v17 structured details 归一化", () => {
	it.each(["index_repository", "index_status"])("%s 的 details.status=ready 可令 indexReady=true", (toolName) => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall(toolName, {}, `ready-${toolName}`));
		collector.recordResult(mcpResult(`ready-${toolName}`, toolName, { status: "ready" }, "ordinary content"));
		expect(collector.snapshot().codebaseMemory.indexReady).toBe(true);
	});

	it("失败的 index_status 即使 details ready 也不设 ready", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_status", {}, "failed-ready"));
		collector.recordResult(mcpResult("failed-ready", "index_status", { status: "ready" }, "ordinary", true));
		expect(collector.snapshot().codebaseMemory.indexReady).toBe(false);
	});

	it("search/snippet 的 structured references 与 content 合并并稳定去重", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("search_graph", { query: "TaskTool" }, "search-1"));
		collector.recordResult(
			mcpResult(
				"search-1",
				"search_graph",
				{
					results: [
						{ file_path: "packages/omp-compliance/src/signals/task-delegation.ts" },
						{ file_path: "packages/omp-compliance/src/signals/task-delegation.ts" },
					],
				},
				"ordinary content; packages/omp-compliance/src/extension.ts",
			),
		);
		collector.recordCall(mcpCall("get_code_snippet", { qualified_name: "TaskTool.execute" }, "snippet-1"));
		collector.recordResult(
			mcpResult(
				"snippet-1",
				"get_code_snippet",
				{ file_path: "packages/omp-compliance/src/signals/codebase-memory.ts" },
				"no structured path here",
			),
		);

		expect(collector.snapshot().codebaseMemory).toEqual({
			indexReady: false,
			queries: ["search_graph", "get_code_snippet"],
			references: [
				"packages/omp-compliance/src/extension.ts",
				"packages/omp-compliance/src/signals/task-delegation.ts",
				"packages/omp-compliance/src/signals/codebase-memory.ts",
			],
		});
	});

	it("未知工具、其他 FQN 与自然语言提及都不建立证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("unknown_tool", {}, "unknown"));
		collector.recordResult(mcpResult("unknown", "unknown_tool", { file_path: "src/no.ts" }));
		collector.recordCall({ type: "tool_call", toolName: "other__search_graph", toolCallId: "other", input: {} });
		collector.recordResult({
			type: "tool_result",
			toolName: "other__search_graph",
			toolCallId: "other",
			input: {},
			content: [{ type: "text", text: "search_graph src/no.ts" }],
			isError: false,
			details: { file_path: "src/no.ts" },
		});
		expect(collector.snapshot().codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it("相同查询名去重", () => {
		const collector = new ToolEventCollector();
		for (const id of ["a", "b"]) {
			collector.recordCall(mcpCall("search_code", { query: id }, id));
			collector.recordResult(mcpResult(id, "search_code", { matches: [] }));
		}
		expect(collector.snapshot().codebaseMemory.queries).toEqual(["search_code"]);
	});
});

describe("codebaseIndexReady matrix", () => {
	const cases: Array<[string, { success: boolean; status?: string }, boolean]> = [
		["index_repository", { success: true, status: "indexed" }, true],
		["index_repository", { success: true, status: "ready" }, true],
		["index_repository", { success: false, status: "indexed" }, false],
		["index_status", { success: true, status: "ready" }, true],
		["search_graph", { success: true }, false],
	];

	test.each(cases)("%s %j -> indexReady=%s", (toolName, result, ready) => {
		expect(codebaseIndexReady(toolName, result)).toBe(ready);
	});

	it("保留直接 normalizer 契约", () => {
		expect(
			normalizeCodebaseMemory({
				toolName: "mcp__codebase_memory_mcp__index_repository",
				result: { success: true, status: "indexed" },
			}),
		).toEqual({ indexReady: true, queries: [], references: [] });
	});
});
