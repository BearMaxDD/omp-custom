import { describe, expect, it } from "bun:test";
import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub/types";
import { createLightweightTaskContract } from "../../src/contracts/task-contract";
import {
	createDelegationEvidenceVerifier,
	createDelegationRecord,
	createTrustedDelegationContext,
	delegationSatisfiesGate,
} from "../../src/delegation/delegation-supervisor";
import {
	applyNormalizedDelegationEvents,
	createTrustedDelegationNormalizationContext,
	normalizeDelegationEvents,
	normalizeTaskDelegation,
} from "../../src/signals/task-delegation";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";
import type { ToolCallRecord, ToolResultRecord } from "../../src/signals/types";

function taskCall(input: Record<string, unknown>, toolCallId: string): ToolCallEvent {
	return { type: "tool_call", toolName: "task", toolCallId, input };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "delegation-1",
		agent: "implementer",
		agentSource: "project",
		task: "实现 fixture",
		assignment: "实现 fixture",
		exitCode: 0,
		output: "Updated packages/omp-compliance/src/signals/task-delegation.ts",
		stderr: "",
		truncated: false,
		durationMs: 1_234,
		tokens: 100,
		requests: 2,
		...overrides,
	};
}

function taskDetails(overrides: Partial<TaskToolDetails> = {}): TaskToolDetails {
	return {
		projectAgentsDir: "/repo/.omp/agents",
		results: [singleResult()],
		totalDurationMs: 1_234,
		...overrides,
	};
}

function taskResult(toolCallId: string, details: TaskToolDetails, isError = false): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "task",
		toolCallId,
		input: {},
		content: [{ type: "text", text: "Task finished." }],
		isError,
		details,
	};
}

describe("task-delegation v17 details 领域归一化", () => {
	it("按 results[] 为 batch 的每个 SingleResult 生成 evidence 并保留领域字段", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ context: "Task 8", tasks: [{ task: "A" }, { task: "B" }] }, "batch-1"));
		collector.recordResult(
			taskResult(
				"batch-1",
				taskDetails({
					results: [
						singleResult({
							id: "run-a",
							agent: "scout",
							assignment: "分析入口",
							output: "Found packages/omp-compliance/src/extension.ts",
							outputPath: "/tmp/run-a.txt",
							patchPath: "/tmp/run-a.patch",
							branchName: "task/run-a",
							durationMs: 321,
						}),
						singleResult({
							index: 1,
							id: "run-b",
							agent: "implementer",
							assignment: "修复归一化",
							output: "Changed packages/omp-compliance/src/signals/task-delegation.ts",
							outputPath: "/tmp/run-b.txt",
							durationMs: 654,
						}),
					],
					outputPaths: ["/tmp/run-a.txt", "/tmp/run-b.txt"],
				}),
			),
		);

		const evidence = collector.snapshot().subagentDelegations;
		expect(evidence).toHaveLength(2);
		expect(evidence[0]).toEqual({
			agentId: "run-a",
			agent: "scout",
			taskSummary: "分析入口",
			status: "completed",
			durationMs: 321,
			exitCode: 0,
			outputArtifacts: [
				"Found packages/omp-compliance/src/extension.ts",
				"/tmp/run-a.txt",
				"/tmp/run-a.patch",
				"task/run-a",
			],
			codebaseRefs: ["packages/omp-compliance/src/extension.ts"],
		});
		expect(evidence[1]).toEqual({
			agentId: "run-b",
			agent: "implementer",
			taskSummary: "修复归一化",
			status: "completed",
			durationMs: 654,
			exitCode: 0,
			outputArtifacts: ["Changed packages/omp-compliance/src/signals/task-delegation.ts", "/tmp/run-b.txt"],
			codebaseRefs: ["packages/omp-compliance/src/signals/task-delegation.ts"],
		});
	});

	it.each([
		["non-zero exit", { exitCode: 2 }, "aborted"],
		["aborted", { aborted: true }, "aborted"],
		["error with zero exit", { error: "provider failed" }, "aborted"],
	] as const)("%s 不得标记 completed", (_name, overrides, expected) => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "失败语义" }, "failed-1"));
		collector.recordResult(taskResult("failed-1", taskDetails({ results: [singleResult(overrides)] })));
		expect(collector.snapshot().subagentDelegations[0]?.status).toBe(expected);
	});

	it("async.running 只产生 insufficient，不能误判完成", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "后台任务" }, "async-running"));
		collector.recordResult(
			taskResult(
				"async-running",
				taskDetails({ results: [], async: { state: "running", jobId: "job-1", type: "task" } }),
			),
		);
		expect(collector.snapshot().subagentDelegations).toEqual([
			expect.objectContaining({ jobId: "job-1", status: "insufficient", taskSummary: "后台任务" }),
		]);
	});

	it("results 有 completed 且 async.running 时保留完成项并追加可追踪的未完成占位", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "混合运行任务" }, "mixed-running"));
		collector.recordResult(
			taskResult(
				"mixed-running",
				taskDetails({
					results: [singleResult({ id: "running-completed", assignment: "已完成项" })],
					async: { state: "running", jobId: "job-running", type: "task" },
				}),
			),
		);

		expect(collector.snapshot().subagentDelegations).toEqual([
			expect.objectContaining({ agentId: "running-completed", taskSummary: "已完成项", status: "completed" }),
			expect.objectContaining({ jobId: "job-running", taskSummary: "混合运行任务", status: "insufficient" }),
		]);
	});

	it("async.failed 映射为 aborted", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "后台失败" }, "async-failed"));
		collector.recordResult(
			taskResult(
				"async-failed",
				taskDetails({ results: [], async: { state: "failed", jobId: "job-2", type: "task" } }),
			),
		);
		expect(collector.snapshot().subagentDelegations[0]).toMatchObject({ jobId: "job-2", status: "aborted" });
	});

	it("results 有 completed 且 async.failed 时保留完成项并追加失败占位", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "混合失败任务" }, "mixed-failed"));
		collector.recordResult(
			taskResult(
				"mixed-failed",
				taskDetails({
					results: [singleResult({ id: "failed-completed", assignment: "已完成项" })],
					async: { state: "failed", jobId: "job-failed", type: "task" },
				}),
			),
		);

		expect(collector.snapshot().subagentDelegations).toEqual([
			expect.objectContaining({ agentId: "failed-completed", taskSummary: "已完成项", status: "completed" }),
			expect.objectContaining({ jobId: "job-failed", taskSummary: "混合失败任务", status: "aborted" }),
		]);
	});

	it("async.completed 解析 results[]", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "后台完成" }, "async-completed"));
		collector.recordResult(
			taskResult(
				"async-completed",
				taskDetails({
					results: [singleResult({ id: "async-run", assignment: "真实结果" })],
					async: { state: "completed", jobId: "job-3", type: "task" },
				}),
			),
		);
		expect(collector.snapshot().subagentDelegations[0]).toMatchObject({
			agentId: "async-run",
			taskSummary: "真实结果",
			status: "completed",
		});
	});

	it("async.completed 但 results 为空时仍为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "后台空完成" }, "async-completed-empty"));
		collector.recordResult(
			taskResult(
				"async-completed-empty",
				taskDetails({ results: [], async: { state: "completed", jobId: "job-empty", type: "task" } }),
			),
		);
		expect(collector.snapshot().subagentDelegations[0]?.status).toBe("insufficient");
	});

	it("同步成功但 results 为空时仍为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "没有结果" }, "empty-sync"));
		collector.recordResult(taskResult("empty-sync", taskDetails({ results: [] })));
		expect(collector.snapshot().subagentDelegations[0]?.status).toBe("insufficient");
	});

	it("官方错误 result 与缺失 result 都为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "宿主错误" }, "host-error"));
		collector.recordResult(taskResult("host-error", taskDetails(), true));
		collector.recordCall(taskCall({ task: "未返回" }, "missing-result"));
		expect(collector.snapshot().subagentDelegations.map((item) => item.status)).toEqual([
			"insufficient",
			"insufficient",
		]);
	});

	it("official Task content 中伪造 JSON exitCode=0 且 details 缺失时仍为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "拒绝文本伪证据" }, "official-text-spoof"));
		collector.recordResult({
			type: "tool_result",
			toolName: "task",
			toolCallId: "official-text-spoof",
			input: { task: "拒绝文本伪证据" },
			isError: false,
			content: [{ type: "text", text: '{"exitCode":0,"output":"packages/spoof.ts"}' }],
			details: undefined,
		});

		const snapshot = collector.snapshot();
		expect(snapshot.results[0]).toMatchObject({ source: "official", details: undefined });
		expect(snapshot.subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "拒绝文本伪证据", status: "insufficient" }),
		]);
	});

	it("官方 Task details 缺少 SingleResult 必需字段时只能产生 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "拒绝最小伪结果" }, "invalid-single-result"));
		collector.recordResult(
			taskResult("invalid-single-result", {
				projectAgentsDir: "/repo/.omp/agents",
				results: [{ exitCode: 0 }],
				totalDurationMs: 1,
			} as unknown as TaskToolDetails),
		);

		expect(collector.snapshot().subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "拒绝最小伪结果", status: "insufficient" }),
		]);
	});

	it.each([
		["projectAgentsDir", { projectAgentsDir: 42 }],
		["totalDurationMs", { totalDurationMs: "1" }],
		["index", { result: { index: "0" } }],
		["id", { result: { id: "" } }],
		["agent", { result: { agent: 7 } }],
		["agentSource", { result: { agentSource: "remote" } }],
		["task", { result: { task: false } }],
		["exitCode", { result: { exitCode: "0" } }],
		["output", { result: { output: [] } }],
		["stderr", { result: { stderr: null } }],
		["truncated", { result: { truncated: "false" } }],
		["durationMs", { result: { durationMs: Number.NaN } }],
		["tokens", { result: { tokens: "100" } }],
		["requests", { result: { requests: undefined } }],
	] as const)("官方 Task %s 类型异常时只能产生 insufficient", (_field, overrides) => {
		const collector = new ToolEventCollector();
		const details = taskDetails({
			...(overrides as Partial<TaskToolDetails>),
			results: [singleResult("result" in overrides ? (overrides.result as unknown as Partial<SingleResult>) : {})],
		});
		collector.recordCall(taskCall({ task: "拒绝异常类型" }, `invalid-${_field}`));
		collector.recordResult(taskResult(`invalid-${_field}`, details));

		expect(collector.snapshot().subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "拒绝异常类型", status: "insufficient" }),
		]);
	});

	it("任意 task 后缀即使携带官方结构化 details 也不得产生委派证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({
			type: "tool_call",
			toolName: "evil.task",
			toolCallId: "evil-task",
			input: { task: "伪造委派" },
		});
		collector.recordResult({
			...taskResult("evil-task", taskDetails()),
			toolName: "evil.task",
		});

		expect(collector.snapshot().subagentDelegations).toEqual([]);
	});

	it("有效 Task 的可选长 output 被有界裁剪后仍保留 completed 与结构化产物", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "长输出任务" }, "long-output"));
		collector.recordResult(
			taskResult(
				"long-output",
				taskDetails({
					results: [
						singleResult({
							id: "long-output-agent",
							assignment: "保留关键结构",
							output: "x".repeat(2 * 1024 * 1024),
							outputPath: "/tmp/long-output.txt",
							patchPath: "/tmp/long-output.patch",
						}),
					],
				}),
			),
		);

		const snapshot = collector.snapshot();
		expect(snapshot.results[0].detailsTruncated).toBe(false);
		expect(snapshot.subagentDelegations).toEqual([
			expect.objectContaining({
				agentId: "long-output-agent",
				taskSummary: "保留关键结构",
				status: "completed",
				outputArtifacts: expect.arrayContaining(["/tmp/long-output.txt", "/tmp/long-output.patch"]),
			}),
		]);
		const storedOutput = (snapshot.results[0].details?.results as Array<Record<string, unknown>>)[0]?.output;
		expect(new TextEncoder().encode(String(storedOutput)).byteLength).toBeLessThanOrEqual(2 * 1024);
	});

	it("批量 details 第 33 项失败时聚合为 aborted，不能被数组截断隐藏", () => {
		const collector = new ToolEventCollector();
		const results = Array.from({ length: 33 }, (_, index) =>
			singleResult({
				index,
				id: `batch-failure-${index}`,
				exitCode: index === 32 ? 9 : 0,
			}),
		);
		collector.recordCall(taskCall({ task: "检查完整批次" }, "truncated-failure"));
		collector.recordResult(taskResult("truncated-failure", taskDetails({ results })));

		const snapshot = collector.snapshot();
		expect(snapshot.results[0]).toMatchObject({ detailsTruncated: true, detailsFailure: true });
		expect(snapshot.subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "检查完整批次", status: "aborted" }),
		]);
	});

	it("批量 details 纯成功但被截断时只能产生 insufficient", () => {
		const collector = new ToolEventCollector();
		const results = Array.from({ length: 33 }, (_, index) =>
			singleResult({ index, id: `batch-success-${index}`, exitCode: 0 }),
		);
		collector.recordCall(taskCall({ task: "不完整成功批次" }, "truncated-success"));
		collector.recordResult(taskResult("truncated-success", taskDetails({ results })));

		const snapshot = collector.snapshot();
		expect(snapshot.results[0]).toMatchObject({ detailsTruncated: true, detailsFailure: false });
		expect(snapshot.subagentDelegations).toEqual([
			expect.objectContaining({ taskSummary: "不完整成功批次", status: "insufficient" }),
		]);
	});

	it("非 task 工具不产生委派证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({ type: "tool_call", toolName: "bash", toolCallId: "bash-1", input: { command: "ls" } });
		expect(collector.snapshot().subagentDelegations).toHaveLength(0);
	});
});

function storedCall(toolName: "task" | "hub", toolCallId: string, params: Record<string, unknown>): ToolCallRecord {
	return {
		toolName,
		toolCallId,
		params,
		sessionId: "session-14",
		timestamp: "2026-07-18T10:00:00.000Z",
	};
}

function storedResult(toolCallId: string, details?: Record<string, unknown>): ToolResultRecord {
	return {
		toolCallId,
		success: true,
		resultRef: "Task completed successfully.",
		source: "official",
		details,
		timestamp: "2026-07-18T10:01:00.000Z",
	};
}

function trustedHubContext(binding: Parameters<typeof createTrustedDelegationNormalizationContext>[1][number]) {
	const taskContract = createLightweightTaskContract({
		projectId: "123e4567-e89b-42d3-a456-426614174000",
		gitHead: "a".repeat(40),
		taskId: "task-14",
		affectedFiles: ["src/owned.ts"],
		scope: ["实现任务 14"],
		acceptanceCriteria: ["通过完成门"],
		verificationCommands: ["bun test"],
		createdAt: "2026-07-18T10:00:00.000Z",
		lowRisk: true,
	});
	const evidenceRevision = `sha256:${"b".repeat(64)}` as const;
	const verifier = createDelegationEvidenceVerifier((revision) => ({
		taskId: taskContract.taskId,
		contractHash: taskContract.contractHash,
		evidenceRevision: revision,
		delegations:
			binding.actualFiles === undefined
				? []
				: [
						{
							delegationId: binding.delegationId,
							actualFiles: binding.actualFiles,
						},
					],
	}));
	return createTrustedDelegationNormalizationContext(
		createTrustedDelegationContext({ taskContract, evidenceRevision }, verifier),
		[binding],
	);
}

describe("task/hub 统一委派事件", () => {
	it("从真实 task details 产生 completed 事件和工具 Evidence ID", () => {
		const call = storedCall("task", "task-call-14", { task: "实现任务 14" });
		const events = normalizeDelegationEvents([{ call, result: storedResult(call.toolCallId, taskDetails()) }]);
		expect(events.at(-1)).toEqual(
			expect.objectContaining({
				delegationId: "task-call-14",
				agentId: "delegation-1",
				sessionId: "session-14",
				toolCallId: "task-call-14",
				transport: "task",
				status: "completed",
				workPackage: "实现 fixture",
				toolEvidenceIds: ["tool-result:task-call-14"],
			}),
		);
	});

	it("从 task abortReason 归一化 timed_out", () => {
		const call = storedCall("task", "task-timeout", { task: "超时任务" });
		const details = taskDetails({
			results: [singleResult({ id: "agent-timeout", aborted: true, abortReason: "Timed out waiting for model" })],
		});
		expect(normalizeDelegationEvents([{ call, result: storedResult(call.toolCallId, details) }]).at(-1)).toEqual(
			expect.objectContaining({ delegationId: "task-timeout", agentId: "agent-timeout", status: "timed_out" }),
		);
	});

	it.each(["running", "completed", "failed", "cancelled"] as const)(
		"从真实 hub jobs[] 归一化 task job 的 %s 生命周期",
		(status) => {
			const call = storedCall("hub", `hub-${status}`, { op: "wait", ids: ["agent-hub-14"] });
			const context = trustedHubContext({
				delegationId: "delegation-hub-14",
				transport: "hub",
				originalToolCallId: "task-original-hub-14",
				jobId: "agent-hub-14",
				agentId: "agent-real-14",
			});
			const events = normalizeDelegationEvents(
				[
					{
						call,
						result: storedResult(call.toolCallId, {
							op: "wait",
							jobs: [
								{
									id: "agent-hub-14",
									type: "task",
									status,
									label: "实现 hub 任务",
									durationMs: 123,
								},
							],
						}),
					},
				],
				context,
			);
			expect(events).toEqual([
				expect.objectContaining({
					delegationId: "delegation-hub-14",
					agentId: "agent-real-14",
					sessionId: "session-14",
					toolCallId: `hub-${status}`,
					transport: "hub",
					status,
					workPackage: "实现 hub 任务",
					toolEvidenceIds: [`tool-result:hub-${status}`],
				}),
			]);
		},
	);

	it("hub 普通输出文本不能冒充 task 工具证据", () => {
		const call = storedCall("hub", "hub-text", { op: "wait" });
		const result = storedResult(call.toolCallId);
		result.resultRef = '{"jobs":[{"id":"fake","type":"task","status":"completed"}]}';
		expect(normalizeDelegationEvents([{ call, result }])).toEqual([]);
	});

	it("从 hub task job 的结构化 timeout error 归一化 timed_out", () => {
		const call = storedCall("hub", "hub-timeout", { op: "wait", ids: ["agent-timeout"] });
		const context = trustedHubContext({
			delegationId: "delegation-timeout",
			transport: "hub",
			originalToolCallId: "task-original-timeout",
			jobId: "agent-timeout",
		});
		expect(
			normalizeDelegationEvents(
				[
					{
						call,
						result: storedResult(call.toolCallId, {
							op: "wait",
							jobs: [
								{
									id: "agent-timeout",
									type: "task",
									status: "failed",
									label: "超时任务",
									durationMs: 60_000,
									errorText: "Task timed out",
								},
							],
						}),
					},
				],
				context,
			),
		).toEqual([expect.objectContaining({ delegationId: "delegation-timeout", status: "timed_out" })]);
	});

	it("忽略 hub 中非 task job，task 缺失 result 只产生 queued 且没有工具证据", () => {
		const task = storedCall("task", "task-queued", { task: "待执行" });
		const hub = storedCall("hub", "hub-bash", { op: "jobs" });
		expect(
			normalizeDelegationEvents([
				{ call: task },
				{
					call: hub,
					result: storedResult(hub.toolCallId, {
						op: "jobs",
						jobs: [{ id: "bash-1", type: "bash", status: "completed", label: "build", durationMs: 1 }],
					}),
				},
			]),
		).toEqual([
			expect.objectContaining({
				delegationId: "task-queued",
				transport: "task",
				status: "queued",
				toolEvidenceIds: [],
			}),
		]);
	});
});

describe("task/hub 官方事件到 Completion Gate 的可信闭环", () => {
	const evidenceRevision = `sha256:${"b".repeat(64)}` as const;
	const taskContract = createLightweightTaskContract({
		projectId: "123e4567-e89b-42d3-a456-426614174000",
		gitHead: "a".repeat(40),
		taskId: "task-14",
		affectedFiles: ["src/owned.ts"],
		scope: ["实现任务 14"],
		acceptanceCriteria: ["通过完成门"],
		verificationCommands: ["bun test"],
		createdAt: "2026-07-18T10:00:00.000Z",
		lowRisk: true,
	});
	const verifier = createDelegationEvidenceVerifier((revision) => ({
		taskId: taskContract.taskId,
		contractHash: taskContract.contractHash,
		evidenceRevision: revision,
		delegations: [
			{
				delegationId: "delegation-14",
				actualFiles: ["src/owned.ts"],
				toolEvidenceIds: ["tool-result:task-call-14", "tool-result:hub-poll-14"],
			},
			{ delegationId: "delegation-unknown", actualFiles: ["src/owned.ts"] },
		],
	}));
	const trusted = createTrustedDelegationContext({ taskContract, evidenceRevision }, verifier);

	it("Collector -> Normalizer -> Supervisor 使用同一 delegationId 完成 task", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ task: "实现任务 14" }, "task-call-14"));
		collector.recordResult(taskResult("task-call-14", taskDetails({ results: [singleResult({ id: "agent-real" })] })));
		const snapshot = collector.snapshot();
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-14",
				transport: "task",
				originalToolCallId: "task-call-14",
				agentId: "agent-real",
				sessionId: "session-14",
				actualFiles: ["src/owned.ts"],
			},
		]);
		const events = normalizeDelegationEvents(
			snapshot.calls.map((call) => ({
				call,
				result: snapshot.results.find((result) => result.toolCallId === call.toolCallId),
			})),
			context,
		);
		const queued = createDelegationRecord({
			delegationId: "delegation-14",
			agentId: "agent-real",
			sessionId: "session-14",
			toolCallId: "task-call-14",
			transport: "task",
			workPackage: "实现任务 14",
			context: trusted,
		});
		const completed = applyNormalizedDelegationEvents(queued, events);

		expect(events.map((event) => [event.delegationId, event.status])).toEqual([
			["delegation-14", "running"],
			["delegation-14", "completed"],
		]);
		expect(delegationSatisfiesGate(completed)).toBe(true);
	});

	it("call/result toolCallId 失配时 task 与 hub 都失败关闭", () => {
		const task = storedCall("task", "task-expected", { task: "实现" });
		const hub = storedCall("hub", "hub-expected", { op: "wait", ids: ["job-1"] });
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-14",
				transport: "hub",
				originalToolCallId: "task-original",
				jobId: "job-1",
				agentId: "agent-real",
				actualFiles: ["src/owned.ts"],
			},
		]);
		expect(
			normalizeDelegationEvents([{ call: task, result: storedResult("attacker", taskDetails()) }], context),
		).toEqual([]);
		expect(normalizeDelegationEvents([{ call: hub, result: storedResult("attacker", { jobs: [] }) }], context)).toEqual(
			[],
		);
	});

	it("Hub JobSnapshot 通过 jobId 显式绑定原始委派，轮询 toolCallId 不替换委派身份", () => {
		const job = {
			id: "job-14",
			type: "task",
			status: "completed",
			label: "实现 hub 任务",
			durationMs: 123,
		} satisfies JobSnapshot;
		const poll = storedCall("hub", "hub-poll-14", { op: "wait", ids: [job.id] });
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-14",
				transport: "hub",
				originalToolCallId: "task-original-14",
				jobId: job.id,
				agentId: "agent-real",
				actualFiles: ["src/owned.ts"],
			},
		]);
		const events = normalizeDelegationEvents(
			[{ call: poll, result: storedResult(poll.toolCallId, { op: "wait", jobs: [job] }) }],
			context,
		);
		expect(events).toEqual([
			expect.objectContaining({
				delegationId: "delegation-14",
				jobId: "job-14",
				agentId: "agent-real",
				originToolCallId: "task-original-14",
				resultToolCallId: "hub-poll-14",
				status: "completed",
			}),
		]);
	});

	it("JobSnapshot 不含 agentId 时不得用 job.id 伪装，身份未知的 Gate 不通过", () => {
		const job = {
			id: "job-without-agent",
			type: "task",
			status: "completed",
			label: "未知代理",
			durationMs: 1,
		} satisfies JobSnapshot;
		const poll = storedCall("hub", "hub-poll", { op: "wait", ids: [job.id] });
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-unknown",
				transport: "hub",
				originalToolCallId: "task-original",
				jobId: job.id,
				actualFiles: ["src/owned.ts"],
			},
		]);
		const events = normalizeDelegationEvents(
			[{ call: poll, result: storedResult(poll.toolCallId, { jobs: [job] }) }],
			context,
		);
		expect(events[0]?.agentId).toBeUndefined();
		expect(events[0]?.jobId).toBe(job.id);
		const record = createDelegationRecord({
			delegationId: "delegation-unknown",
			sessionId: "session-14",
			toolCallId: "task-original",
			transport: "hub",
			workPackage: "未知代理",
			context: trusted,
		});
		expect(delegationSatisfiesGate(applyNormalizedDelegationEvents(record, events))).toBe(false);
	});

	it("无可信 actualFiles 绑定时 completed 保持 insufficient", () => {
		const call = storedCall("task", "task-no-files", { task: "实现" });
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-no-files",
				transport: "task",
				originalToolCallId: call.toolCallId,
				agentId: "delegation-1",
			},
		]);
		const events = normalizeDelegationEvents([{ call, result: storedResult(call.toolCallId, taskDetails()) }], context);
		const record = createDelegationRecord({
			delegationId: "delegation-no-files",
			agentId: "delegation-1",
			sessionId: "session-14",
			toolCallId: call.toolCallId,
			transport: "task",
			workPackage: "实现",
			context: trusted,
		});
		expect(delegationSatisfiesGate(applyNormalizedDelegationEvents(record, events))).toBe(false);
	});

	it("拒绝把未被 Evidence attestation 认证的 actualFiles 注入可信绑定", () => {
		expect(() =>
			createTrustedDelegationNormalizationContext(trusted, [
				{
					delegationId: "delegation-14",
					transport: "task",
					originalToolCallId: "task-call-14",
					agentId: "agent-real",
					actualFiles: ["src/outside.ts"],
				},
			]),
		).toThrow("untrusted_delegation_actual_files");
	});

	it("Proxy、getter、非普通原型和超大数组不向外抛并失败关闭", () => {
		const call = storedCall("task", "task-hostile", { task: "实现" });
		const hostileValues: unknown[] = [
			new Proxy(
				{},
				{
					get() {
						throw new Error("proxy trap");
					},
				},
			),
			Object.defineProperty({}, "results", {
				get() {
					throw new Error("getter");
				},
			}),
			Object.create({ results: [] }),
			{ projectAgentsDir: null, totalDurationMs: 1, results: Array.from({ length: 513 }, () => singleResult()) },
		];
		for (const details of hostileValues) {
			expect(() =>
				normalizeDelegationEvents([
					{ call, result: storedResult(call.toolCallId, details as Record<string, unknown>) },
				]),
			).not.toThrow();
			expect(
				normalizeDelegationEvents([
					{ call, result: storedResult(call.toolCallId, details as Record<string, unknown>) },
				]),
			).toEqual([]);
		}
	});

	it("顶层 paired Proxy 与访问器失败关闭且不执行访问器", () => {
		let getterReads = 0;
		const accessorPair = Object.defineProperty({}, "call", {
			enumerable: true,
			get() {
				getterReads += 1;
				return storedCall("task", "accessor", { task: "实现" });
			},
		});
		for (const paired of [
			new Proxy([], {
				get() {
					throw new Error("proxy trap");
				},
			}),
			[accessorPair],
		]) {
			expect(() => normalizeDelegationEvents(paired as never)).not.toThrow();
			expect(normalizeDelegationEvents(paired as never)).toEqual([]);
		}
		expect(getterReads).toBe(0);
	});

	it("SingleResult 结构化字符串超过上限时失败关闭且不保留超大 workPackage", () => {
		const call = storedCall("task", "oversized-result", { task: "实现" });
		const oversized = taskDetails({ results: [singleResult({ task: "x".repeat(5 * 1024 * 1024) })] });
		const events = normalizeDelegationEvents([{ call, result: storedResult(call.toolCallId, oversized) }]);
		expect(events).toEqual([]);
	});

	it.each(["id", "agent", "assignment", "output", "stderr"] as const)(
		"SingleResult.%s 超过字节上限时失败关闭",
		(field) => {
			const call = storedCall("task", `oversized-${field}`, { task: "实现" });
			const details = taskDetails({ results: [singleResult({ [field]: "x".repeat(5000) })] });
			expect(normalizeDelegationEvents([{ call, result: storedResult(call.toolCallId, details) }])).toEqual([]);
		},
	);

	it("兼容 normalizeTaskDelegation 限制输入数量并拒绝 Proxy 与访问器", () => {
		const call = storedCall("task", "compat", { task: "实现" });
		const pair = { call, result: storedResult(call.toolCallId, taskDetails()) };
		expect(normalizeTaskDelegation(Array.from({ length: 513 }, () => pair))).toEqual([]);
		expect(() => normalizeTaskDelegation(new Proxy([], {}) as never)).not.toThrow();
		let reads = 0;
		const accessorPair = Object.defineProperty({}, "call", {
			get() {
				reads += 1;
				return call;
			},
		});
		expect(normalizeTaskDelegation([accessorPair] as never)).toEqual([]);
		expect(reads).toBe(0);
	});

	it("身份任一字段错配时不得把归一化事件应用到记录", () => {
		const call = storedCall("task", "identity-call", { task: "实现" });
		const context = createTrustedDelegationNormalizationContext(trusted, [
			{
				delegationId: "delegation-14",
				transport: "task",
				originalToolCallId: call.toolCallId,
				agentId: "agent-real",
				actualFiles: ["src/owned.ts"],
			},
		]);
		const events = normalizeDelegationEvents(
			[
				{
					call,
					result: storedResult(call.toolCallId, taskDetails({ results: [singleResult({ id: "agent-real" })] })),
				},
			],
			context,
		);
		for (const mismatch of [
			{ agentId: "attacker" },
			{ sessionId: "other-session" },
			{ transport: "hub" as const },
			{ originToolCallId: "other-call" },
			{ resultToolCallId: "other-result" },
		]) {
			const record = createDelegationRecord({
				delegationId: "delegation-14",
				agentId: "agent-real",
				sessionId: "session-14",
				toolCallId: call.toolCallId,
				transport: "task",
				workPackage: "实现",
				context: trusted,
			});
			const tampered = events.map((event) => ({ ...event, ...mismatch }));
			expect(applyNormalizedDelegationEvents(record, tampered)).toBe(record);
		}
	});
});
