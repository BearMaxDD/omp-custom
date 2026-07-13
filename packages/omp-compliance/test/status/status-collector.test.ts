import { beforeEach, describe, expect, it } from "bun:test";
import type { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { StatusCollector } from "../../src/status/collector";

// ─── Fixtures ────────────────────────────────────────────────────────

function createMockRuntime(): ComplianceRuntime {
	return { currentTaskState: null } as unknown as ComplianceRuntime;
}

function createCollector(): StatusCollector {
	const mockRuntime = createMockRuntime();
	const getBrainstormState = () => ({
		active: false,
		topicId: undefined,
		status: undefined,
		topicKind: undefined,
	});
	return new StatusCollector(mockRuntime, getBrainstormState);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("StatusCollector — 规范方法", () => {
	let collector: StatusCollector;

	beforeEach(() => {
		collector = createCollector();
	});

	it("onAdvisorRunStarted 设置 state=\"active\"", () => {
		collector.onAdvisorRunStarted({ reviewId: "rev-001", trigger: "compliance_review" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.active).toBe(true);
		expect(snap.runtime.currentReview).toBeDefined();
		expect(snap.runtime.currentReview?.reviewId).toBe("rev-001");
		expect(snap.runtime.currentReview?.trigger).toBe("compliance_review");
	});

	it("onAdvisorRunFinished 设置 state=\"idle\"", () => {
		collector.onAdvisorRunStarted({ reviewId: "rev-001", trigger: "compliance_review" });
		collector.onAdvisorRunFinished();
		const snap = collector.snapshot();
		expect(snap.advisorSession.active).toBe(false);
		expect(snap.runtime.currentReview).toBeUndefined();
	});

	it("onAdvisorToolCall 增加 mcpCallCount", () => {
		collector.onAdvisorToolCall({ toolName: "read_file", serverName: "filesystem" });
		collector.onAdvisorToolCall({ toolName: "grep", serverName: "filesystem" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.mcpCallCount).toBe(2);
	});

	it("onAdvisorToolCall 记录工具名到 lastToolCalls", () => {
		collector.onAdvisorToolCall({ toolName: "grep", serverName: "fs" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.lastToolCalls).toHaveLength(1);
		expect(snap.advisorSession.lastToolCalls[0].toolName).toBe("grep");
	});

	it("onAdvisorToolCall 不计数非 MCP 调用（无 serverName）", () => {
		collector.onAdvisorToolCall({ toolName: "read" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.mcpCallCount).toBe(0);
	});

	it("onAdvisorSubagentEvent 增加 subagentCount", () => {
		collector.onAdvisorSubagentEvent({ subagentId: "agent-1" });
		collector.onAdvisorSubagentEvent({ subagentId: "agent-2" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.subagentCount).toBe(2);
		expect(snap.advisorSession.subagentIds).toContain("agent-1");
		expect(snap.advisorSession.subagentIds).toContain("agent-2");
	});

	it("onAdvisorSubagentEvent 不重复添加相同 ID", () => {
		collector.onAdvisorSubagentEvent({ subagentId: "agent-1" });
		collector.onAdvisorSubagentEvent({ subagentId: "agent-1" });
		const snap = collector.snapshot();
		expect(snap.advisorSession.subagentCount).toBe(1);
	});

	it("snapshot() 返回当前状态的副本（不可变）", () => {
		collector.onAdvisorToolCall({ toolName: "grep", serverName: "fs" });
		const snap1 = collector.snapshot();
		const snap2 = collector.snapshot();
		// Independent copies
		expect(snap1).toEqual(snap2);
		expect(snap1.advisorSession.lastToolCalls).not.toBe(snap2.advisorSession.lastToolCalls);
	});

	it("reset() 清除所有状态", () => {
		collector.onAdvisorRunStarted({ reviewId: "r1", trigger: "compliance_review" });
		collector.onAdvisorToolCall({ toolName: "read", serverName: "fs" });
		collector.onAdvisorSubagentEvent({ subagentId: "a1" });
		collector.reset();
		const snap = collector.snapshot();
		expect(snap.advisorSession.active).toBe(false);
		expect(snap.advisorSession.mcpCallCount).toBe(0);
		expect(snap.advisorSession.subagentCount).toBe(0);
		expect(snap.runtime.currentReview).toBeUndefined();
	});

	it("setComplianceState / setBrainstormState 为无操作（设计如此）", () => {
		// These are no-ops per design — compliance state comes from the runtime,
		// brainstorm state from the callback. Verify they don't throw.
		expect(() => collector.setComplianceState(true, "task-1", "active")).not.toThrow();
		expect(() =>
			collector.setBrainstormState(true, "topic-1", "advisor_reviewing", "architecture"),
		).not.toThrow();
	});
});
