import { describe, expect, it, test } from "bun:test";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TaskContract } from "../../src/contract/types";
import {
	codebaseIndexReady,
	computeEvidenceRevision,
	createCodebaseEvidencePack,
	createTrustedCodebaseCapture,
	normalizeCodebaseMemory,
	validateCodebasePack,
} from "../../src/signals/codebase-memory";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";
import type { ToolCallRecord, ToolResultRecord, TrustedCodebaseValidationContext } from "../../src/signals/types";
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
	const projectId = "123e4567-e89b-42d3-a456-426614174000";
	const gitHead = "5e5560e5399236df8e403796291946ecf8bf7dba";
	const callAt = "2026-07-18T07:59:00.000Z";
	const resultAt = "2026-07-18T07:59:30.000Z";
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
				timestamp: callAt,
			},
			result: {
				toolCallId: id,
				success,
				source: "official",
				resultRef,
				...(details ? { details } : {}),
				detailsTruncated: false,
				detailsFailure: !success,
				timestamp: resultAt,
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
			taskContract: taskContract(),
			codebaseProjectId,
			diffHash,
			queriedAt,
			allowedNewFileRoots: ["src/new"],
			unresolvedClaims: [] as string[],
			pairs,
		};
	}

	function taskContract(
		source: "tdd" | "lightweight" = "tdd",
		affectedFiles = ["src/a.ts"],
		identity: Partial<Pick<TaskContract, "taskId" | "projectId" | "gitHead">> = {},
	): TaskContract {
		const common = {
			schemaVersion: 1,
			taskId: identity.taskId ?? "task-12",
			projectId: identity.projectId ?? projectId,
			gitHead: identity.gitHead ?? gitHead,
			scope: ["Task 12"],
			acceptanceCriteria: ["通过"],
			verificationCommands: ["bun test"],
			delegationRequired: source === "tdd",
			affectedFiles,
		};
		const tddHash = `sha256:${"c".repeat(64)}` as const;
		const semantic = source === "tdd" ? { ...common, source, contractHash: tddHash } : { ...common, source };
		const revision = canonicalArgsFingerprint(semantic);
		if (!revision) throw new Error("test task contract must be hashable");
		return {
			...semantic,
			contractHash: source === "tdd" ? tddHash : revision,
			createdAt: queriedAt,
			revision,
		};
	}

	function context(
		pairs = validPairs(),
		overrides: Partial<TrustedCodebaseValidationContext> = {},
	): TrustedCodebaseValidationContext {
		return {
			taskContract: taskContract(),
			codebaseProjectId,
			diffHash,
			indexRevision: "idx-1",
			trustedPairs: createTrustedCodebaseCapture(pairs),
			newFiles: [],
			...overrides,
		};
	}

	it("生成 TRD 9.3 完整、稳定、不可变 Pack", () => {
		const pack = createCodebaseEvidencePack(metadata());
		expect(pack).toMatchObject({
			schemaVersion: 1,
			projectId,
			codebaseProjectId,
			indexRevision: "idx-1",
			gitHead,
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
		expect(validateCodebasePack(forged, [], context())).toContain("index_revision_mismatch");
	});

	it("拒绝无关项目、无关 snippet 和无关 trace", () => {
		const wrongProject = validPairs().map((entry) =>
			entry.call.toolName === "search_graph"
				? pair("search_graph", "search", { project: "other", query: "demo.a" }, "file:src/a.ts")
				: entry,
		);
		expect(() => createCodebaseEvidencePack(metadata(wrongProject))).toThrow("project_mismatch:search_graph");

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
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(unrelatedSnippet)), [], context(unrelatedSnippet)),
		).toContain("missing_relevant_snippet");

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
			validateCodebasePack(createCodebaseEvidencePack(metadata(unrelatedTrace)), [], context(unrelatedTrace)),
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
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(failedSnippet)), [], context(failedSnippet)),
		).toContain("missing_relevant_snippet");

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
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(withoutDiscovery)), [], context(withoutDiscovery)),
		).toContain("missing_architecture_or_search");
		const withoutSnippet = pairs.filter((entry) => entry.call.toolName !== "get_code_snippet");
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(withoutSnippet)), [], context(withoutSnippet)),
		).toContain("missing_relevant_snippet");
		const repositoryOnly = pairs.filter((entry) => entry.call.toolName !== "index_status");
		repositoryOnly.push(
			pair(
				"index_repository",
				"index-write",
				{ project: codebaseProjectId },
				'{"status":"indexed","revision":"idx-1"}',
			),
		);
		expect(
			validateCodebasePack(createCodebaseEvidencePack(metadata(repositoryOnly)), [], context(repositoryOnly)),
		).toContain("missing_index_status");
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
		expect(validateCodebasePack(pack, [], context(pairs))).not.toContain("missing_relevant_trace");
	});

	it("新增文件只能位于 allowedNewFileRoots，unresolvedClaims 一律失败关闭", () => {
		const pack = createCodebaseEvidencePack(metadata());
		expect(
			validateCodebasePack(pack, ["src/new/item.ts"], context(validPairs(), { newFiles: ["src/new/item.ts"] })),
		).not.toContain("new_file_outside_allowed_root:src/new/item.ts");
		expect(
			validateCodebasePack(pack, ["other/item.ts"], context(validPairs(), { newFiles: ["other/item.ts"] })),
		).toContain("new_file_outside_allowed_root:other/item.ts");
		const unresolved = createCodebaseEvidencePack({ ...metadata(), unresolvedClaims: ["无法定位写入者"] });
		expect(validateCodebasePack(unresolved, [], context())).toContain("unresolved_claim:无法定位写入者");
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
		expect(() => validateCodebasePack(pack, changed, context())).toThrow();
		expect(reads).toBe(0);
		const options = Object.defineProperty({}, "taskContract", {
			enumerable: true,
			get: () => {
				reads++;
				return true;
			},
		});
		expect(() => validateCodebasePack(pack, [], options as never)).toThrow();
		expect(reads).toBe(0);
		expect(() => createCodebaseEvidencePack({ ...metadata(), queriedAt: "2026-07-18" })).toThrow();
		expect(() => createCodebaseEvidencePack({ ...metadata(), diffHash: "sha256:bad" })).toThrow();
		expect(() =>
			createCodebaseEvidencePack({ ...metadata(), taskContract: taskContract("tdd", ["../escape.ts"]) }),
		).toThrow();
		expect(() =>
			createCodebaseEvidencePack({
				...metadata(),
				taskContract: { ...taskContract(), projectId: "x".repeat(70_000) },
			}),
		).toThrow();
	});

	it("第三参数为必需可信上下文，Pack 元数据逐项与任务绑定", () => {
		const pack = createCodebaseEvidencePack(metadata());
		// @ts-expect-error TrustedCodebaseValidationContext is required.
		expect(() => validateCodebasePack(pack, [])).toThrow();
		expect(
			validateCodebasePack(
				pack,
				[],
				context(validPairs(), {
					taskContract: taskContract("tdd", ["src/a.ts"], {
						projectId: "123e4567-e89b-42d3-a456-426614174001",
					}),
				}),
			),
		).toContain("project_id_mismatch");
		expect(validateCodebasePack(pack, [], context(validPairs(), { codebaseProjectId: "other-project" }))).toContain(
			"codebase_project_id_mismatch",
		);
		expect(
			validateCodebasePack(
				pack,
				[],
				context(validPairs(), {
					taskContract: taskContract("tdd", ["src/a.ts"], { gitHead: "a".repeat(40) }),
				}),
			),
		).toContain("git_head_mismatch");
		expect(validateCodebasePack(pack, [], context(validPairs(), { diffHash: `sha256:${"a".repeat(64)}` }))).toContain(
			"diff_hash_mismatch",
		);
		expect(validateCodebasePack(pack, [], context(validPairs(), { indexRevision: "idx-2" }))).toContain(
			"index_revision_mismatch",
		);
		expect(
			validateCodebasePack(pack, [], context(validPairs(), { taskContract: taskContract("tdd", ["src/b.ts"]) })),
		).toContain("affected_files_mismatch");
	});

	it("独立 trustedPairs 可阻止完全伪造、重算 hash 与跨任务重放", () => {
		const originalPairs = validPairs();
		const pack = createCodebaseEvidencePack(metadata(originalPairs));
		const otherPairs = validPairs().map((entry) =>
			entry.call.toolName === "get_code_snippet"
				? pair(
						"get_code_snippet",
						"snippet-other",
						{ project: codebaseProjectId, qualified_name: "other.z" },
						"file:src/a.ts",
						{ qualified_name: "other.z", file_path: "src/a.ts" },
					)
				: entry,
		);
		expect(validateCodebasePack(pack, [], context(otherPairs))).toContain("trusted_capture_mismatch");

		const replayContext = context(originalPairs, {
			taskContract: taskContract("tdd", ["src/a.ts"], { taskId: "other-task" }),
		});
		expect(validateCodebasePack(pack, [], replayContext)).toContain("task_contract_mismatch");
	});

	it("formal 自动要求 trace，lightweight 不允许通过可选参数绕过", () => {
		const noTrace = validPairs().filter((entry) => entry.call.toolName !== "trace_path");
		const pack = createCodebaseEvidencePack(metadata(noTrace));
		expect(validateCodebasePack(pack, [], context(noTrace))).toContain("missing_relevant_trace");
		expect(
			validateCodebasePack(pack, [], context(noTrace, { taskContract: taskContract("lightweight") })),
		).not.toContain("missing_relevant_trace");
	});

	it("同 affected path 的无关 symbol 和 trace 不能过关", () => {
		const unrelated = validPairs().map((entry) => {
			if (entry.call.toolName === "get_code_snippet") {
				return pair(
					"get_code_snippet",
					"snippet",
					{ project: codebaseProjectId, qualified_name: "other.z" },
					"file:src/a.ts",
					{ qualified_name: "other.z", file_path: "src/a.ts" },
				);
			}
			if (entry.call.toolName === "trace_path") {
				return pair(
					"trace_path",
					"trace",
					{ project: codebaseProjectId, function_name: "other.z", direction: "outbound" },
					"file:src/a.ts",
					{ source: "other.z", target: "other.y", file_path: "src/a.ts" },
				);
			}
			return entry;
		});
		const errors = validateCodebasePack(createCodebaseEvidencePack(metadata(unrelated)), [], context(unrelated));
		expect(errors).toContain("missing_relevant_snippet");
		expect(errors).toContain("missing_relevant_trace");
	});

	it("严格校验项目、Git 与 pair 时间顺序", () => {
		expect(() =>
			createCodebaseEvidencePack({
				...metadata(),
				taskContract: { ...taskContract(), projectId: "not-a-uuid" },
			}),
		).toThrow();
		expect(() =>
			createCodebaseEvidencePack({
				...metadata(),
				taskContract: { ...taskContract(), gitHead: "deadbeef" },
			}),
		).toThrow();
		expect(() => createCodebaseEvidencePack({ ...metadata(), codebaseProjectId: "bad/project" })).toThrow();
		const resultBeforeCall = validPairs();
		resultBeforeCall[0] = {
			...resultBeforeCall[0],
			result: { ...resultBeforeCall[0].result, timestamp: "2026-07-18T07:58:00.000Z" },
		};
		expect(() => createCodebaseEvidencePack(metadata(resultBeforeCall))).toThrow("invalid_tool_time_order");
		const resultAfterQuery = validPairs();
		resultAfterQuery[0] = {
			...resultAfterQuery[0],
			result: { ...resultAfterQuery[0].result, timestamp: "2026-07-18T08:01:00.000Z" },
		};
		expect(() => createCodebaseEvidencePack(metadata(resultAfterQuery))).toThrow("invalid_tool_time_order");
	});
});
