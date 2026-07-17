import { describe, expect, it, test } from "bun:test";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { codebaseIndexReady, normalizeCodebaseMemory } from "../../src/signals/codebase-memory";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";

function mcpCall(shortName: string, input: Record<string, unknown>, toolCallId: string) {
	return {
		toolName: shortName,
		toolCallId,
		serverName: "codebase-memory",
		params: input,
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

describe("codebase-memory Task 8 可信 server 边界", () => {
	it.each(["mcp__codebase_memory_mcp__search_graph", "search_graph"])(
		"无可信 server 元数据时 %s 不得建立 Codebase Memory Evidence",
		(toolName) => {
			const collector = new ToolEventCollector();
			collector.recordCall({ type: "tool_call", toolName, toolCallId: toolName, input: { query: "spoofed" } });
			collector.recordResult({
				type: "tool_result",
				toolName,
				toolCallId: toolName,
				input: {},
				content: [{ type: "text", text: "packages/omp-compliance/src/extension.ts" }],
				isError: false,
				details: { file_path: "packages/omp-compliance/src/extension.ts" },
			});

			expect(collector.snapshot().codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
		},
	);

	it.each(["index_repository", "index_status"])("明确 serverName 的 %s 结果可令 indexReady=true", (toolName) => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall(toolName, {}, `ready-${toolName}`));
		collector.recordResult(mcpResult(`ready-${toolName}`, toolName, { status: "ignored" }, '{"status":"ready"}'));
		expect(collector.snapshot().codebaseMemory.indexReady).toBe(true);
	});

	it("失败的 index_status 即使文本状态 ready 也不设 ready", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_status", {}, "failed-ready"));
		collector.recordResult(mcpResult("failed-ready", "index_status", undefined, '{"status":"ready"}', true));
		expect(collector.snapshot().codebaseMemory.indexReady).toBe(false);
	});

	it("仅从文本结果提取 references，忽略 structured details", () => {
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
			references: ["packages/omp-compliance/src/extension.ts"],
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
				toolName: "index_repository",
				result: { success: true, status: "indexed" },
			}),
		).toEqual({ indexReady: true, queries: [], references: [] });
	});
});
