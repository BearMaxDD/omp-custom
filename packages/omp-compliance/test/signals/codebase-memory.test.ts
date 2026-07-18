import { describe, expect, it, test } from "bun:test";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TaskContract } from "../../src/contract/types";
import * as codebaseMemoryApi from "../../src/signals/codebase-memory";
import {
	codebaseIndexReady,
	computeEvidenceRevision,
	createCodebaseEvidencePack,
	createTrustedCodebaseValidationContext,
	normalizeCodebaseMemory,
	validateCodebasePack,
} from "../../src/signals/codebase-memory";
import type { TrustedCodebaseValidationContextInput } from "../../src/signals/codebase-memory";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";
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
	const queriedAt = "2099-07-18T08:00:00.000Z";

	interface ToolFixture {
		readonly toolName: string;
		readonly id: string;
		readonly params: Record<string, unknown>;
		readonly resultRef: string;
		readonly details?: Record<string, unknown>;
		readonly success?: boolean;
	}

	function fixture(
		toolName: string,
		id: string,
		params: Record<string, unknown>,
		resultRef: string,
		details?: Record<string, unknown>,
		success = true,
	): ToolFixture {
		return { toolName, id, params, resultRef, ...(details ? { details } : {}), success };
	}

	function validFixtures(): ToolFixture[] {
		return [
			fixture("index_status", "index", { project: codebaseProjectId }, '{"status":"ready","revision":"idx-1"}', {
				status: "ready",
				revision: "idx-1",
			}),
			fixture("search_graph", "search", { project: codebaseProjectId, query: "demo.a" }, "file:src/a.ts", {
				results: [{ qualified_name: "demo.a", file_path: "src/a.ts" }],
			}),
			fixture(
				"get_code_snippet",
				"snippet",
				{ project: codebaseProjectId, qualified_name: "demo.a" },
				"file:src/a.ts",
				{
					qualified_name: "demo.a",
					file_path: "src/a.ts",
					line: 10,
				},
			),
			fixture(
				"trace_path",
				"trace",
				{ project: codebaseProjectId, function_name: "demo.a", direction: "outbound" },
				"file:src/a.ts file:src/b.ts",
				{ source: "demo.a", target: "demo.b", file_path: "src/a.ts" },
			),
		];
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

	function collector(fixtures: readonly ToolFixture[]): ToolEventCollector {
		const instance = new ToolEventCollector();
		for (const item of fixtures) {
			const toolName = `mcp__codebase_memory_mcp__${item.toolName}`;
			instance.recordCall({ type: "tool_call", toolName, toolCallId: item.id, input: item.params });
			instance.recordResult({
				type: "tool_result",
				toolName,
				toolCallId: item.id,
				input: item.params,
				content: [{ type: "text", text: item.resultRef }],
				isError: item.success === false,
				details: item.details,
			});
		}
		return instance;
	}

	function context(
		fixtures: readonly ToolFixture[] = validFixtures(),
		overrides: Partial<TrustedCodebaseValidationContextInput> = {},
	) {
		const contract = overrides.taskContract ?? taskContract();
		return createTrustedCodebaseValidationContext(collector(fixtures), {
			taskContract: contract,
			codebaseProjectId,
			indexRevision: "idx-1",
			queriedAt,
			changedFiles: contract.affectedFiles,
			newFiles: [],
			allowedNewFileRoots: ["src/new"],
			unresolvedClaims: [],
			requiredSymbols: contract.source === "tdd" ? ["demo.a"] : [],
			...overrides,
		});
	}

	it("生成 TRD 9.3 完整、稳定、不可变 Pack", () => {
		const trusted = context();
		const pack = createCodebaseEvidencePack(trusted);
		expect(pack).toMatchObject({
			schemaVersion: 1,
			projectId,
			codebaseProjectId,
			indexRevision: "idx-1",
			gitHead,
			diffHash: trusted.diffHash,
			queriedAt,
			changedFiles: ["src/a.ts"],
			requiredSymbols: ["demo.a"],
		});
		expect(pack.symbols).toContainEqual({ qualifiedName: "demo.a", file: "src/a.ts", line: 10 });
		expect(pack.traces.length).toBeGreaterThan(0);
		expect(pack.evidenceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
		const { evidenceRevision: _ignored, ...body } = pack;
		expect(computeEvidenceRevision(body)).toBe(pack.evidenceRevision);
		expect(Object.isFrozen(pack)).toBe(true);
		expect(Object.isFrozen(pack.tools[0].params)).toBe(true);
		expect(Object.isFrozen(trusted)).toBe(true);
	});

	it("普通调用方不能铸造 raw capture，字符串 brand 与 JSON clone 均无效", () => {
		expect("createTrustedCodebaseCapture" in codebaseMemoryApi).toBe(false);
		const trusted = context();
		expect("pairs" in trusted).toBe(false);
		const pack = createCodebaseEvidencePack(trusted);
		const forged = { ...trusted, __trustedCodebaseCaptureBrand: "collector_snapshot", pairs: [] };
		expect(() => validateCodebasePack(pack, forged as never)).toThrow("invalid_trusted_context");
		expect(() => validateCodebasePack(pack, JSON.parse(JSON.stringify(trusted)) as never)).toThrow(
			"invalid_trusted_context",
		);
		let reads = 0;
		const proxy = new Proxy(trusted, {
			get: () => {
				reads++;
				throw new Error("trap");
			},
		});
		expect(() => validateCodebasePack(pack, proxy)).toThrow("invalid_trusted_context");
		expect(reads).toBe(0);
		const forgedAccessor = Object.defineProperty({}, "taskContract", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error("trap");
			},
		});
		expect(() => validateCodebasePack(pack, forgedAccessor as never)).toThrow("invalid_trusted_context");
		expect(reads).toBe(0);
		const accessorInput = Object.defineProperty({}, "taskContract", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error("trap");
			},
		});
		expect(() => createTrustedCodebaseValidationContext({} as never, accessorInput as never)).toThrow(
			"invalid_evidence_collector",
		);
		expect(reads).toBe(0);
	});

	it("Pack 的时间、roots、claims、diff 与文件集全部由可信上下文绑定", () => {
		const trusted = context();
		const original = createCodebaseEvidencePack(trusted);
		const forgedBody = {
			...original,
			queriedAt: "2099-07-18T09:00:00.000Z",
			allowedNewFileRoots: ["other"],
			changedFiles: [],
			diffHash: `sha256:${"d".repeat(64)}` as const,
		};
		const { evidenceRevision: _old, ...body } = forgedBody;
		const forged = { ...body, evidenceRevision: computeEvidenceRevision(body) };
		const errors = validateCodebasePack(forged, trusted);
		expect(errors).toContain("trusted_context_mismatch");
		expect(errors).toContain("queried_at_mismatch");
		expect(errors).toContain("allowed_new_file_roots_mismatch");
		expect(errors).toContain("changed_files_mismatch");
		expect(errors).toContain("diff_hash_mismatch");
		expect(() => context(validFixtures(), { changedFiles: [] })).toThrow("missing_changed_files");
		const claimContext = context(validFixtures(), { unresolvedClaims: ["claim-a"] });
		const claimPack = createCodebaseEvidencePack(claimContext);
		const claimBody = { ...claimPack, unresolvedClaims: [] as string[] };
		const { evidenceRevision: _claimRevision, ...claimWithoutRevision } = claimBody;
		const forgedClaims = {
			...claimWithoutRevision,
			evidenceRevision: computeEvidenceRevision(claimWithoutRevision),
		};
		expect(validateCodebasePack(forgedClaims, claimContext)).toContain("unresolved_claims_mismatch");
		expect(validateCodebasePack(forgedClaims, claimContext)).toContain("unresolved_claim:claim-a");
	});

	it("formal requiredSymbols 是硬门，unrelated symbol 即使伪装 affected path 也失败", () => {
		const unrelated = validFixtures().map((item) => {
			if (item.toolName === "search_graph")
				return fixture(
					"search_graph",
					"search",
					{ project: codebaseProjectId, query: "unrelated.z" },
					"file:src/a.ts",
					{
						results: [{ qualified_name: "unrelated.z", file_path: "src/a.ts" }],
					},
				);
			if (item.toolName === "get_code_snippet")
				return fixture(
					"get_code_snippet",
					"snippet",
					{ project: codebaseProjectId, qualified_name: "unrelated.z" },
					"file:src/a.ts",
					{ qualified_name: "unrelated.z", file_path: "src/a.ts" },
				);
			if (item.toolName === "trace_path")
				return fixture(
					"trace_path",
					"trace",
					{ project: codebaseProjectId, function_name: "unrelated.z", direction: "outbound" },
					"file:src/a.ts",
					{ source: "unrelated.z", target: "unrelated.y", file_path: "src/a.ts" },
				);
			return item;
		});
		const trusted = context(unrelated);
		const errors = validateCodebasePack(createCodebaseEvidencePack(trusted), trusted);
		expect(errors).toContain("missing_required_symbol:demo.a");
		expect(errors).toContain("missing_relevant_snippet");
		expect(errors).toContain("missing_relevant_trace");
		expect(() => context(validFixtures(), { requiredSymbols: [] })).toThrow("missing_required_symbols");
	});

	it("index 三方绑定，index_repository 不能替代 ready index_status", () => {
		const trusted = context();
		const pack = createCodebaseEvidencePack(trusted);
		const forgedBody = { ...pack, indexRevision: "idx-forged" };
		const { evidenceRevision: _old, ...body } = forgedBody;
		const forged = { ...body, evidenceRevision: computeEvidenceRevision(body) };
		expect(validateCodebasePack(forged, trusted)).toContain("index_revision_mismatch");
		const repositoryOnly = validFixtures().filter((item) => item.toolName !== "index_status");
		repositoryOnly.push(
			fixture(
				"index_repository",
				"index-write",
				{ project: codebaseProjectId },
				'{"status":"indexed","revision":"idx-1"}',
			),
		);
		const repositoryContext = context(repositoryOnly);
		expect(validateCodebasePack(createCodebaseEvidencePack(repositoryContext), repositoryContext)).toContain(
			"missing_index_status",
		);
	});

	it("formal 自动要求 trace，相关 query_graph 可替代 trace_path", () => {
		const noTrace = validFixtures().filter((item) => item.toolName !== "trace_path");
		const noTraceContext = context(noTrace);
		expect(validateCodebasePack(createCodebaseEvidencePack(noTraceContext), noTraceContext)).toContain(
			"missing_relevant_trace",
		);
		const queryFixtures = [...noTrace];
		queryFixtures.push(
			fixture(
				"query_graph",
				"query",
				{ project: codebaseProjectId, query: "MATCH demo.a -> demo.b" },
				"file:src/a.ts file:src/b.ts",
				{ source: "demo.a", target: "demo.b", file_path: "src/a.ts" },
			),
		);
		const queryContext = context(queryFixtures);
		expect(validateCodebasePack(createCodebaseEvidencePack(queryContext), queryContext)).not.toContain(
			"missing_relevant_trace",
		);
		const lightweight = taskContract("lightweight");
		const lightContext = context(noTrace, { taskContract: lightweight, changedFiles: lightweight.affectedFiles });
		expect(validateCodebasePack(createCodebaseEvidencePack(lightContext), lightContext)).not.toContain(
			"missing_relevant_trace",
		);
	});

	it("new roots 与 unresolved claims 由上下文绑定并失败关闭", () => {
		const validNew = context(validFixtures(), {
			changedFiles: ["src/a.ts", "src/new/item.ts"],
			newFiles: ["src/new/item.ts"],
		});
		expect(validateCodebasePack(createCodebaseEvidencePack(validNew), validNew)).not.toContain(
			"new_file_outside_allowed_root:src/new/item.ts",
		);
		const outside = context(validFixtures(), {
			changedFiles: ["src/a.ts", "other/item.ts"],
			newFiles: ["other/item.ts"],
		});
		expect(validateCodebasePack(createCodebaseEvidencePack(outside), outside)).toContain(
			"new_file_outside_allowed_root:other/item.ts",
		);
		const unresolved = context(validFixtures(), { unresolvedClaims: ["无法定位写入者"] });
		expect(validateCodebasePack(createCodebaseEvidencePack(unresolved), unresolved)).toContain(
			"unresolved_claim:无法定位写入者",
		);
	});

	it("项目、任务 revision、格式、路径与资源上限严格绑定", () => {
		const trusted = context();
		const pack = createCodebaseEvidencePack(trusted);
		const otherFixtures = validFixtures().map((item) => ({
			...item,
			params: { ...item.params, project: "other-project" },
		}));
		const otherProject = context(otherFixtures, { codebaseProjectId: "other-project" });
		expect(validateCodebasePack(pack, otherProject)).toContain("codebase_project_id_mismatch");
		const otherTask = taskContract("tdd", ["src/a.ts"], { taskId: "other-task" });
		const replay = context(validFixtures(), { taskContract: otherTask, changedFiles: otherTask.affectedFiles });
		expect(validateCodebasePack(pack, replay)).toContain("task_contract_mismatch");
		expect(() => context(validFixtures(), { queriedAt: "2026-07-18" })).toThrow();
		expect(() => context(validFixtures(), { codebaseProjectId: "bad/project" })).toThrow();
		expect(() => context(validFixtures(), { changedFiles: ["../escape.ts"] })).toThrow();
		expect(() =>
			context(validFixtures(), { requiredSymbols: Array.from({ length: 513 }, (_, i) => `s${i}`) }),
		).toThrow();
		const tooManyTools = Array.from({ length: 257 }, (_, index) =>
			fixture(
				"search_graph",
				`search-${index}`,
				{ project: codebaseProjectId, query: `symbol-${index}` },
				"file:src/a.ts",
				{ results: [{ qualified_name: `symbol-${index}`, file_path: "src/a.ts" }] },
			),
		);
		expect(() => context(tooManyTools)).toThrow("invalid_collector_pairs");
	});

	it("create/validate API 不能漏传可信上下文，Pack 可由同一上下文完整重建", () => {
		const trusted = context();
		const first = createCodebaseEvidencePack(trusted);
		const replay = createCodebaseEvidencePack(trusted);
		expect(replay).toEqual(first);
		expect(validateCodebasePack(first, trusted)).toEqual([]);
		// @ts-expect-error Trusted context is mandatory.
		expect(() => createCodebaseEvidencePack()).toThrow("invalid_trusted_context");
		// @ts-expect-error Trusted context is mandatory.
		expect(() => validateCodebasePack(first)).toThrow("invalid_trusted_context");
	});
});
