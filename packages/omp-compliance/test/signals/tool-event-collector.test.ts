import { beforeEach, describe, expect, it } from "bun:test";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
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
		toolName: "bash",
		toolCallId,
		input: {},
		isError,
		content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
		details: result,
	};
}

function makeMcpResult(
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
	content: string,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: `mcp__codebase_memory_mcp__${toolName}`,
		toolCallId,
		input,
		isError: false,
		content: [{ type: "text", text: content }],
		details: undefined,
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
		collector.recordCall(makeCall("bash", { command: "pwd" }, "c1"));
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

	it("没有成功 result 的 call 不进入 codebaseMemory 查询", () => {
		collector.recordCall({
			toolName: "search_code",
			toolCallId: "c4",
			serverName: "codebase-memory",
			params: { query: "find" },
		});
		const snap = collector.snapshot();
		expect(snap.codebaseMemory.queries).not.toContain("search_code");
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
		collector.recordResult(
			makeMcpResult("shared", "search_graph", { query: "same" }, "packages/omp-compliance/src/signals/types.ts"),
		);

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.results).toHaveLength(1);
		expect(snap.results[0].toolCallId).toBe(snap.calls[0].toolCallId);
		expect(snap.codebaseMemory.references).toEqual(["packages/omp-compliance/src/signals/types.ts"]);
	});

	it.each([
		[
			"args_mismatch",
			{ path: "xd://search_graph", content: '{"query":"tampered"}' },
			{ tool: "search_graph", mode: "execute", args: { query: "tampered" } },
		],
		[
			"tool_mismatch",
			{ path: "xd://trace_path", content: '{"query":"original"}' },
			{ tool: "trace_path", mode: "execute", args: { query: "original" } },
		],
	])("xd result 自洽但与原始 call 不一致时记录 %s", (reason, input, xdev) => {
		collector.recordCall(
			makeCall("write", { path: "xd://search_graph", content: '{"query":"original"}' }, `tampered-${reason}`),
		);
		collector.recordResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: `tampered-${reason}`,
			input,
			content: [{ type: "text", text: "packages/should-not-count.ts" }],
			isError: false,
			details: { xdev },
		} as ToolResultEvent);

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(2);
		expect(snap.calls).toContainEqual(
			expect.objectContaining({ toolName: "search_graph", params: { query: "original" } }),
		);
		expect(snap.calls).toContainEqual(
			expect.objectContaining({
				toolName: "invalid_xdev_event",
				params: { reason },
			}),
		);
		expect(snap.results).toContainEqual(expect.objectContaining({ success: false, resultRef: reason }));
		expect(snap.codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it("同一关联 id 和工具但参数不同的外层与内层调用不会合并", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"outer"}' }, "same-id"));
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "inner" }, "same-id"));
		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(2);
		expect(snap.calls.map((call) => call.params.query)).toEqual(["outer", "inner"]);
	});

	it("MCP result 参数与原 call 不一致时失败且伪 reference 不进入 Evidence", () => {
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "original" }, "mcp-tampered"));
		collector.recordResult(
			makeMcpResult("mcp-tampered", "search_graph", { query: "tampered" }, "packages/spoofed-reference.ts"),
		);

		const snap = collector.snapshot();
		expect(snap.calls).toContainEqual(
			expect.objectContaining({
				toolName: "invalid_xdev_event",
				params: { reason: "args_mismatch" },
			}),
		);
		expect(snap.calls).toContainEqual(
			expect.objectContaining({ toolName: "search_graph", params: { query: "original" } }),
		);
		expect(snap.results).toContainEqual(expect.objectContaining({ success: false }));
		expect(snap.codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it("direct result 也必须与原 call canonical args 一致", () => {
		collector.recordCall({
			toolName: "search_graph",
			toolCallId: "direct-tampered",
			serverName: "codebase-memory-mcp",
			params: { query: "original" },
		});
		collector.recordResult({
			type: "tool_result",
			toolName: "search_graph",
			toolCallId: "direct-tampered",
			serverName: "codebase-memory-mcp",
			input: { query: "tampered" },
			isError: false,
			content: [{ type: "text", text: "packages/direct-spoofed.ts" }],
			details: undefined,
		} as ToolResultEvent & { serverName: string });

		const snap = collector.snapshot();
		expect(snap.calls).toContainEqual(
			expect.objectContaining({ toolName: "invalid_xdev_event", params: { reason: "args_mismatch" } }),
		);
		expect(snap.calls).toContainEqual(
			expect.objectContaining({ toolName: "search_graph", params: { query: "original" } }),
		);
		expect(snap.results).toContainEqual(expect.objectContaining({ success: false }));
		expect(snap.codebaseMemory.references).toEqual([]);
	});

	it("正式 v17 短名 Codebase spoof 不形成 canonical Evidence", () => {
		collector.recordCall(makeCall("search_graph", { query: "official-direct" }, "official-direct"));
		collector.recordResult({
			type: "tool_result",
			toolName: "search_graph",
			toolCallId: "official-direct",
			input: { query: "official-direct" },
			isError: false,
			content: [{ type: "text", text: "packages/direct-official.ts" }],
			details: undefined,
		});

		const snap = collector.snapshot();
		expect(snap.calls[0]).toMatchObject({
			toolName: "search_graph",
		});
		expect(snap.calls[0].serverName).toBeUndefined();
		expect(snap.calls[0].qualifiedName).toBeUndefined();
		expect(snap.codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it("legacy synthetic 显式 evil server 不能伪装 direct Codebase 调用", () => {
		collector.recordCall({
			toolName: "search_graph",
			toolCallId: "evil-direct",
			serverName: "evil-codebase-memory-mcp",
			params: { query: "spoof" },
		});
		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.calls[0].qualifiedName).toBeUndefined();
		expect(snap.codebaseMemory.queries).toEqual([]);
	});

	it.each(["official", "legacy"] as const)("%s 普通 result 工具名不匹配时不得按同 ID 关联", (source) => {
		collector.recordCall(makeCall("task", { task: "do work" }, `tool-mismatch-${source}`));
		if (source === "official") {
			collector.recordResult({
				type: "tool_result",
				toolName: "bash",
				toolCallId: `tool-mismatch-${source}`,
				input: { command: "true" },
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 0 },
			});
		} else {
			collector.recordResult({
				toolName: "bash",
				toolCallId: `tool-mismatch-${source}`,
				success: true,
				resultRef: '{"exitCode":0}',
			});
		}

		const snap = collector.snapshot();
		expect(snap.results).toEqual([]);
		expect(snap.subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "do work", status: "insufficient" }),
		]);
	});

	it.each(["direct", "mcp", "xdev"] as const)(
		"%s 的 early beta result 不得改写同 raw ID 的 alpha call",
		(transport) => {
			const id = `early-${transport}`;
			if (transport === "direct") {
				collector.recordCall({
					toolName: "search_graph",
					toolCallId: id,
					serverName: "codebase-memory-mcp",
					params: { query: "alpha" },
				});
				collector.recordResult({
					type: "tool_result",
					toolName: "search_graph",
					toolCallId: id,
					serverName: "codebase-memory-mcp",
					input: { query: "beta" },
					isError: false,
					content: [{ type: "text", text: "packages/spoofed-early-direct.ts" }],
					details: undefined,
				} as ToolResultEvent & { serverName: string });
				collector.recordCall({
					toolName: "search_graph",
					toolCallId: id,
					serverName: "codebase-memory-mcp",
					params: { query: "beta" },
				});
			} else if (transport === "mcp") {
				collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "alpha" }, id));
				collector.recordResult(makeMcpResult(id, "search_graph", { query: "beta" }, "packages/spoofed-early-mcp.ts"));
				collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "beta" }, id));
			} else {
				collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"alpha"}' }, id));
				collector.recordResult({
					type: "tool_result",
					toolName: "write",
					toolCallId: id,
					input: { path: "xd://search_graph", content: '{"query":"beta"}' },
					isError: false,
					content: [{ type: "text", text: "packages/spoofed-early-xdev.ts" }],
					details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "beta" } } },
				} as ToolResultEvent);
				collector.recordCall(makeCall("write", { path: "xd://search_graph", content: '{"query":"beta"}' }, id));
			}

			const snap = collector.snapshot();
			const canonicalCalls = snap.calls.filter((call) => call.toolName === "search_graph");
			expect(canonicalCalls.map((call) => call.params.query)).toEqual(["alpha", "beta"]);
			expect(
				canonicalCalls.every((call) => snap.results.every((result) => result.toolCallId !== call.toolCallId)),
			).toBe(true);
			expect(snap.codebaseMemory.references).toEqual([]);
		},
	);

	it("canonical result-before-call 丢弃，后续匹配 result 才建立 Evidence", () => {
		const result = makeMcpResult("result-before-call", "search_graph", { query: "ordered" }, "packages/ordered.ts");
		collector.recordResult(result);
		expect(collector.snapshot()).toMatchObject({ calls: [], results: [] });

		collector.recordCall(
			makeCall("mcp__codebase_memory_mcp__search_graph", { query: "ordered" }, "result-before-call"),
		);
		let snap = collector.snapshot();
		expect(snap.results).toEqual([]);
		expect(snap.codebaseMemory.references).toEqual([]);

		collector.recordResult(result);
		snap = collector.snapshot();
		expect(snap.results).toHaveLength(1);
		expect(snap.codebaseMemory.references).toEqual(["packages/ordered.ts"]);
	});

	it("同一 ID 的不同 canonical args 分别精确关联各自 result", () => {
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "alpha" }, "shared-mcp-id"));
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "beta" }, "shared-mcp-id"));
		collector.recordResult(makeMcpResult("shared-mcp-id", "search_graph", { query: "alpha" }, "packages/alpha.ts"));
		collector.recordResult(makeMcpResult("shared-mcp-id", "search_graph", { query: "beta" }, "packages/beta.ts"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(2);
		expect(snap.results).toHaveLength(2);
		expect(new Set(snap.results.map((result) => result.toolCallId)).size).toBe(2);
		expect(snap.codebaseMemory.references).toEqual(["packages/alpha.ts", "packages/beta.ts"]);
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

	it("help 不计 Evidence，畸形 URI 与未知工具记录 invalid_xdev_event", () => {
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: "help" }, "help"));
		collector.recordCall(makeCall("write", { path: "xd://search_graph?x=1", content: "{}" }, "query"));
		collector.recordCall(makeCall("write", { path: "xd://unknown", content: "{}" }, "unknown"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(2);
		expect(snap.calls.map((call) => call.toolName)).toEqual(["invalid_xdev_event", "invalid_xdev_event"]);
		expect(snap.calls.map((call) => call.params.reason)).toEqual(["invalid_xdev_uri", "unknown_tool"]);
		expect(snap.results.every((result) => result.success === false)).toBe(true);
		expect(snap.codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it.each([
		["malformed_json", { path: "xd://search_graph", content: "{" }],
		["invalid_content", { path: "xd://search_graph", content: [] }],
	])("调用异常 %s 记录 invalid_xdev_event", (reason, input) => {
		collector.recordCall(makeCall("write", input, `invalid-${reason}`));
		const snap = collector.snapshot();
		expect(snap.calls[0]).toMatchObject({ toolName: "invalid_xdev_event", params: { reason } });
		expect(snap.results[0]).toMatchObject({ success: false, toolCallId: `invalid-${reason}` });
		expect(snap.codebaseMemory.queries).toEqual([]);
	});

	it.each([
		["missing_xdev_details", undefined],
		["tool_mismatch", { xdev: { tool: "trace_path", mode: "execute", args: { query: "a" } } }],
		["args_mismatch", { xdev: { tool: "search_graph", mode: "execute", args: { query: "b" } } }],
	])("结果异常 %s 替换为 invalid_xdev_event", (reason, details) => {
		collector.recordCall(
			makeCall("write", { path: "xd://search_graph", content: '{"query":"a"}' }, `result-${reason}`),
		);
		collector.recordResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: `result-${reason}`,
			input: { path: "xd://search_graph", content: '{"query":"a"}' },
			content: [{ type: "text", text: "bad" }],
			isError: false,
			details,
		} as ToolResultEvent);
		const snap = collector.snapshot();
		expect(snap.calls[0]).toMatchObject({ toolName: "invalid_xdev_event", params: { reason } });
		expect(snap.results[0]).toMatchObject({ success: false });
		expect(snap.codebaseMemory.queries).toEqual([]);
	});

	it("循环 xd result args 记录 invalid 且不抛异常", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		collector.recordCall(makeCall("write", { path: "xd://search_graph", content: "{}" }, "cyclic-result"));
		expect(() =>
			collector.recordResult({
				type: "tool_result",
				toolName: "write",
				toolCallId: "cyclic-result",
				input: { path: "xd://search_graph", content: "{}" },
				content: [{ type: "text", text: "bad" }],
				isError: true,
				details: { xdev: { tool: "search_graph", mode: "execute", args: cyclic } },
			} as ToolResultEvent),
		).not.toThrow();
		expect(collector.snapshot().calls[0]).toMatchObject({
			toolName: "invalid_xdev_event",
			params: { reason: "unserializable_args" },
		});
	});

	it("同步限制 2048 条并丢弃淘汰调用的迟到内层事件和结果", () => {
		for (let index = 0; index < 2050; index++) {
			const id = `bounded-${index}`;
			const query = `query-${index}`;
			collector.recordCall(makeCall("write", { path: "xd://search_graph", content: JSON.stringify({ query }) }, id));
			collector.recordResult({
				type: "tool_result",
				toolName: "write",
				toolCallId: id,
				input: { path: "xd://search_graph", content: JSON.stringify({ query }) },
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { xdev: { tool: "search_graph", mode: "execute", args: { query } } },
			} as ToolResultEvent);
		}
		let snap = collector.snapshot();
		expect(snap.calls.length).toBeLessThanOrEqual(2048);
		expect(snap.results.length).toBeLessThanOrEqual(2048);
		expect(snap.calls.some((call) => call.toolCallId === "bounded-0")).toBe(false);

		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "query-0" }, "bounded-0"));
		collector.recordResult(makeResult("bounded-0", "packages/late.ts"));
		snap = collector.snapshot();
		expect(snap.calls.some((call) => call.toolCallId === "bounded-0")).toBe(false);
		expect(snap.results.some((result) => result.toolCallId === "bounded-0")).toBe(false);

		collector.recordCall({
			toolName: "search_graph",
			toolCallId: "independent-new",
			serverName: "codebase-memory-mcp",
			params: { query: "new" },
		});
		expect(collector.snapshot().calls.some((call) => call.toolCallId === "independent-new")).toBe(true);
	});

	it("一万次调用后仍拒绝最早 retired id，reset 后允许新会话复用", () => {
		const firstCall = makeCall(
			"write",
			{ path: "xd://search_graph", content: '{"query":"long-session-0"}' },
			"long-session-0",
		);
		for (let index = 0; index < 10_000; index++) {
			collector.recordCall(
				makeCall(
					"write",
					{ path: "xd://search_graph", content: JSON.stringify({ query: `long-session-${index}` }) },
					`long-session-${index}`,
				),
			);
		}

		collector.recordCall(firstCall);
		collector.recordResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: "long-session-0",
			input: firstCall.input,
			content: [{ type: "text", text: "packages/late-long-session.ts" }],
			isError: false,
			details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "long-session-0" } } },
		} as ToolResultEvent);

		let snap = collector.snapshot();
		expect(snap.calls.length).toBeLessThanOrEqual(2048);
		expect(snap.results.length).toBeLessThanOrEqual(2048);
		expect(snap.calls.some((call) => call.toolCallId === "long-session-0")).toBe(false);
		expect(snap.results.some((result) => result.toolCallId === "long-session-0")).toBe(false);
		expect(snap.codebaseMemory.references).not.toContain("packages/late-long-session.ts");
		const internals = collector as unknown as {
			canonicalCallIds: Map<string, string>;
			callAliases: Map<string, string>;
		};
		expect(internals.canonicalCallIds.size).toBeLessThanOrEqual(2048);
		expect(internals.callAliases.size).toBeLessThanOrEqual(2048);

		collector.reset();
		collector.recordCall(firstCall);
		collector.recordResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: "long-session-0",
			input: firstCall.input,
			content: [{ type: "text", text: "packages/new-session.ts" }],
			isError: false,
			details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "long-session-0" } } },
		} as ToolResultEvent);
		snap = collector.snapshot();
		expect(snap.calls.some((call) => call.toolCallId === "long-session-0")).toBe(true);
		expect(snap.codebaseMemory.references).toContain("packages/new-session.ts");
	});

	it("retired raw ID 可用于新的非 retired identity，并分配固定长度 storage ID", () => {
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "retired" }, "reused-raw-id"));
		for (let index = 0; index < 2048; index++) {
			collector.recordCall(
				makeCall("mcp__codebase_memory_mcp__search_graph", { query: `filler-${index}` }, `filler-${index}`),
			);
		}
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "fresh" }, "reused-raw-id"));
		collector.recordResult(makeMcpResult("reused-raw-id", "search_graph", { query: "fresh" }, "packages/fresh.ts"));

		const snap = collector.snapshot();
		const freshCall = snap.calls.find((call) => call.params.query === "fresh");
		expect(freshCall).toBeDefined();
		expect(freshCall?.toolCallId).not.toBe("reused-raw-id");
		expect(new TextEncoder().encode(freshCall?.toolCallId ?? "").byteLength).toBeLessThanOrEqual(256);
		expect(snap.results.some((result) => result.toolCallId === freshCall?.toolCallId)).toBe(true);
		expect(snap.codebaseMemory.references).toContain("packages/fresh.ts");
	});

	it("超长中文 ID 在任何 record 或 Map key 前压缩到 256 UTF-8 字节", () => {
		const hugeOuterId = "外层调用标识".repeat(128 * 1024);
		const hugeInnerId = "内层调用标识".repeat(128 * 1024);
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "huge-id" }, hugeOuterId));
		collector.recordCall({
			type: "tool_call",
			toolName: "mcp__codebase_memory_mcp__search_graph",
			toolCallId: hugeInnerId,
			parentToolCallId: hugeOuterId,
			input: { query: "huge-id" },
		} as ToolCallEvent & { parentToolCallId: string });
		collector.recordResult(makeMcpResult(hugeInnerId, "search_graph", { query: "huge-id" }, "packages/huge-id.ts"));

		const snap = collector.snapshot();
		expect(snap.calls).toHaveLength(1);
		expect(snap.results).toHaveLength(1);
		expect(snap.results[0].toolCallId).toBe(snap.calls[0].toolCallId);
		expect(new TextEncoder().encode(snap.calls[0].toolCallId).byteLength).toBeLessThanOrEqual(256);
		expect(new TextEncoder().encode(JSON.stringify(snap)).byteLength).toBeLessThan(64 * 1024);
		expect(snap.codebaseMemory.references).toEqual(["packages/huge-id.ts"]);

		const internals = collector as unknown as {
			calls: Map<string, unknown>;
			results: Map<string, unknown>;
			canonicalCallIds: Map<string, string>;
			callAliases: Map<string, string>;
		};
		for (const map of [internals.calls, internals.results, internals.canonicalCallIds, internals.callAliases]) {
			for (const [key, value] of map) {
				expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(256);
				if (typeof value === "string") {
					expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(256);
				}
			}
		}
	});

	it("参数快照限制键数、键长和总字节，canonical args 超过 64KiB 时记录 invalid", () => {
		const hugeKey = "巨型参数键".repeat(512 * 1024);
		const manyKeys = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`key-${index}`, index]));
		collector.recordCall(makeCall("task", { [hugeKey]: "value", ...manyKeys }, "bounded-params"));
		collector.recordCall(
			makeCall("mcp__codebase_memory_mcp__search_graph", { payload: "x".repeat(65 * 1024) }, "oversized-canonical"),
		);

		const snap = collector.snapshot();
		const stored = snap.calls.find((call) => call.toolCallId === "bounded-params");
		expect(stored).toBeDefined();
		expect(Object.keys(stored?.params ?? {})).toHaveLength(64);
		for (const key of Object.keys(stored?.params ?? {})) {
			expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(256);
		}
		expect(new TextEncoder().encode(JSON.stringify(stored?.params)).byteLength).toBeLessThanOrEqual(16 * 1024);
		expect(snap.calls).toContainEqual(
			expect.objectContaining({ toolName: "invalid_xdev_event", params: { reason: "unserializable_args" } }),
		);
		expect(new TextEncoder().encode(JSON.stringify(snap)).byteLength).toBeLessThan(32 * 1024);
	});

	it("retired raw ID 禁止 identity-less legacy result 污染 fresh canonical call", () => {
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "old" }, "retired-legacy"));
		for (let index = 0; index < 2048; index++) {
			collector.recordCall(
				makeCall("mcp__codebase_memory_mcp__search_graph", { query: `retire-${index}` }, `retire-${index}`),
			);
		}
		collector.recordCall(makeCall("mcp__codebase_memory_mcp__search_graph", { query: "fresh" }, "retired-legacy"));
		collector.recordResult({ toolCallId: "retired-legacy", success: true, resultRef: "packages/legacy-spoof.ts" });

		let snap = collector.snapshot();
		const fresh = snap.calls.find((call) => call.params.query === "fresh");
		expect(fresh).toBeDefined();
		expect(snap.results.some((result) => result.toolCallId === fresh?.toolCallId)).toBe(false);
		expect(snap.codebaseMemory.references).not.toContain("packages/legacy-spoof.ts");

		collector.recordResult(
			makeMcpResult("retired-legacy", "search_graph", { query: "fresh" }, "packages/fresh-official.ts"),
		);
		snap = collector.snapshot();
		expect(snap.results.some((result) => result.toolCallId === fresh?.toolCallId)).toBe(true);
		expect(snap.codebaseMemory.references).toContain("packages/fresh-official.ts");
	});

	it("details 有界清洗且保留 task normalizer 所需字段", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const details = {
			results: [
				{
					id: "bounded-agent",
					agent: "implementer",
					task: "Bound structured details",
					exitCode: 0,
					durationMs: 12,
					output: "packages/omp-compliance/src/signals/tool-event-collector.ts",
				},
			],
			huge: "x".repeat(10 * 1024 * 1024),
			deep: { a: { b: { c: { d: { e: "too deep" } } } } },
			wide: Array.from({ length: 1_000 }, (_, index) => index),
			manyKeys: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key-${index}`, index])),
			cyclic,
			big: 1n,
		};
		collector.recordCall(makeCall("task", { task: "Bound structured details" }, "bounded-details"));
		expect(() =>
			collector.recordResult({
				type: "tool_result",
				toolName: "task",
				toolCallId: "bounded-details",
				input: { task: "Bound structured details" },
				content: [{ type: "text", text: "completed" }],
				isError: false,
				details,
			} as ToolResultEvent),
		).not.toThrow();

		const snap = collector.snapshot();
		const stored = snap.results[0].details;
		expect(stored).toBeDefined();
		expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThanOrEqual(16 * 1024);
		expect(String(stored?.huge).length).toBeLessThanOrEqual(2 * 1024);
		expect(stored?.wide).toBeArray();
		expect(stored?.wide as unknown[]).toHaveLength(32);
		expect(Object.keys(stored?.manyKeys as object)).toHaveLength(64);
		expect(JSON.stringify(stored?.deep)).not.toContain("too deep");
		expect(snap.results[0]).toMatchObject({ detailsTruncated: true, detailsFailure: false });
		expect((stored?.results as Array<Record<string, unknown>>)[0]).toMatchObject({
			id: "bounded-agent",
			agent: "implementer",
			exitCode: 0,
		});
		expect(snap.subagentDelegations[0]).toMatchObject({ status: "insufficient", codebaseRefs: [] });
	});

	it("2MiB 长期字符串字段与 Map key 均保持固定字节预算", () => {
		const huge = "超长字段".repeat(256 * 1024);
		const context = {
			cwd: huge,
			sessionManager: { getSessionId: () => huge },
		} as unknown as ExtensionContext;
		collector.recordCall(
			{
				toolName: huge,
				toolCallId: "bounded-metadata",
				serverName: huge,
				params: { value: huge },
			},
			context,
		);
		collector.recordResult({
			toolName: huge,
			toolCallId: "bounded-metadata",
			success: true,
			resultRef: huge,
		});

		const snap = collector.snapshot();
		const call = snap.calls[0];
		const result = snap.results[0];
		expect(new TextEncoder().encode(call.toolName).byteLength).toBeLessThanOrEqual(256);
		expect(new TextEncoder().encode(call.serverName ?? "").byteLength).toBeLessThanOrEqual(128);
		expect(new TextEncoder().encode(call.cwd ?? "").byteLength).toBeLessThanOrEqual(1024);
		expect(new TextEncoder().encode(call.sessionId ?? "").byteLength).toBeLessThanOrEqual(256);
		expect(new TextEncoder().encode(result.resultRef).byteLength).toBeLessThanOrEqual(2048);
		expect(new TextEncoder().encode(JSON.stringify(snap)).byteLength).toBeLessThan(32 * 1024);

		const internals = collector as unknown as {
			calls: Map<string, unknown>;
			results: Map<string, unknown>;
			canonicalCallIds: Map<string, string>;
			callAliases: Map<string, string>;
		};
		for (const map of [internals.calls, internals.results, internals.canonicalCallIds, internals.callAliases]) {
			for (const key of map.keys()) {
				expect(new TextEncoder().encode(key).byteLength).toBeLessThanOrEqual(256);
			}
		}
	});

	it("reset 清空去重关联，后续相同 id 可重新记录", () => {
		const event = makeCall("write", { path: "xd://search_graph", content: '{"query":"again"}' }, "reset-id");
		collector.recordCall(event);
		collector.reset();
		collector.recordCall(event);
		expect(collector.snapshot().calls).toHaveLength(1);
	});
});
