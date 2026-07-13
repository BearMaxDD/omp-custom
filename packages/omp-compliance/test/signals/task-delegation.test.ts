import { describe, expect, it } from "bun:test";
import { ToolEventCollector } from "../../src/signals/tool-event-collector";

/** Build a tool_call event for the "task" tool. */
function taskCall(params: Record<string, unknown>, toolCallId?: string): Record<string, unknown> {
	return {
		toolName: "task",
		toolCallId: toolCallId ?? `task-${Date.now()}`,
		params,
	};
}

/** Build a tool_result event for a task delegation. */
function taskResult(details: Record<string, unknown>, toolCallId?: string, isError?: boolean): Record<string, unknown> {
	return {
		toolCallId: toolCallId ?? "task-unknown",
		content: JSON.stringify(details),
		result: details,
		isError,
	};
}

describe("task-delegation 证据采集 — 只接受有真实结果的官方 task 委派", () => {
	it("成功完成的 task 委派记录为 completed 状态", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ agent: "implementer", assignment: "实现 fixture" }, "t1"));
		collector.recordResult(taskResult({ agentId: "agent-42", exitCode: 0, output: "参照 src/a.ts" }, "t1"));
		const snap = collector.snapshot();
		expect(snap.subagentDelegations).toHaveLength(1);
		expect(snap.subagentDelegations[0]).toMatchObject({
			agentId: "agent-42",
			status: "completed",
		});
	});

	it("提取 agentId、exitCode、output artifacts", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ assignment: "重构模块" }, "t2"));
		collector.recordResult(
			taskResult(
				{
					agentId: "agent-7",
					exitCode: 0,
					outputs: ["artifact://abc", "artifact://def"],
					duration: 1234,
				},
				"t2",
			),
		);
		const snap = collector.snapshot();
		const ev = snap.subagentDelegations[0];
		expect(ev.agentId).toBe("agent-7");
		expect(ev.status).toBe("completed");
		expect(ev.exitCode).toBe(0);
		expect(ev.outputArtifacts).toContain("artifact://abc");
		expect(ev.outputArtifacts).toContain("artifact://def");
		expect(ev.durationMs).toBe(1234);
	});

	it("退出码非零时标记为 aborted", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ assignment: "危险操作" }, "t3"));
		collector.recordResult(taskResult({ agentId: "agent-x", exitCode: 1, aborted: true }, "t3"));
		const snap = collector.snapshot();
		expect(snap.subagentDelegations[0].status).toBe("aborted");
	});

	it("空调用（无 params）记录为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({}, "t4-no-params"));
		// No result at all
		const snap = collector.snapshot();
		expect(snap.subagentDelegations).toHaveLength(1);
		expect(snap.subagentDelegations[0].status).toBe("insufficient");
	});

	it("无 result 的 task call 标记为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ agent: "runner", assignment: "测试" }, "t5-no-result"));
		const snap = collector.snapshot();
		expect(snap.subagentDelegations[0].status).toBe("insufficient");
	});

	it("错误 result 也标记为 insufficient", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ agent: "runner", assignment: "崩溃任务" }, "t6-error"));
		collector.recordResult(taskResult({ error: "timeout" }, "t6-error", true));
		const snap = collector.snapshot();
		expect(snap.subagentDelegations[0].status).toBe("insufficient");
	});

	it("非 task 工具不产生委派证据", () => {
		const collector = new ToolEventCollector();
		collector.recordCall({
			toolName: "bash",
			toolCallId: "bash-1",
			params: { command: "ls" },
		});
		collector.recordResult({
			toolCallId: "bash-1",
			content: "src/",
		});
		const snap = collector.snapshot();
		expect(snap.subagentDelegations).toHaveLength(0);
	});

	it("提取 codebase 引用", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ assignment: "修复 src/core.ts" }, "t7-refs"));
		collector.recordResult(
			taskResult(
				{
					agentId: "agent-99",
					exitCode: 0,
					artifacts: ["artifact://res"],
					output: "Changed src/core.ts, src/utils/helper.ts",
				},
				"t7-refs",
			),
		);
		const snap = collector.snapshot();
		const ev = snap.subagentDelegations[0];
		expect(ev.codebaseRefs).toContain("src/core.ts");
		expect(ev.codebaseRefs).toContain("src/utils/helper.ts");
	});

	it("多 task 调用的顺序保留", () => {
		const collector = new ToolEventCollector();
		collector.recordCall(taskCall({ assignment: "第一" }, "ta1"));
		collector.recordResult(taskResult({ agentId: "a1", exitCode: 0 }, "ta1"));
		collector.recordCall(taskCall({ assignment: "第二" }, "ta2"));
		collector.recordResult(taskResult({ agentId: "a2", exitCode: 0 }, "ta2"));
		const snap = collector.snapshot();
		expect(snap.subagentDelegations).toHaveLength(2);
	});
});
