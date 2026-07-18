import { describe, expect, it } from "bun:test";
import type { EvidenceSnapshot } from "../../src/signals/types";
import type { TaskState } from "../../src/state/types";
import { type EvidenceGaps, toStatusViewModel } from "../../src/status/status-view-model";

// ─── Fixture builders ──────────────────────────────────────────────

function activeTask(overrides?: Partial<TaskState>): TaskState {
	return {
		taskId: "task-001",
		status: "active",
		attempt: 2,
		contractHash: "abcdef1234567890deadbeef",
		tddPath: "/path/to/tdd.md",
		worktreeFingerprint: "fp-current",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		consecutiveStalledFingerprints: 0,
		...overrides,
	};
}

function remediationTask(overrides?: Partial<TaskState>): TaskState {
	return {
		...activeTask({
			status: "remediation_required",
			lastVerdict: {
				status: "remediation_required",
				requiredFixes: ["补充失败路径测试"],
				schemaValid: true,
			},
		}),
		...overrides,
	};
}

function completedTask(overrides?: Partial<TaskState>): TaskState {
	return {
		...activeTask({
			status: "completed",
			lastVerdict: {
				status: "pass",
				summary: "All tests pass",
				schemaValid: true,
			},
		}),
		...overrides,
	};
}

function stalledTask(overrides?: Partial<TaskState>): TaskState {
	return {
		...activeTask({
			status: "stalled",
			consecutiveStalledFingerprints: 3,
			lastRemediationFingerprint: "remediation-fp-001",
		}),
		...overrides,
	};
}

function emptySnapshot(): EvidenceSnapshot {
	return {
		calls: [],
		results: [],
		codebaseMemory: { indexReady: false, queries: [], references: [] },
		subagentDelegations: [],
		verifications: [],
	};
}

function fullSnapshot(): EvidenceSnapshot {
	return {
		calls: [],
		results: [],
		codebaseMemory: { indexReady: true, queries: ["search tool", "grep"], references: ["src/main.ts"] },
		subagentDelegations: [
			{
				status: "completed",
				outputArtifacts: ["out.json"],
				codebaseRefs: [],
			},
		],
		verifications: [
			{ command: "bun test", exitCode: 0, changedPaths: [], passed: true },
			{ command: "biome check", exitCode: 0, changedPaths: [], passed: true },
		],
	};
}

function partialSnapshot(): EvidenceSnapshot {
	return {
		...emptySnapshot(),
		codebaseMemory: { indexReady: false, queries: ["search"], references: [] },
	};
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("toStatusViewModel", () => {
	it("shows active status with no verdict", () => {
		const view = toStatusViewModel(activeTask());
		expect(view.status).toBe("active");
		expect(view.attempt).toBe(2);
		expect(view.lastVerdict).toBeUndefined();
		expect(view.requiredFixes).toEqual([]);
		expect(view.verificationSummary).toBeUndefined();
	});

	it("shows contract hash short code", () => {
		const view = toStatusViewModel(activeTask({ contractHash: "deadbeefcafe" }));
		expect(view.contractHashShort).toBe("deadbeef");
	});

	it("truncates hash shorter than 8 chars", () => {
		const view = toStatusViewModel(activeTask({ contractHash: "abc" }));
		expect(view.contractHashShort).toBe("abc");
	});

	it("shows tdd path", () => {
		const view = toStatusViewModel(activeTask({ tddPath: "my-tdd.md" }));
		expect(view.tddPath).toBe("my-tdd.md");
	});

	it("shows contract, attempt, verdict, fixes, and evidence gaps for remediation task", () => {
		const view = toStatusViewModel(remediationTask(), fullSnapshot());
		expect(view.status).toBe("remediation_required");
		expect(view.attempt).toBe(2);
		expect(view.lastVerdict).toBeDefined();
		expect(view.lastVerdict?.status).toBe("remediation_required");
		expect(view.requiredFixes).toEqual(["补充失败路径测试"]);
		expect(view.evidence.codebaseMemory).toBe("present");
		expect(view.evidence.taskDelegation).toBe("present");
		expect(view.advisor.available).toBe(true);
	});

	it("marks advisor unavailable for completed tasks", () => {
		const view = toStatusViewModel(completedTask());
		expect(view.advisor.available).toBe(false);
	});

	it("includes verification summary when snapshot present", () => {
		const view = toStatusViewModel(activeTask(), fullSnapshot());
		expect(view.verificationSummary).toBe("2/2 verifications passed");
	});

	it("omits verification summary when snapshot is empty", () => {
		const view = toStatusViewModel(activeTask());
		expect(view.verificationSummary).toBeUndefined();
	});

	it("returns evidence gaps from snapshot", () => {
		const view = toStatusViewModel(activeTask(), fullSnapshot());
		expect(view.evidence).toEqual({
			codebaseMemory: "present",
			taskDelegation: "present",
		} satisfies EvidenceGaps);
	});

	it("classifies no queries and no references as missing", () => {
		const view = toStatusViewModel(activeTask(), emptySnapshot());
		expect(view.evidence.codebaseMemory).toBe("missing");
		expect(view.evidence.taskDelegation).toBe("missing");
	});

	it("classifies index not ready as partial", () => {
		const view = toStatusViewModel(activeTask(), partialSnapshot());
		expect(view.evidence.codebaseMemory).toBe("partial");
	});

	it("classifies aborted delegation as partial", () => {
		const snap: EvidenceSnapshot = {
			...fullSnapshot(),
			subagentDelegations: [{ status: "aborted", outputArtifacts: [], codebaseRefs: [] }],
		};
		const view = toStatusViewModel(activeTask(), snap);
		expect(view.evidence.taskDelegation).toBe("partial");
	});

	it("works for stalled task", () => {
		const view = toStatusViewModel(stalledTask());
		expect(view.status).toBe("stalled");
		expect(view.advisor.available).toBe(true);
	});

	it("overridden 使用独立终态且不得展示为 pass", () => {
		const view = toStatusViewModel(
			activeTask({
				status: "overridden",
				lastVerdict: undefined,
				error: "Overridden by user: emergency release",
			}),
		);
		expect(view.status).toBe("overridden");
		expect(view.advisor.available).toBe(false);
		expect(view.outcome).toBe("manual_override");
		expect(view.lastVerdict?.status).not.toBe("pass");
	});
});
