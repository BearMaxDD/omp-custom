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
import type { ToolCallRecord, ToolResultRecord } from "../../src/signals/types";
import { canonicalArgsFingerprint } from "../../src/xdev/tool-identity";

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
	const codebaseProjectId = "codebase-demo";
	const queriedAt = "2026-07-18T08:00:00.000Z";
	const diffHash = `sha256:${"d".repeat(64)}`;

	function pair(
		toolName: string,
		id: string,
		params: Record<string, unknown>,
		resultRef: string,
		details?: Record<string, unknown>,
		success = true,
	): { call: ToolCallRecord; result: ToolResultRecord } {
		const argsFingerprint = canonicalArgsFingerprint(params);
		if (!argsFingerprint) throw new Error("fixture args must be canonical");
		return {
			call: {
				toolName,
				toolCallId: id,
				serverName: "codebase-memory",
				qualifiedName: `codebase-memory-mcp.${toolName}`,
				argsFingerprint,
				params,
				timestamp: queriedAt,
			},
			result: {
				toolCallId: id,
				success,
				source: "official",
				resultRef,
				...(details ? { details } : {}),
				detailsTruncated: false,
				detailsFailure: !success,
				timestamp: queriedAt,
			},
		};
	}

	function validPairs() {
		return [
			pair("index_status", "index", { project: codebaseProjectId }, '{"status":"ready","revision":"idx-1"}', {
				status: "ready",
				revision: "idx-1",
			}),
			pair("search_graph", "search", { project: codebaseProjectId, query: "demo.a" }, "file:src/a.ts", {
				results: [{ qualified_name: "demo.a", file_path: "src/a.ts" }],
			}),
			pair("get_code_snippet", "snippet", { project: codebaseProjectId, qualified_name: "demo.a" }, "file:src/a.ts", {
				qualified_name: "demo.a",
				file_path: "src/a.ts",
				line: 10,
			}),
			pair(
				"trace_path",
				"trace",
				{ project: codebaseProjectId, function_name: "demo.a", direction: "outbound" },
				"file:src/a.ts file:src/b.ts",
				{ source: "demo.a", target: "demo.b", file_path: "src/a.ts" },
			),
		];
	}

	function metadata(pairs = validPairs()) {
		return {
			projectId: "project-uuid",
			codebaseProjectId,
			gitHead: "5e5560e",
			diffHash,
			queriedAt,
			affectedFiles: ["src/a.ts"],
			allowedNewFileRoots: ["src/new"],
			unresolvedClaims: [] as string[],
			pairs,
		};
	}

	it("生成 TRD 9.3 完整、稳定、不可变 Pack", () => {
		const pack = createCodebaseEvidencePack(metadata());
		expect(pack).toMatchObject({
			schemaVersion: 1,
			projectId: "project-uuid",
			codebaseProjectId,
			indexRevision: "idx-1",
			gitHead: "5e5560e",
			diffHash,
			queriedAt,
		});
		expect(pack.symbols).toContainEqual({ qualifiedName: "demo.a", file: "src/a.ts", line: 10 });
		expect(pack.traces.length).toBeGreaterThan(0);
		expect(pack.evidenceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
		const { evidenceRevision: _ignored, ...body } = pack;
		expect(computeEvidenceRevision(body)).toBe(pack.evidenceRevision);
		expect(Object.isFrozen(pack)).toBe(true);
		expect(Object.isFrozen(pack.tools[0].params)).toBe(true);
	});

	it("伪造 indexRevision 后即使重算 revision 仍被真实性复核拒绝", () => {
		const pack = createCodebaseEvidencePack(metadata());
		const forgedBody = { ...pack, indexRevision: "idx-forged" };
		const { evidenceRevision: _old, ...withoutRevision } = forgedBody;
		const forged = { ...withoutRevision, evidenceRevision: computeEvidenceRevision(withoutRevision) };
		expect(validateCodebasePack(forged, [])).toContain("index_revision_mismatch");
	});

	it("拒绝无关项目、无关 snippet 和无关 trace", () => {
		const wrongProject = validPairs().map((entry) =>
			entry.call.toolName === "search_graph"
				? pair("search_graph", "search", { project: "other", query: "demo.a" }, "file:src/a.ts")
				: entry,
		);
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(wrongProject)), [])).toContain(
			"project_mismatch:search_graph",
		);

		const unrelatedSnippet = validPairs().map((entry) =>
			entry.call.toolName === "get_code_snippet"
				? pair(
						"get_code_snippet",
						"snippet",
						{ project: codebaseProjectId, qualified_name: "other.z" },
						"file:other/z.ts",
						{ qualified_name: "other.z", file_path: "other/z.ts" },
					)
				: entry,
		);
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(unrelatedSnippet)), [])).toContain(
			"missing_relevant_snippet",
		);

		const unrelatedTrace = validPairs().map((entry) =>
			entry.call.toolName === "trace_path"
				? pair(
						"trace_path",
						"trace",
						{ project: codebaseProjectId, function_name: "other.z", direction: "outbound" },
						"file:other/z.ts",
						{ source: "other.z", target: "other.y", file_path: "other/z.ts" },
					)
				: entry,
		);
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(unrelatedTrace)), [], { crossModule: true }),
		).toContain("missing_relevant_trace");
	});

	it("同 toolCallId 冲突结果失败关闭", () => {
		const pairs = validPairs();
		pairs.push(
			pair("get_code_snippet", "snippet", { project: codebaseProjectId, qualified_name: "demo.a" }, "file:src/evil.ts"),
		);
		expect(() => createCodebaseEvidencePack(metadata(pairs))).toThrow("conflicting_tool_call_id");
	});

	it("配对重新校验 ID、argsFingerprint、官方 source 与失败结果", () => {
		const mismatchedFingerprint = validPairs();
		mismatchedFingerprint[1] = {
			...mismatchedFingerprint[1],
			call: { ...mismatchedFingerprint[1].call, argsFingerprint: `sha256:${"a".repeat(64)}` },
		};
		expect(() => createCodebaseEvidencePack(metadata(mismatchedFingerprint))).toThrow("args_fingerprint_mismatch");

		const mismatchedId = validPairs();
		mismatchedId[1] = { ...mismatchedId[1], result: { ...mismatchedId[1].result, toolCallId: "other" } };
		expect(() => createCodebaseEvidencePack(metadata(mismatchedId))).toThrow("tool_result_id_mismatch");

		const legacy = validPairs();
		legacy[1] = { ...legacy[1], result: { ...legacy[1].result, source: "legacy" } };
		expect(() => createCodebaseEvidencePack(metadata(legacy))).toThrow("untrusted_tool_result_source");

		const failedSnippet = validPairs().map((entry) =>
			entry.call.toolName === "get_code_snippet"
				? pair(
						"get_code_snippet",
						"snippet",
						{ project: codebaseProjectId, qualified_name: "demo.a" },
						"file:src/a.ts",
						{},
						false,
					)
				: entry,
		);
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(failedSnippet)), [])).toContain(
			"missing_relevant_snippet",
		);

		const truncatedQuery = validPairs();
		truncatedQuery[1] = {
			...truncatedQuery[1],
			call: { ...truncatedQuery[1].call, params: { project: codebaseProjectId, query: `${"q".repeat(80)}…[+20]` } },
		};
		expect(() => createCodebaseEvidencePack(metadata(truncatedQuery))).not.toThrow();
	});

	it("缺 architecture/search、snippet、index_status 均 invalid，index_repository 不替代", () => {
		const pairs = validPairs();
		const withoutDiscovery = pairs.filter((entry) => entry.call.toolName !== "search_graph");
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(withoutDiscovery)), [])).toContain(
			"missing_architecture_or_search",
		);
		const withoutSnippet = pairs.filter((entry) => entry.call.toolName !== "get_code_snippet");
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(withoutSnippet)), [])).toContain(
			"missing_relevant_snippet",
		);
		const repositoryOnly = pairs.filter((entry) => entry.call.toolName !== "index_status");
		repositoryOnly.push(
			pair(
				"index_repository",
				"index-write",
				{ project: codebaseProjectId },
				'{"status":"indexed","revision":"idx-1"}',
			),
		);
		expect(validateCodebasePack(createCodebaseEvidencePack(metadata(repositoryOnly)), [])).toContain(
			"missing_index_status",
		);
	});

	it("query_graph 可替代跨模块 trace_path，但必须与 affectedFiles 相关", () => {
		const pairs = validPairs().filter((entry) => entry.call.toolName !== "trace_path");
		pairs.push(
			pair(
				"query_graph",
				"query",
				{ project: codebaseProjectId, query: "MATCH demo.a -> demo.b" },
				"file:src/a.ts file:src/b.ts",
				{ source: "demo.a", target: "demo.b", file_path: "src/a.ts" },
			),
		);
		const pack = createCodebaseEvidencePack(metadata(pairs));
		expect(validateCodebasePack(pack, [], { crossModule: true })).not.toContain("missing_relevant_trace");
	});

	it("新增文件只能位于 allowedNewFileRoots，unresolvedClaims 一律失败关闭", () => {
		const pack = createCodebaseEvidencePack(metadata());
		expect(validateCodebasePack(pack, ["src/new/item.ts"], { newFiles: ["src/new/item.ts"] })).not.toContain(
			"new_file_outside_allowed_root:src/new/item.ts",
		);
		expect(validateCodebasePack(pack, ["other/item.ts"], { newFiles: ["other/item.ts"] })).toContain(
			"new_file_outside_allowed_root:other/item.ts",
		);
		const unresolved = createCodebaseEvidencePack({ ...metadata(), unresolvedClaims: ["无法定位写入者"] });
		expect(validateCodebasePack(unresolved, [])).toContain("unresolved_claim:无法定位写入者");
	});

	it("changedFiles/options Proxy 与 accessor trap=0，ISO/hash/path/大小严格", () => {
		const pack = createCodebaseEvidencePack(metadata());
		let reads = 0;
		const changed = new Proxy([], {
			get: () => {
				reads++;
				throw new Error("trap");
			},
		});
		expect(() => validateCodebasePack(pack, changed)).toThrow();
		expect(reads).toBe(0);
		const options = Object.defineProperty({}, "crossModule", {
			enumerable: true,
			get: () => {
				reads++;
				return true;
			},
		});
		expect(() => validateCodebasePack(pack, [], options)).toThrow();
		expect(reads).toBe(0);
		expect(() => createCodebaseEvidencePack({ ...metadata(), queriedAt: "2026-07-18" })).toThrow();
		expect(() => createCodebaseEvidencePack({ ...metadata(), diffHash: "sha256:bad" })).toThrow();
		expect(() => createCodebaseEvidencePack({ ...metadata(), affectedFiles: ["../escape.ts"] })).toThrow();
		expect(() => createCodebaseEvidencePack({ ...metadata(), projectId: "x".repeat(70_000) })).toThrow();
	});
});
