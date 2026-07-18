import { describe, expect, it } from "bun:test";
import {
	classifyToolCallEvent,
	classifyToolResultEvent,
	unwrapToolCallEvent,
	unwrapToolResultEvent,
} from "../../src/xdev/event-unwrapper";

function proxyWithTrapCounters<T extends object>(target: T, throwing: boolean) {
	const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
	const failOr = <V>(value: V): V => {
		if (throwing) throw new Error("不得执行 Proxy trap");
		return value;
	};
	const proxy = new Proxy(target, {
		get: (_target, key, receiver) => {
			traps.get++;
			return failOr(Reflect.get(target, key, receiver));
		},
		ownKeys: () => {
			traps.ownKeys++;
			return failOr(Reflect.ownKeys(target));
		},
		getOwnPropertyDescriptor: (_target, key) => {
			traps.getOwnPropertyDescriptor++;
			return failOr(Reflect.getOwnPropertyDescriptor(target, key));
		},
	});
	return { proxy, traps };
}

describe("unwrapToolCallEvent", () => {
	it("仅展开正式 write + xd:// URI + JSON object content", () => {
		const unwrapped = unwrapToolCallEvent({
			type: "tool_call",
			toolName: "write",
			toolCallId: "outer-1",
			input: { path: "xd://search_graph", content: '{"query":"collector"}' },
		});
		expect(unwrapped).toMatchObject({
			toolCallId: "outer-1",
			identity: {
				transport: "xdev",
				toolName: "search_graph",
				args: { query: "collector" },
			},
		});
	});

	it.each(["", "?", "help", "describe"])('help/describe content "%s" 不计为调用', (content) => {
		expect(
			unwrapToolCallEvent({
				type: "tool_call",
				toolName: "write",
				toolCallId: `help-${content}`,
				input: { path: "xd://search_graph", content },
			}),
		).toBeNull();
	});

	it.each([
		["xd://search_graph", "{"],
		["xd://search_graph", "[]"],
		["xd://search_graph", "null"],
		["xd://../search_graph", "{}"],
		["xd://search_graph?mode=execute", "{}"],
		["xd://search_graph#fragment", "{}"],
		["xd://delete_project", "{}"],
	])("畸形或未知 xd 调用 fail closed: %s", (path, content) => {
		expect(
			unwrapToolCallEvent({
				type: "tool_call",
				toolName: "write",
				toolCallId: `${path}-${content}`,
				input: { path, content },
			}),
		).toBeNull();
	});

	it("拒绝非正式外层工具和参数结构", () => {
		expect(
			unwrapToolCallEvent({
				type: "tool_call",
				toolName: "edit",
				toolCallId: "edit-1",
				input: { path: "xd://search_graph", content: "{}" },
			}),
		).toBeNull();
		expect(
			unwrapToolCallEvent({
				type: "tool_call",
				toolName: "write",
				toolCallId: "write-1",
				input: { path: "xd://search_graph", content: { query: "not-json-text" } },
			}),
		).toBeNull();
		expect(
			unwrapToolCallEvent({
				toolName: "write",
				toolCallId: "legacy-write",
				params: { path: "xd://search_graph", content: "{}" },
			}),
		).toBeNull();
	});

	it.each([false, true])("classifyToolCallEvent 对 input Proxy fail closed 且 trap 为 0 (throwing=%s)", (throwing) => {
		const { proxy: input, traps } = proxyWithTrapCounters(
			{ path: "xd://search_graph", content: '{"query":"proxy"}' },
			throwing,
		);
		let result: ReturnType<typeof classifyToolCallEvent> | undefined;

		expect(() => {
			result = classifyToolCallEvent({ type: "tool_call", toolName: "write", toolCallId: "proxy-call", input });
		}).not.toThrow();
		expect(result?.kind).not.toBe("valid");
		expect(traps).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
	});

	it("classifyToolCallEvent 不执行 input accessor", () => {
		let reads = 0;
		const input = Object.defineProperty({ content: "{}" }, "path", {
			enumerable: true,
			get: () => {
				reads++;
				return "xd://search_graph";
			},
		});

		expect(
			classifyToolCallEvent({ type: "tool_call", toolName: "write", toolCallId: "accessor-call", input }).kind,
		).not.toBe("valid");
		expect(reads).toBe(0);
	});
});

describe("unwrapToolResultEvent", () => {
	it("只接受 execute 模式且工具与调用身份一致", () => {
		const result = unwrapToolResultEvent(
			{
				type: "tool_result",
				toolName: "write",
				toolCallId: "outer-1",
				input: { path: "xd://search_graph", content: '{"query":"collector"}' },
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "collector" } } },
			},
			"codebase-memory-mcp.search_graph",
		);
		expect(result).toMatchObject({
			toolCallId: "outer-1",
			identity: { toolName: "search_graph", transport: "xdev" },
		});
	});

	it.each(["help", "describe"])('模式 "%s" 不计 Evidence', (mode) => {
		expect(
			unwrapToolResultEvent({
				type: "tool_result",
				toolName: "write",
				toolCallId: "outer-help",
				input: { path: "xd://search_graph", content: "{}" },
				content: [{ type: "text", text: "docs" }],
				isError: false,
				details: { xdev: { tool: "search_graph", mode, args: {} } },
			}),
		).toBeNull();
	});

	it("工具名不一致时 fail closed", () => {
		expect(
			unwrapToolResultEvent(
				{
					type: "tool_result",
					toolName: "write",
					toolCallId: "outer-mismatch",
					input: { path: "xd://search_graph", content: "{}" },
					content: [{ type: "text", text: "ok" }],
					isError: false,
					details: { xdev: { tool: "trace_path", mode: "execute", args: {} } },
				},
				"codebase-memory-mcp.search_graph",
			),
		).toBeNull();
	});

	it("details.xdev.args 与原始参数不一致时 fail closed", () => {
		expect(
			unwrapToolResultEvent({
				type: "tool_result",
				toolName: "write",
				toolCallId: "outer-args-mismatch",
				input: { path: "xd://search_graph", content: '{"query":"outer"}' },
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { xdev: { tool: "search_graph", mode: "execute", args: { query: "inner" } } },
			}),
		).toBeNull();
	});

	it("循环 result args 不抛异常并 fail closed", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			unwrapToolResultEvent({
				type: "tool_result",
				toolName: "write",
				toolCallId: "outer-cyclic",
				input: { path: "xd://search_graph", content: "{}" },
				content: [{ type: "text", text: "bad" }],
				isError: true,
				details: { xdev: { tool: "search_graph", mode: "execute", args: cyclic } },
			}),
		).not.toThrow();
		expect(
			unwrapToolResultEvent({
				type: "tool_result",
				toolName: "write",
				toolCallId: "outer-cyclic",
				input: { path: "xd://search_graph", content: "{}" },
				content: [{ type: "text", text: "bad" }],
				isError: true,
				details: { xdev: { tool: "search_graph", mode: "execute", args: cyclic } },
			}),
		).toBeNull();
	});

	it.each(["details", "xdev"] as const)("classifyToolResultEvent 对 %s Proxy 不执行 trap 并 fail closed", (level) => {
		for (const throwing of [false, true]) {
			const target =
				level === "details"
					? { xdev: { tool: "search_graph", mode: "execute", args: {} } }
					: { tool: "search_graph", mode: "execute", args: {} };
			const { proxy, traps } = proxyWithTrapCounters(target, throwing);
			const details = level === "details" ? proxy : { xdev: proxy };
			let result: ReturnType<typeof classifyToolResultEvent> | undefined;

			expect(() => {
				result = classifyToolResultEvent({
					type: "tool_result",
					toolName: "write",
					toolCallId: `proxy-result-${level}-${throwing}`,
					input: { path: "xd://search_graph", content: "{}" },
					details,
				});
			}).not.toThrow();
			expect(result?.kind).not.toBe("valid");
			expect(traps).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
		}
	});

	it.each(["xdev", "mode", "tool", "args"] as const)("classifyToolResultEvent 不执行 %s accessor", (field) => {
		let reads = 0;
		const xdev: Record<string, unknown> = { tool: "search_graph", mode: "execute", args: {} };
		let details: Record<string, unknown> = { xdev };
		const target = field === "xdev" ? details : xdev;
		const accessorValue =
			field === "xdev" ? xdev : field === "mode" ? "execute" : field === "tool" ? "search_graph" : {};
		Object.defineProperty(target, field, {
			enumerable: true,
			get: () => {
				reads++;
				return accessorValue;
			},
		});
		if (field === "xdev") details = target;

		expect(
			classifyToolResultEvent({
				type: "tool_result",
				toolName: "write",
				toolCallId: `accessor-result-${field}`,
				input: { path: "xd://search_graph", content: "{}" },
				details,
			}).kind,
		).not.toBe("valid");
		expect(reads).toBe(0);
	});
});
