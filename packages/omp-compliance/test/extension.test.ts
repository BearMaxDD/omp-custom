import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("keeps async running incomplete and reads codebase references from structured details", async () => {
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
		expect(snapshot.codebaseMemory.indexReady).toBe(true);
		expect(snapshot.codebaseMemory.references).toContain("packages/omp-compliance/src/signals/codebase-memory.ts");
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

		const store = new EvidenceStore(join(tmpDir, ".omp/compliance"));
		const collector = new CollectorRuntime();
		const api = new FakeExtensionAPI();
		const registry = new ComplianceReviewRegistry();
		const runtime = new ComplianceRuntime(() => store, collector, api.toAPI(), tmpDir, {
			sessionId: () => "test-session",
			registry,
			requestAdvisorReview: (_req: AdvisorReviewRequest) =>
				Promise.resolve<AdvisorReviewReceipt>({ status: "accepted" as const, reviewId: "test-review" }),
		});

		// start task — should create directory
		const { taskId, status } = await runtime.start("tdd.md");

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(true);
		expect(taskId).toBeTruthy();
		expect(status).toBe("active");
	});
});
