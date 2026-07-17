import { beforeEach, describe, expect, it } from "bun:test";
import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";

/** Build a minimal tool_call event shape. */
function makeCall(toolName: string, params: Record<string, unknown> = {}, toolCallId?: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName,
		toolCallId: toolCallId ?? `${toolName}-${Date.now()}`,
		input: params,
	};
}

/** Build a minimal tool_result event keyed to a call. */
function makeResult(toolCallId: string, result: unknown, isError = false): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "test-tool",
		toolCallId,
		input: {},
		isError,
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

describe("ToolEventCollector — recordCall / recordResult 记录与关联", () => {
	let collector: ToolEventCollector;

	beforeEach(() => {
		collector = new ToolEventCollector();
	});

	it("记录 tool_call 事件并能在快照中检索", () => {
		collector.recordCall(makeCall("bash", { command: "ls" }, "call-1"));
		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.calls[0].toolName).toBe("bash");
		expect(snap.calls[0].toolCallId).toBe("call-1");
	});

	it("记录 tool_result 并关联到同名 tool_call", () => {
		collector.recordCall(makeCall("search_graph", { query: "foo" }, "c1"));
		collector.recordResult(makeResult("c1", { references: ["src/a.ts"] }, false));
		const snap = collector.snapshot();
		expect(snap.results).toHaveLength(1);
		expect(snap.results[0].toolCallId).toBe("c1");
		expect(snap.results[0].success).toBe(true);
	});

	it("记录错误 result 标记为 not successful", () => {
		collector.recordCall(makeCall("bash", {}, "c2"));
		collector.recordResult(makeResult("c2", "error output", true));
		const snap = collector.snapshot();
		expect(snap.results[0].success).toBe(false);
	});

	it("多次 reset 后清空所有事件", () => {
		collector.recordCall(makeCall("bash", {}, "c3"));
		collector.recordResult(makeResult("c3", "ok"));
		collector.reset();
		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(0);
		expect(snap.results).toHaveLength(0);
	});

	it("参数值被安全截断（长字符串、数组、对象）", () => {
		collector.recordCall(
			makeCall("task", {
				assignment: "x".repeat(200),
				items: Array.from({ length: 50 }, (_, i) => `item-${i}`),
				meta: { key1: "v1", key2: "v2", key3: "v3" },
			}),
		);
		const snap = collector.snapshot();
		const params = snap.calls[0].params;
		expect(params.assignment).toMatch(/…\[\+\d+\]/);
		expect(params.items).toMatch(/^\[array:\d+\]$/);
		expect(params.meta).toMatch(/^\{object:\d+\}$/);
	});

	it("没有 result 的 call 在 codebaseMemory 中正常出现，但无结果引用", () => {
		collector.recordCall({
			toolName: "search_code",
			toolCallId: "c4",
			serverName: "codebase-memory",
			params: { query: "find" },
		});
		const snap = collector.snapshot();
		// Should appear in queries even without a result
		expect(snap.codebaseMemory.queries).toContain("search_code");
	});

	it("空 resultRef 不产生 codebase 引用", () => {
		collector.recordCall({
			toolName: "search_code",
			toolCallId: "c5",
			serverName: "codebase-memory",
			params: { query: "find" },
		});
		collector.recordResult({
			type: "tool_result",
			toolName: "search_code",
			toolCallId: "c5",
			input: { query: "find" },
			isError: false,
			content: [{ type: "text", text: "no results found" }],
			details: undefined,
		});
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.references).toHaveLength(0);
	});

	it("在入口展开 xd 调用并向下游暴露规范 server、tool 和 args", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"collector"}' }, "xd-1"));
		collector.recordResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: "xd-1",
			input: { path: "xd://search_graph", content: '{"query":"collector"}' },
			isError: false,
			content: [{ type: "text", text: "packages/omp-compliance/src/signals/tool-event-collector.ts" }],
			details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "collector" } } },
		} as ToolResultEvent);

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.calls[0]).toMatchObject({
			toolCallId: "xd-1",
			serverName: "codebase-memory",
			toolName: "search_graph",
			params: { query: "collector" },
		});
		expect(snap.codebaseMemory.queries).toEqual(["search_graph"]);
		expect(snap.codebaseMemory.references).toEqual(["packages/omp-compliance/src/signals/tool-event-collector.ts"]);
	});

	it("外层 xd 与同 id 内层事件按 canonical identity 去重且结果保持关联", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"same"}' }, "shared"));
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "same" }, "shared"));
		collector.recordResult(makeResult("shared", "packages/omp-compliance/src/signals/types.ts"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.results).toHaveLength(1);
		expect(snap.results[0].toolCallId).toBe(snap.calls[0].toolCallId);
		expect(snap.codebaseMemory.references).toEqual(["packages/omp-compliance/src/signals/types.ts"]);
	});

	it("外层与内层 id 不同时按 parent 关联去重并重关联结果", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"parented"}' }, "outer"));
		collector.recordCall({
			toolName: "mcp__codebase_memory_mcp__search_graph",
			toolCallId: "inner",
			parentToolCallId: "outer",
			params: { query: "parented" },
		});
		collector.recordResult({
			toolCallId: "inner",
			success: true,
			resultRef: "packages/omp-compliance/src/signals/codebase-memory.ts",
		});

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.results).toHaveLength(1);
		expect(snap.calls[0].toolCallId).toBe("outer");
		expect(snap.results[0].toolCallId).toBe("outer");
		expect(snap.codebaseMemory.references).toEqual(["packages/omp-compliance/src/signals/codebase-memory.ts"]);
	});

	it("相同 canonical 工具的两个独立调用不会误去重", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"one"}' }, "xd-a"));
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"two"}' }, "xd-b"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(2);
		expect(snap.calls.map((call) => call.toolCallId)).toEqual(["xd-a", "xd-b"]);
	});

	it("help、畸形 xd 和未知工具不会进入 Evidence", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: "help" }, "help"));
		collector.recordCall(makeCall("write", { path: "xd://search_graph?x=1", content: "{}" }, "query"));
		collector.recordCall(makeCall("write", { path: "xd://unknown", content: "{}" }, "unknown"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(0);
		expect(snap.codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it("reset 清空去重关联，后续相同 id 可重新记录", () => {
		const event = makeCall("write", { path: "xd://search_graph", content: '{"query":"again"}' }, "reset-id");
		collector.recordCall(event);
		collector.reset();
		collector.recordCall(event);
		expect(collector.snapshot().calls).toHaveLength(1);
	});
});
