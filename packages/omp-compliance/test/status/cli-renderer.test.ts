import { describe, expect, it } from "bun:test";
import { renderCLIStatus } from "../../src/status/cli-renderer";
import type { StatusSnapshot } from "../../src/status/types";

// ─── Fixtures ────────────────────────────────────────────────────────

function idleSnapshot(): StatusSnapshot {
	return {
		runtime: { state: "idle" },
		advisorSession: {
			active: false,
			subagentCount: 0,
			subagentIds: [],
			mcpCallCount: 0,
			lastToolCalls: [],
		},
		advice: { blockers: 0, concerns: 0, nits: 0 },
		compliance: { active: false, attempt: 0 },
		brainstorm: { active: false },
	};
}

function activeSnapshot(): StatusSnapshot {
	return {
		runtime: {
			state: "active",
			currentReview: {
				reviewId: "rev-abcd-001",
				trigger: "compliance_review",
				elapsed: 42,
			},
			progress: {
				current: 3,
				total: 10,
				phase: "testing",
			},
		},
		advisorSession: {
			active: true,
			subagentCount: 2,
			subagentIds: ["agent-alpha", "agent-beta"],
			mcpCallCount: 7,
			lastToolCalls: [
				{ toolName: "read", timestamp: "2026-07-14T00:00:00Z" },
				{ toolName: "grep", timestamp: "2026-07-14T00:00:01Z" },
			],
		},
		advice: { blockers: 1, concerns: 3, nits: 5 },
		compliance: {
			active: true,
			taskId: "task-foo",
			status: "advisor_reviewing",
			attempt: 2,
			lastVerdict: "remediation_required",
		},
		brainstorm: {
			active: true,
			topicId: "topic-xyz",
			status: "advisor_reviewing",
			topicKind: "architecture",
		},
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("renderCLIStatus", () => {
	it("不抛出异常（空闲状态）", () => {
		const snap = idleSnapshot();
		expect(() => renderCLIStatus(snap)).not.toThrow();
	});

	it("不抛出异常（活跃状态）", () => {
		const snap = activeSnapshot();
		expect(() => renderCLIStatus(snap)).not.toThrow();
	});

	it("输出包含面板边框", () => {
		const output = renderCLIStatus(idleSnapshot());
		expect(output).toMatch(/┌─/);
		expect(output).toMatch(/┐$/m);
		expect(output).toMatch(/└/);
		expect(output).toMatch(/┘$/m);
	});

	it("输出包含标题区域", () => {
		const output = renderCLIStatus(idleSnapshot());
		expect(output).toContain("Advisor Status");
	});

	it("输出包含运行时状态", () => {
		const output = renderCLIStatus(activeSnapshot());
		expect(output).toContain("● Active");
	});

	it("输出包含子代理和 MCP 数量", () => {
		const output = renderCLIStatus(activeSnapshot());
		expect(output).toContain("2");
		expect(output).toContain("7");
	});

	it("输出包含建议计数", () => {
		const output = renderCLIStatus(activeSnapshot());
		expect(output).toContain("1");
		expect(output).toContain("⛔");
		expect(output).toContain("3");
		expect(output).toContain("⚠");
	});

	it("输出包含合规任务信息", () => {
		const output = renderCLIStatus(activeSnapshot());
		expect(output).toContain("task-foo");
		expect(output).toContain("advisor_reviewing");
		expect(output).toContain("2");
	});

	it("输出包含头脑风暴信息", () => {
		const output = renderCLIStatus(activeSnapshot());
		expect(output).toContain("topic-xyz");
		expect(output).toContain("architecture");
	});

	it("空闲面板标注 ○ Idle", () => {
		const output = renderCLIStatus(idleSnapshot());
		expect(output).toContain("○ Idle");
	});
});
