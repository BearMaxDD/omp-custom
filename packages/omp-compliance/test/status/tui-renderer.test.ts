import { describe, expect, it } from "bun:test";
import { renderTUIStatus } from "../../src/status/tui-renderer";
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

describe("renderTUIStatus", () => {
	it("不抛出异常（空闲状态）", () => {
		expect(() => renderTUIStatus(idleSnapshot())).not.toThrow();
	});

	it("不抛出异常（活跃状态）", () => {
		expect(() => renderTUIStatus(activeSnapshot())).not.toThrow();
	});

	it("活跃状态包含 ● Active 和子代理计数", () => {
		const result = renderTUIStatus(activeSnapshot());
		expect(result.status).toContain("● Active");
		expect(result.status).toContain("2 sub");
	});

	it("空闲状态包含 ○ Idle", () => {
		const result = renderTUIStatus(idleSnapshot());
		expect(result.status).toContain("○ Idle");
	});

	it("活跃状态包含审查触发器和 MCP 计数", () => {
		const result = renderTUIStatus(activeSnapshot());
		expect(result.status).toContain("compliance_review");
		expect(result.status).toContain("7 MCP");
	});

	it("活跃状态包含建议计数", () => {
		const result = renderTUIStatus(activeSnapshot());
		expect(result.status).toContain("1⛔");
		expect(result.status).toContain("3⚠");
	});

	it("活跃合规填充 footer", () => {
		const result = renderTUIStatus(activeSnapshot());
		expect(result.footer).toBe("task-foo ● advisor_reviewing");
	});

	it("空闲合规 footer 为空", () => {
		const result = renderTUIStatus(idleSnapshot());
		expect(result.footer).toBe("");
	});

	it("无当前审查时 review 显示为 -", () => {
		const snap = idleSnapshot();
		// idleSnapshot 没有 currentReview
		const result = renderTUIStatus(snap);
		expect(result.status).toContain(" - ");
	});
});
