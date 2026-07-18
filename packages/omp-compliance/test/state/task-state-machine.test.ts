import { describe, expect, it } from "bun:test";
import { transition } from "../../src/state/task-state-machine";
import type { TaskEvent, TaskState } from "../../src/state/types";

/** Create an ACTIVE task state for testing. */
function activeTask(): TaskState {
	return minimalState("active");
}

/** Create a REMEDIATION_REQUIRED state optionally with a given fingerprint. */
function remediationState(opts: { fingerprint?: string; consecutive?: number } = {}): TaskState {
	return {
		...minimalState("remediation_required"),
		lastRemediationFingerprint: opts.fingerprint,
		consecutiveStalledFingerprints: opts.consecutive ?? 2,
	};
}

/** Create a STALLED state. */
function stalledState(): TaskState {
	return minimalState("stalled");
}

/** Minimal TaskState builder — fills required defaults. */
function minimalState(status: TaskState["status"], overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "test-task",
		projectId: "project-1",
		status,
		attempt: 1,
		contractHash: "sha256:abc123" as `sha256:${string}`,
		evidenceRevision: "sha256:evidence",
		gitHead: "a".repeat(40),
		diffHash: "sha256:diff",
		tddPath: "tasks/test-task.md",
		worktreeFingerprint: "initial",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		consecutiveStalledFingerprints: 0,
		...overrides,
	};
}

// Reusable event builders
const completionRequested = (): TaskEvent => ({
	type: "completion_requested",
	reviewId: "review:default",
	evidenceRevision: "sha256:evidence",
	gitHead: "a".repeat(40),
	diffHash: "sha256:diff",
});
const advisorSilent = (): TaskEvent => ({ type: "advisor_silent" });
const passVerdict = (opts?: { summary?: string }): TaskEvent => ({
	type: "verdict",
	status: "pass",
	schemaValid: true,
	...opts,
});
const remediateVerdict = (requiredFixes: string[]): TaskEvent => ({
	type: "verdict",
	status: "remediation_required",
	requiredFixes,
	schemaValid: true,
});
const remediation = (fingerprint: string): TaskEvent => ({ type: "remediation", fingerprint });
const activity = (wf: string): TaskEvent => ({ type: "activity", worktreeFingerprint: wf });

describe("TaskStateMachine — 只有有效 pass verdict 能完成任务", () => {
	it("非法 completion_requested 事件不得进入 completion_requested", () => {
		const invalid = { type: "completion_requested" } as TaskEvent;
		const next = transition(activeTask(), invalid);
		expect(next.status).toBe("active");
		expect(next.error).toContain("invalid completion context");
	});

	it("completion_requested from active stays completion_requested until host accepts", () => {
		const state = activeTask();
		const requested = transition(state, {
			...completionRequested(),
			reviewId: "review:1",
			evidenceRevision: "sha256:evidence-2",
			gitHead: "b".repeat(40),
			diffHash: "sha256:diff-2",
		});
		expect(requested.status).toBe("completion_requested");
		expect(requested.activeReviewId).toBe("review:1");
		const reviewing = transition(requested, { type: "advisor_accepted", reviewId: "review:1" });
		expect(reviewing.status).toBe("advisor_reviewing");
	});

	it("Envelope persistence failure from active enters stalled", () => {
		const next = transition(activeTask(), {
			type: "completion_failed",
			reviewId: "review:persistence-failed",
			reason: "disk down",
		});
		expect(next.status).toBe("stalled");
		expect(next.error).toBe("disk down");
	});

	it("review failure stalls and retry returns to completion_requested", () => {
		const reviewing = minimalState("advisor_reviewing", { activeReviewId: "review:1" });
		const stalled = transition(reviewing, { type: "review_failed", reviewId: "review:1", reason: "no_verdict" });
		expect(stalled.status).toBe("stalled");
		const retry = transition(stalled, { type: "retry", reviewId: "review:2" });
		expect(retry.status).toBe("completion_requested");
		expect(retry.activeReviewId).toBe("review:2");
	});

	it("user override is terminal and distinct from pass", () => {
		const overridden = transition(activeTask(), { type: "override", reason: "紧急人工放行", actor: "user" });
		expect(overridden.status).toBe("overridden");
		expect(overridden.lastVerdict?.status).not.toBe("pass");
		expect(transition(overridden, passVerdict())).toBe(overridden);
	});

	it("advisor_silent from active does NOT transition to completed", () => {
		const state = activeTask();
		const next = transition(state, advisorSilent());
		expect(next.status).not.toBe("completed");
	});

	it("pass verdict from active does NOT transition to completed (no request)", () => {
		const state = activeTask();
		const next = transition(state, passVerdict());
		expect(next.status).not.toBe("completed");
	});

	it("pass verdict through correct flow transitions to completed", () => {
		const state = activeTask();
		const afterRequest = transition(state, {
			...completionRequested(),
			reviewId: "review:1",
			evidenceRevision: state.evidenceRevision,
			gitHead: state.gitHead,
			diffHash: state.diffHash,
		});
		const reviewing = transition(afterRequest, { type: "advisor_accepted", reviewId: "review:1" });
		const afterPass = transition(reviewing, passVerdict({ summary: "All tests pass" }));
		expect(afterPass.status).toBe("completed");
	});

	it("completed is terminal — no further transitions allowed", () => {
		const state = minimalState("completed");
		expect(transition(state, activity("new")).status).toBe("completed");
		expect(transition(state, completionRequested()).status).toBe("completed");
		expect(transition(state, passVerdict()).status).toBe("completed");
	});
});

describe("TaskStateMachine — 无 verdict 或协议错误失败关闭", () => {
	it("advisor_silent from advisor_reviewing enters stalled", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, advisorSilent());
		expect(next.status).toBe("stalled");
	});

	it("protocol_error from advisor_reviewing stays in advisor_reviewing with error", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, { type: "protocol_error", error: "Schema violation" });
		expect(next.status).toBe("advisor_reviewing");
		expect(next.error).toBeDefined();
	});

	it("verdict with schemaValid=false stays in advisor_reviewing with error", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, {
			type: "verdict",
			status: "pass",
			schemaValid: false,
		});
		expect(next.status).toBe("advisor_reviewing");
		expect(next.error).toBeDefined();
	});

	it("verdict missing schemaValid fails closed", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, { type: "verdict", status: "pass" } as never);
		expect(next.status).toBe("advisor_reviewing");
		expect(next.error).toContain("Schema validation failed");
	});

	it("pass verdict with task/hash mismatch stays in advisor_reviewing", () => {
		const state = minimalState("advisor_reviewing");
		// Verdict with summary but schema invalid — simulation of mismatch
		const next = transition(state, {
			type: "verdict",
			status: "pass",
			schemaValid: false,
		});
		expect(next.status).toBe("advisor_reviewing");
	});
});

describe("TaskStateMachine — 连续无变化 remediation 进入 stalled，实质变化可恢复", () => {
	it("same fingerprint three times enters stalled", () => {
		const first = remediationState({ fingerprint: "same", consecutive: 2 });
		const next = transition(first, remediation("same"));
		expect(next.status).toBe("stalled");
	});

	it("different fingerprint does NOT enter stalled", () => {
		const first = remediationState({ fingerprint: "same", consecutive: 2 });
		const next = transition(first, remediation("different"));
		expect(next.status).toBe("remediation_required");
		expect(next.consecutiveStalledFingerprints).toBe(1);
	});

	it("from stalled, activity with changed fingerprint resumes to active", () => {
		const state = stalledState();
		const next = transition(state, activity("changed"));
		expect(next.status).toBe("active");
	});

	it("from stalled, activity with same fingerprint stays stalled", () => {
		const state = minimalState("stalled", { worktreeFingerprint: "unchanged" });
		const next = transition(state, activity("unchanged"));
		expect(next.status).toBe("stalled");
	});
});

describe("TaskStateMachine — remediation 至少一个 required_fix", () => {
	it("remediation_required verdict with empty requiredFixes stays in advisor_reviewing", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, remediateVerdict([]));
		expect(next.status).toBe("advisor_reviewing");
		expect(next.error).toBeDefined();
	});

	it("remediation_required verdict with fixes transitions correctly", () => {
		const state = minimalState("advisor_reviewing");
		const next = transition(state, remediateVerdict(["fix typo", "add tests"]));
		expect(next.status).toBe("remediation_required");
	});
});

describe("TaskStateMachine — pass 后不接受 remediate", () => {
	it("remediation event from completed is ignored", () => {
		const state = minimalState("completed");
		const next = transition(state, remediation("whatever"));
		expect(next.status).toBe("completed");
	});

	it("pass verdict after completed is idempotent", () => {
		const state = minimalState("completed");
		const next = transition(state, passVerdict());
		expect(next.status).toBe("completed");
	});
});

describe("TaskStateMachine — 完整生命周期", () => {
	it("full happy path: inactive -> active -> completion_requested -> advisor_reviewing -> completed", () => {
		let s: TaskState = minimalState("inactive");
		s = transition(s, activity("work1"));
		expect(s.status).toBe("active");
		s = transition(s, { ...completionRequested(), reviewId: "review:happy" });
		expect(s.status).toBe("completion_requested");
		s = transition(s, { type: "advisor_accepted", reviewId: "review:happy" });
		expect(s.status).toBe("advisor_reviewing");
		s = transition(s, passVerdict({ summary: "pass" }));
		expect(s.status).toBe("completed");
	});

	it("full remediation path: active -> ... -> remediation_required -> active again", () => {
		let s: TaskState = minimalState("active");
		s = transition(s, { ...completionRequested(), reviewId: "review:remediate" });
		s = transition(s, { type: "advisor_accepted", reviewId: "review:remediate" });
		s = transition(s, remediateVerdict(["fix it"]));
		expect(s.status).toBe("remediation_required");
		s = transition(s, activity("rework"));
		expect(s.status).toBe("active");
	});

	it("stalled -> active -> completed cycle", () => {
		let s: TaskState = minimalState("stalled");
		s = transition(s, activity("new-work"));
		expect(s.status).toBe("active");
		s = transition(s, { ...completionRequested(), reviewId: "review:resume" });
		s = transition(s, { type: "advisor_accepted", reviewId: "review:resume" });
		s = transition(s, passVerdict());
		expect(s.status).toBe("completed");
	});
});
