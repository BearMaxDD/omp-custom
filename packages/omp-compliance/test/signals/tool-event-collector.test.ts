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
		collector.recordCall(makeCall("search_code", { query: "find" }, "c4"));
		const snap = collector.snapshot();
		// Should appear in queries even without a result
		expect(snap.codebaseMemory.queries).toContain("search_code");
	});

	it("空 resultRef 不产生 codebase 引用", () => {
		collector.recordCall(makeCall("search_code", { query: "find" }, "c5"));
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
});
