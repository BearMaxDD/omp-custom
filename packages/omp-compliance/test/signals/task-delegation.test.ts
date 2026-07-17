import { describe, expect, it } from "bun:test";
import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";

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
							durationMs: 654,
						}),
					],
					outputPaths: ["/tmp/batch-summary.json"],
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
				"/tmp/batch-summary.json",
			],
			codebaseRefs: ["packages/omp-compliance/src/extension.ts", "/tmp/batch-summary.json"],
		});
		expect(evidence[1]).toMatchObject({
			agentId: "run-b",
			agent: "implementer",
			taskSummary: "修复归一化",
			status: "completed",
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
			expect.objectContaining({ status: "insufficient", taskSummary: "后台任务" }),
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
		expect(collector.snapshot().subagentDelegations[0]?.status).toBe("aborted");
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

	it("非 task 工具不产生委派证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({ type: "tool_call", toolName: "bash", toolCallId: "bash-1", input: { command: "ls" } });
		expect(collector.snapshot().subagentDelegations).toHaveLength(0);
	});
});
