import { describe, expect, it, test } from "bun:test";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	codebaseIndexReady,
	computeEvidenceRevision,
	createCodebaseEvidencePack,
	normalizeCodebaseMemory,
	validateCodebasePack,
} from "../../src/signals/codebase-memory";
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
	input: Record<string, unknown> = {},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: `mcp__codebase_memory_mcp__${shortName}`,
		toolCallId,
		input,
		content: [{ type: "text", text: content }],
		isError,
		details,
	};
}

describe("codebase-memory Task 8 可信 server 边界", () => {
	it("正式 v17 MCP FQN 无 serverName 仍从精确 FQN 建立 Evidence", () => {
		const collector = new ToolEventCollector();
		const toolName = "mcp__codebase_memory_mcp_search_graph";
		collector.recordCall({ type: "tool_call", toolName, toolCallId: toolName, input: { query: "trusted" } });
		collector.recordResult({
			type: "tool_result",
			toolName,
			toolCallId: toolName,
			input: { query: "trusted" },
			content: [{ type: "text", text: "packages/omp-compliance/src/extension.ts" }],
			isError: false,
			details: undefined,
		});
		expect(collector.snapshot().codebaseMemory).toEqual({
			indexReady: false,
			queries: ["search_graph"],
			references: ["packages/omp-compliance/src/extension.ts"],
		});
	});

	it("无可信 server 元数据的短名不得建立 Codebase Memory Evidence", () => {
		const toolName = "search_graph";
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
	});

	it("canonical identity 拒绝的任意工具后缀不得伪造 Codebase Evidence", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({
			toolName: "evil.search_graph",
			toolCallId: "evil-search-graph",
			serverName: "codebase-memory",
			params: { query: "spoofed" },
		});
		collector.recordResult({
			toolName: "evil.search_graph",
			toolCallId: "evil-search-graph",
			success: true,
			resultRef: "packages/forged.ts",
		});

		expect(collector.snapshot().codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

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

	it("失败查询不贡献 queries 或 references", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("search_graph", { query: "failed" }, "failed-query"));
		collector.recordResult(
			mcpResult("failed-query", "search_graph", undefined, "packages/omp-compliance/src/should-not-count.ts", true, {
				query: "failed",
			}),
		);
		expect(collector.snapshot().codebaseMemory).toEqual({ indexReady: false, queries: [], references: [] });
	});

	it.each(["get_architecture", "query_graph"])("成功的 %s 纳入只读查询证据", (toolName) => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall(toolName, {}, toolName));
		collector.recordResult(mcpResult(toolName, toolName, undefined, "ok"));
		expect(collector.snapshot().codebaseMemory.queries).toContain(toolName);
	});

	it("index_repository 成功也不进入只读查询证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(mcpCall("index_repository", {}, "index-write"));
		collector.recordResult(mcpResult("index-write", "index_repository", undefined, '{"status":"indexed"}'));
		expect(collector.snapshot().codebaseMemory).toEqual({ indexReady: true, queries: [], references: [] });
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
				false,
				{ query: "TaskTool" },
			),
		);
		collector.recordCall(mcpCall("get_code_snippet", { qualified_name: "TaskTool.execute" }, "snippet-1"));
		collector.recordResult(
			mcpResult(
				"snippet-1",
				"get_code_snippet",
				{ file_path: "packages/omp-compliance/src/signals/codebase-memory.ts" },
				"no structured path here",
				false,
				{ qualified_name: "TaskTool.execute" },
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
			collector.recordResult(mcpResult(id, "search_code", { matches: [] }, "ok", false, { query: id }));
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

describe("Codebase Evidence Pack", () => {
	const successfulTools = [
		{
			serverName: "codebase-memory",
			qualifiedName: "codebase-memory-mcp.index_status",
			toolName: "index_status",
			success: true,
			params: {},
			resultRef: '{"status":"ready","revision":"idx-1"}',
		},
		{
			serverName: "codebase-memory",
			qualifiedName: "codebase-memory-mcp.get_code_snippet",
			toolName: "get_code_snippet",
			success: true,
			params: { qualified_name: "a" },
			resultRef: "file:src/a.ts",
		},
		{
			serverName: "codebase-memory",
			qualifiedName: "codebase-memory-mcp.trace_path",
			toolName: "trace_path",
			success: true,
			params: { function_name: "a" },
			resultRef: "file:src/a.ts",
		},
	] as const;

	it("生成稳定、不可变且包含结构化工具证据的 Pack", () => {
		const pack = createCodebaseEvidencePack({
			projectId: "demo",
			affectedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"],
			tools: successfulTools,
		});

		expect(pack.indexRevision).toBe("idx-1");
		expect(pack.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
		expect(pack.tools.map((tool) => tool.toolName)).toEqual(["get_code_snippet", "index_status", "trace_path"]);
		expect(pack.evidenceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
		const { evidenceRevision: _ignored, ...revisionBody } = pack;
		expect(computeEvidenceRevision(revisionBody)).toBe(pack.evidenceRevision);
		expect(Object.isFrozen(pack)).toBe(true);
		expect(Object.isFrozen(pack.tools)).toBe(true);
		expect(Object.isFrozen(pack.tools[0].params)).toBe(true);
	});

	it("字段顺序和集合顺序不影响 revision，内容变化会改变 revision", () => {
		const first = createCodebaseEvidencePack({
			projectId: "demo",
			affectedFiles: ["src/b.ts", "src/a.ts"],
			tools: successfulTools,
		});
		const second = createCodebaseEvidencePack({
			projectId: "demo",
			tools: [...successfulTools].reverse(),
			affectedFiles: ["src/a.ts", "src/b.ts"],
		});
		const changed = createCodebaseEvidencePack({
			projectId: "demo-2",
			affectedFiles: ["src/a.ts", "src/b.ts"],
			tools: successfulTools,
		});
		expect(first.evidenceRevision).toBe(second.evidenceRevision);
		expect(first.evidenceRevision).not.toBe(changed.evidenceRevision);
	});

	it("缺索引、index_status、snippet 或正式跨模块 trace 时 invalid", () => {
		const pack = createCodebaseEvidencePack({ projectId: "demo", affectedFiles: ["src/a.ts"], tools: successfulTools });
		expect(validateCodebasePack({ ...pack, indexRevision: "" }, [], { requiresTrace: true })).toContain(
			"missing_index_revision",
		);
		expect(
			validateCodebasePack({ ...pack, tools: pack.tools.filter((tool) => tool.toolName !== "index_status") }, [], {
				requiresTrace: true,
			}),
		).toContain("missing_index_status");
		expect(
			validateCodebasePack(
				{
					...pack,
					tools: pack.tools.map((tool) =>
						tool.toolName === "index_status"
							? { ...tool, resultRef: '{"status":"indexing","revision":"idx-1"}' }
							: tool,
					),
				},
				[],
				{ requiresTrace: true },
			),
		).toContain("missing_index_status");
		expect(
			validateCodebasePack({ ...pack, tools: pack.tools.filter((tool) => tool.toolName !== "get_code_snippet") }, [], {
				requiresTrace: true,
			}),
		).toContain("missing_snippet");
		expect(
			validateCodebasePack({ ...pack, tools: pack.tools.filter((tool) => tool.toolName !== "trace_path") }, [], {
				requiresTrace: true,
			}),
		).toContain("missing_trace");
	});

	it("修改文件必须由 affectedFiles 精确覆盖", () => {
		const pack = createCodebaseEvidencePack({ projectId: "demo", affectedFiles: ["src/a.ts"], tools: successfulTools });
		expect(validateCodebasePack(pack, ["src/a.ts", "src/b.ts"])).toContain("uncovered_file:src/b.ts");
		expect(() => validateCodebasePack(pack, ["../src/a.ts"])).toThrow();
		expect(() => validateCodebasePack(pack, ["/src/a.ts"])).toThrow();
		expect(() => validateCodebasePack(pack, ["src\\a.ts"])).toThrow();
		expect(() =>
			createCodebaseEvidencePack({
				projectId: "demo",
				affectedFiles: ["src/A.ts", "src/a.ts"],
				tools: successfulTools,
			}),
		).toThrow();
	});

	it("正式任务或多文件范围即使未显式传 requiresTrace 也要求 trace", () => {
		const noTrace = successfulTools.filter((tool) => tool.toolName !== "trace_path");
		const single = createCodebaseEvidencePack({ projectId: "demo", affectedFiles: ["src/a.ts"], tools: noTrace });
		const multiple = createCodebaseEvidencePack({
			projectId: "demo",
			affectedFiles: ["src/a.ts", "src/b.ts"],
			tools: noTrace,
		});
		expect(validateCodebasePack(single, [], { taskSource: "tdd" })).toContain("missing_trace");
		expect(validateCodebasePack(multiple, [])).toContain("missing_trace");
	});

	it("失败工具不算完整性，index_repository 不算只读 index_status", () => {
		const pack = createCodebaseEvidencePack({
			projectId: "demo",
			affectedFiles: ["src/a.ts"],
			tools: [
				{ ...successfulTools[0], toolName: "index_repository", qualifiedName: "codebase-memory-mcp.index_repository" },
				{ ...successfulTools[1], success: false },
			],
		});
		const errors = validateCodebasePack(pack, []);
		expect(errors).toContain("missing_index_status");
		expect(errors).toContain("missing_snippet");
	});

	it("验证阶段重新校验可信 server 与 qualifiedName，不信任伪造 access", () => {
		const pack = createCodebaseEvidencePack({ projectId: "demo", affectedFiles: ["src/a.ts"], tools: successfulTools });
		const forged = {
			...pack,
			tools: pack.tools.map((tool) =>
				tool.toolName === "get_code_snippet" ? { ...tool, serverName: "evil", access: "read" as const } : tool,
			),
		};
		expect(validateCodebasePack(forged as never, [])).toContain("missing_snippet");
	});

	it("Proxy、accessor 和超限输入失败关闭且不执行用户代码", () => {
		let reads = 0;
		const accessor = Object.defineProperty({}, "projectId", {
			enumerable: true,
			get: () => {
				reads++;
				return "demo";
			},
		});
		expect(() => createCodebaseEvidencePack(accessor as never)).toThrow();
		expect(reads).toBe(0);
		expect(() =>
			createCodebaseEvidencePack(
				new Proxy(
					{},
					{
						get: () => {
							reads++;
							return "demo";
						},
					},
				) as never,
			),
		).toThrow();
		expect(reads).toBe(0);
		expect(() =>
			createCodebaseEvidencePack({
				projectId: "x".repeat(70_000),
				affectedFiles: ["src/a.ts"],
				tools: successfulTools,
			}),
		).toThrow();
	});
});
