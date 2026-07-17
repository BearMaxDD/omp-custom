import { describe, expect, it } from "bun:test";
import { unwrapToolCallEvent, unwrapToolResultEvent } from "../../src/xdev/event-unwrapper";

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
});
