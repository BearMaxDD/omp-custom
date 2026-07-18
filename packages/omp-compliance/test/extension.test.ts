import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { ComplianceReviewRegistry } from "../src/advisor/review-envelope";
import { EvidenceStore } from "../src/evidence/evidence-store";
import { bindCollectorEvents } from "../src/extension";
import { ComplianceRuntime } from "../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../src/signals/collector-runtime";
import { FakeExtensionAPI, createFakeExtensionContext } from "./support/fake-extension-api";
import { createStrictRuntimeDependencies } from "./support/strict-runtime-dependencies";

describe("extension v17 tool event wiring", () => {
	it("preserves official input and correlates the result through the fake host", async () => {
		const api = new FakeExtensionAPI();
		const collector = new CollectorRuntime();
		let contextCwd: string | undefined;

		bindCollectorEvents(api.toAPI(), collector);
		api.on("tool_call", (_event, context) => {
			contextCwd = context?.cwd;
		});

		await api.fireToolCall("search_graph", { name_pattern: ".*TaskTool.*" }, "v17-call-1");
		await api.fireToolResult({
			toolName: "search_graph",
			toolCallId: "v17-call-1",
			input: { name_pattern: ".*TaskTool.*" },
			content: [{ type: "text", text: "packages/task-tool.ts" }],
			isError: false,
			details: { matches: 1 },
		});

		const snapshot = collector.collector.snapshot();
		expect(contextCwd).toBe(process.cwd());
		expect(snapshot.calls[0]?.params).toEqual({ name_pattern: ".*TaskTool.*" });
		expect(snapshot.results[0]?.toolCallId).toBe("v17-call-1");
		expect(snapshot.results[0]?.resultRef).toContain("packages/task-tool.ts");
	});

	it("normalizes real v17 TaskToolDetails batch results when content is ordinary text", async () => {
		const api = new FakeExtensionAPI();
		const collector = new CollectorRuntime();
		const taskOutput = `${"x".repeat(240)} Updated packages/omp-compliance/src/signals/task-delegation.ts`;
		const details: TaskToolDetails = {
			projectAgentsDir: "/workspace/.omp/agents",
			totalDurationMs: 4_321,
			results: [
				{
					index: 0,
					id: "agent-v17",
					agent: "implementer",
					agentSource: "project",
					task: "Implement the v17 adapter",
					assignment: "Implement the v17 adapter",
					exitCode: 0,
					output: taskOutput,
					stderr: "",
					truncated: false,
					durationMs: 4_321,
					tokens: 200,
					requests: 3,
					outputPath: "/tmp/task-report.txt",
				},
			],
		};

		bindCollectorEvents(api.toAPI(), collector);
		await api.fireToolCall("task", { assignment: "Implement the v17 adapter" }, "v17-task-1");
		await api.fireToolResult({
			toolName: "task",
			toolCallId: "v17-task-1",
			input: { assignment: "Implement the v17 adapter" },
			content: [{ type: "text", text: "Task completed successfully." }],
			isError: false,
			details,
		});

		const snapshot = collector.collector.snapshot();
		const delegation = snapshot.subagentDelegations[0];
		expect(snapshot.results[0]?.details?.results).toEqual(details.results);
		expect(delegation).toEqual({
			agentId: "agent-v17",
			agent: "implementer",
			taskSummary: "Implement the v17 adapter",
			status: "completed",
			durationMs: 4_321,
			exitCode: 0,
			outputArtifacts: [taskOutput, "/tmp/task-report.txt"],
			codebaseRefs: ["packages/omp-compliance/src/signals/task-delegation.ts"],
		});
	});

	it("keeps async running incomplete and accepts exact official codebase FQNs", async () => {
		const api = new FakeExtensionAPI();
		const collector = new CollectorRuntime();

		bindCollectorEvents(api.toAPI(), collector);
		await api.fireToolCall("task", { task: "background review" }, "v17-task-running");
		await api.fireToolResult({
			toolName: "task",
			toolCallId: "v17-task-running",
			input: { task: "background review" },
			content: [{ type: "text", text: "Task started." }],
			isError: false,
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				async: { state: "running", jobId: "job-e2e", type: "task" },
			} satisfies TaskToolDetails,
		});
		await api.fireToolCall("mcp__codebase_memory_mcp__index_status", {}, "v17-index");
		await api.fireToolResult({
			toolName: "mcp__codebase_memory_mcp__index_status",
			toolCallId: "v17-index",
			input: {},
			content: [{ type: "text", text: "ordinary content" }],
			isError: false,
			details: { status: "ready" },
		});
		await api.fireToolCall("mcp__codebase_memory_mcp__get_code_snippet", {}, "v17-snippet");
		await api.fireToolResult({
			toolName: "mcp__codebase_memory_mcp__get_code_snippet",
			toolCallId: "v17-snippet",
			input: {},
			content: [{ type: "text", text: "ordinary content" }],
			isError: false,
			details: { file_path: "packages/omp-compliance/src/signals/codebase-memory.ts" },
		});

		const snapshot = collector.collector.snapshot();
		expect(snapshot.subagentDelegations[0]?.status).toBe("insufficient");
		expect(snapshot.codebaseMemory).toEqual({
			indexReady: false,
			queries: ["get_code_snippet"],
			references: [],
		});
	});

	it("records cwd and sessionId from the extension context on calls", async () => {
		const api = new FakeExtensionAPI(
			createFakeExtensionContext({ cwd: "/workspace/task-8", sessionId: "session-task-8" }),
		);
		const collector = new CollectorRuntime();

		bindCollectorEvents(api.toAPI(), collector);
		await api.fireToolCall("search_graph", { query: "Task 8" }, "v17-context-1");
		await api.fireToolResult({
			toolName: "search_graph",
			toolCallId: "v17-context-1",
			input: { query: "Task 8" },
			content: [{ type: "text", text: "ok" }],
			isError: false,
			details: { matches: 1 },
		});

		expect(collector.collector.snapshot().calls[0]).toMatchObject({
			cwd: "/workspace/task-8",
			sessionId: "session-task-8",
		});
	});
});

/** Minimal TDD fixture for start tests. */
const TDD_FIXTURE = [
	"# Test Contract",
	"",
	"## Tests",
	"- bun test",
	"",
	"## Verification",
	"- biome check",
	"",
	"## Completion",
	"- all passing",
	"",
].join("\n");

describe("extension activate — no lazy file side-effects", () => {
	let tmpDir: string;
	let origCwd: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ext-activate-"));
		Bun.spawnSync(["git", "init"], { cwd: tmpDir });
		Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: tmpDir });
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmpDir });
		origCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(origCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("activate 后不创建 .omp/compliance 目录", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(false);
	});

	it("activate 后不创建 .omp/compliance/brainstorm 目录", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(existsSync(join(tmpDir, ".omp/compliance/brainstorm"))).toBe(false);
	});

	it("activate 后 Brainstorm 工具和命令已注册", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getRegisteredCommands()).toContain("brainstorm");
		expect(api.getRegisteredTools()).toContain("brainstorm_topic_ready");
		expect(api.getRegisteredTools()).toContain("brainstorm_decision");
	});

	it("activate 后 advisor_before_run 已绑定", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getBoundEvents()).toContain("advisor_before_run");
	});

	it("协议能力不匹配时拒绝注册控制工具", async () => {
		const api = new FakeExtensionAPI();
		api.advisorReviewCapabilities = undefined;
		const activate = (await import("../src/extension")).default;

		expect(() => activate(api.toAPI())).toThrow("OMP Advisor Review Protocol v1 is required");
		expect(api.getRegisteredTools()).toEqual([]);
	});

	it("注册全部七类 Advisor lifecycle 事件", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		for (const event of [
			"advisor_review_queued",
			"advisor_run_started",
			"advisor_tool_call",
			"advisor_tool_result",
			"advisor_run_completed",
			"advisor_run_failed",
			"advisor_run_cancelled",
		]) {
			expect(api.getBoundEvents()).toContain(event);
		}
	});

	it("session_switch 后仍按 primarySessionId 路由旧会话的 Advisor 回合", async () => {
		const firstRoot = mkdtempSync(join(tmpdir(), "ext-session-first-"));
		const secondRoot = mkdtempSync(join(tmpdir(), "ext-session-second-"));
		for (const root of [firstRoot, secondRoot]) {
			Bun.spawnSync(["git", "init"], { cwd: root });
			Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: root });
			Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: root });
			Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: root });
		}
		const firstContext = createFakeExtensionContext({ cwd: firstRoot, sessionId: "session-first" });
		const secondContext = createFakeExtensionContext({ cwd: secondRoot, sessionId: "session-second" });
		const api = new FakeExtensionAPI(firstContext);
		let request: AdvisorReviewRequest | undefined;
		api.requestAdvisorReview = async (value) => {
			request = value;
			return { status: "accepted", reviewId: value.reviewId };
		};
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());
		await api.fireSessionStart();
		const topicTool = api.toolDefinitions.find((tool) => tool.name === "brainstorm_topic_ready");
		if (!topicTool) throw new Error("brainstorm_topic_ready was not registered");
		const submitted = await topicTool.execute(
			"topic-session-first",
			{
				topic_kind: "architecture",
				title: "Keep session-bound review routing",
				candidate_decision: "Retain runtime bundles until their Advisor review lifecycle finishes.",
				constraints: ["A later session may become active first."],
				success_criteria: ["The original review receives its verdict tool."],
				codebase_relevance: "none",
				discussion_summary: "The host can deliver Advisor events after session_switch.",
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(submitted.isError).toBe(false);
		if (!request) throw new Error("Advisor review was not requested");

		await api.fireSessionSwitch(secondContext);
		const augmentation = await api.fireAdvisorBeforeRun({
			reviewId: request.reviewId,
			trigger: "brainstorm_review",
			metadata: { reviewId: request.reviewId },
			primarySessionId: "session-first",
		});

		expect(augmentation?.verdictToolNames).toEqual(["brainstorm_review"]);
		expect(augmentation?.additionalTools?.map((tool) => tool.name)).toEqual(["brainstorm_review"]);
		rmSync(firstRoot, { recursive: true, force: true });
		rmSync(secondRoot, { recursive: true, force: true });
	});

	it("session_start 使用 context.cwd 初始化项目，而不是激活进程 cwd", async () => {
		const sessionRoot = mkdtempSync(join(tmpdir(), "ext-session-root-"));
		Bun.spawnSync(["git", "init"], { cwd: sessionRoot });
		const api = new FakeExtensionAPI(createFakeExtensionContext({ cwd: sessionRoot }));
		const activate = (await import("../src/extension")).default;

		activate(api.toAPI());
		await api.fireSessionStart();

		expect(existsSync(join(sessionRoot, ".omp/compliance/project.json"))).toBe(true);
		expect(existsSync(join(tmpDir, ".omp/compliance/project.json"))).toBe(false);
		rmSync(sessionRoot, { recursive: true, force: true });
	});

	it("tool_call 先执行写前门再由同一处理器采集", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());
		await api.fireSessionStart();

		expect(api.eventHandlers.get("tool_call")).toHaveLength(1);
		const decision = await api.fireToolCall("edit", { path: "src/unsafe.ts", oldText: "a", newText: "b" });
		expect(decision.block).toBe(true);
		expect(decision.reasons).toContain("missing_contract");
		const audit = readFileSync(join(tmpDir, ".omp/compliance/tasks/unbound-task/events.jsonl"), "utf8");
		expect(audit).toContain('"event":"tool_call_blocked"');
		expect(audit).toContain('"reason":"missing_contract"');
	});

	it("真实扩展入口绑定 TDD 和 Codebase Pack 后放行契约内写操作", async () => {
		const sessionRoot = mkdtempSync(join(tmpdir(), "ext-policy-flow-"));
		mkdirSync(join(sessionRoot, "src"), { recursive: true });
		writeFileSync(join(sessionRoot, "src/index.ts"), "export const value = 1;\n", "utf8");
		writeFileSync(
			join(sessionRoot, "tdd.md"),
			[
				"# Policy flow",
				"",
				"## Scope",
				"- update value",
				"",
				"## Files",
				"- src/index.ts",
				"",
				"## Tests",
				"- bun test",
				"",
				"## Verification",
				"- bun test",
				"",
				"## Completion",
				"- passing",
			].join("\n"),
			"utf8",
		);
		Bun.spawnSync(["git", "init"], { cwd: sessionRoot });
		Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: sessionRoot });
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: sessionRoot });
		Bun.spawnSync(["git", "add", "."], { cwd: sessionRoot });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: sessionRoot });
		const api = new FakeExtensionAPI(createFakeExtensionContext({ cwd: sessionRoot, sessionId: "policy-session" }));
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());
		await api.fireSessionStart();
		const project = realpathSync(sessionRoot).replace(/^\/+/, "").replaceAll("/", "-");
		const fixtures = [
			{
				name: "index_status",
				input: { project },
				details: { status: "ready", revision: "index-v1" },
			},
			{
				name: "search_graph",
				input: { project, query: "value" },
				details: { results: [{ qualified_name: "src.index.value", file_path: "src/index.ts" }] },
			},
			{
				name: "get_code_snippet",
				input: { project, qualified_name: "src.index.value" },
				details: { qualified_name: "src.index.value", file_path: "src/index.ts", line: 1 },
			},
			{
				name: "trace_path",
				input: { project, function_name: "src.index.value", direction: "outbound" },
				details: {
					source: "src.index.value",
					target: "src.index.consumer",
					direction: "outbound",
					file_path: "src/index.ts",
				},
			},
		] as const;
		for (const [index, fixture] of fixtures.entries()) {
			const toolName = `mcp__codebase_memory_mcp__${fixture.name}`;
			const toolCallId = `policy-codebase-${index}`;
			expect((await api.fireToolCall(toolName, fixture.input, toolCallId)).block).toBe(false);
			await api.fireToolResult({
				toolName,
				toolCallId,
				input: fixture.input,
				content: [{ type: "text", text: JSON.stringify(fixture.details) }],
				isError: false,
				details: fixture.details,
			});
		}

		await api.fireCommand("compliance", "start tdd.md");
		const decision = await api.fireToolCall("edit", {
			path: "src/index.ts",
			oldText: "export const value = 1;",
			newText: "export const value = 2;",
		});
		expect(decision).toEqual({ block: false, reasons: [] });
		rmSync(sessionRoot, { recursive: true, force: true });
	});

	it("主代理工具列表不暴露临时裁决工具", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getAllTools()).not.toContain("compliance_verdict");
		expect(api.getAllTools()).not.toContain("brainstorm_review");
	});

	it("activate 后 before_agent_start 会注入专题自动评审提示", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getBoundEvents()).toContain("before_agent_start");
		const handlers = api.eventHandlers.get("before_agent_start") ?? [];
		const result = (await handlers[0]?.({
			type: "before_agent_start",
			prompt: "讨论一个架构方案",
			systemPrompt: ["base"],
		})) as { systemPrompt?: string[] } | undefined;

		expect(result?.systemPrompt?.[0]).toBe("base");
		expect(result?.systemPrompt?.join("\n")).toContain("brainstorm_topic_ready");
	});

	it("start 后 .omp/compliance 目录和 task state 存在", async () => {
		// Write fixture into temp dir
		writeFileSync(join(tmpDir, "tdd.md"), TDD_FIXTURE, "utf-8");
		Bun.spawnSync(["git", "add", "tdd.md"], { cwd: tmpDir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: tmpDir });

		const store = new EvidenceStore(join(tmpDir, ".omp/compliance"));
		const collector = new CollectorRuntime();
		const api = new FakeExtensionAPI();
		const registry = new ComplianceReviewRegistry();
		const reviewDeps = {
			sessionId: () => "test-session",
			registry,
			requestAdvisorReview: (_req: AdvisorReviewRequest) =>
				Promise.resolve<AdvisorReviewReceipt>({ status: "accepted" as const, reviewId: "test-review" }),
		};
		const runtime = new ComplianceRuntime(
			() => store,
			collector,
			api.toAPI(),
			tmpDir,
			reviewDeps,
			createStrictRuntimeDependencies({
				repoRoot: tmpDir,
				store,
				requestAdvisorReview: reviewDeps.requestAdvisorReview,
			}),
		);

		// start task — should create directory
		const { taskId, status } = await runtime.start("tdd.md");

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(true);
		expect(taskId).toBeTruthy();
		expect(status).toBe("active");
	});
});
