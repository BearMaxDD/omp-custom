import { describe, expect, it } from "bun:test";
import { createDelegationException } from "../../src/delegation/delegation-exception";
import {
	applyDelegationEvent,
	createDelegationRecord,
	delegationSatisfiesGate,
} from "../../src/delegation/delegation-supervisor";

const HASH = `sha256:${"a".repeat(64)}` as const;
const REVISION = `sha256:${"b".repeat(64)}` as const;

function queuedRecord() {
	return createDelegationRecord({
		delegationId: "delegation-14",
		taskId: "task-14",
		agentId: "agent-14",
		sessionId: "session-14",
		toolCallId: "tool-call-14",
		transport: "task",
		workPackage: "实现任务 14",
		ownedFiles: ["src/owned.ts"],
		contractHash: HASH,
		evidenceRevision: REVISION,
		verificationCommands: ["bun test"],
	});
}

describe("DelegationSupervisor 生命周期与完成门", () => {
	it("只允许 queued -> running -> completed，并用真实工具结果满足 Gate", () => {
		const queued = queuedRecord();
		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: queued.delegationId,
			type: "completed",
			actualFiles: ["src/owned.ts"],
			toolEvidenceIds: ["tool-result:tool-call-14"],
		});

		expect([queued.status, running.status, completed.status]).toEqual(["queued", "running", "completed"]);
		expect(completed.gateStatus).toBe("sufficient");
		expect(delegationSatisfiesGate(completed)).toBe(true);
	});

	it.each(["failed", "cancelled", "timed_out"] as const)("支持 running -> %s 终态", (type) => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const terminal = applyDelegationEvent(running, { delegationId: "delegation-14", type });
		expect(terminal.status).toBe(type);
		expect(delegationSatisfiesGate(terminal)).toBe(false);
	});

	it("拒绝非法迁移、其他 delegationId 事件和终态覆盖", () => {
		const queued = queuedRecord();
		const skipped = applyDelegationEvent(queued, {
			delegationId: queued.delegationId,
			type: "completed",
			actualFiles: [],
			toolEvidenceIds: ["tool-result:tool-call-14"],
		});
		expect(skipped).toBe(queued);
		expect(applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "failed" })).toBe(queued);

		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const failed = applyDelegationEvent(running, { delegationId: queued.delegationId, type: "failed" });
		expect(applyDelegationEvent(failed, { delegationId: queued.delegationId, type: "started" })).toBe(failed);
		expect(applyDelegationEvent(running, { delegationId: "other", type: "failed" })).toBe(running);
	});

	it("completed 没有真实 tool result 时标记 insufficient", () => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: "delegation-14",
			type: "completed",
			actualFiles: ["src/owned.ts"],
			toolEvidenceIds: [],
		});
		expect(completed.status).toBe("completed");
		expect(completed.gateStatus).toBe("insufficient");
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("拒绝把普通输出或其他 toolCallId 冒充真实工具证据", () => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: "delegation-14",
			type: "completed",
			actualFiles: ["src/owned.ts"],
			toolEvidenceIds: ["Task completed", "tool-result:other-call"],
		});
		expect(completed.toolEvidenceIds).toEqual([]);
		expect(completed.gateStatus).toBe("insufficient");
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("actualFiles 超出 ownedFiles 时形成违规且不满足 Gate", () => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: "delegation-14",
			type: "completed",
			actualFiles: ["src/owned.ts", "src/outside.ts"],
			toolEvidenceIds: ["tool-result:tool-call-14"],
		});
		expect(completed.gateStatus).toBe("violation");
		expect(completed.violations).toEqual([{ kind: "outside_owned_files", files: ["src/outside.ts"] }]);
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("身份或契约关联不完整时不满足 Gate", () => {
		const complete = queuedRecord();
		for (const field of ["agentId", "sessionId", "toolCallId", "contractHash", "evidenceRevision"] as const) {
			const invalid = { ...complete, [field]: "" };
			expect(delegationSatisfiesGate({ ...invalid, status: "completed", gateStatus: "sufficient" })).toBe(false);
		}
	});
});

describe("DelegationException 审批边界", () => {
	it("主代理自称 trivial 或自由文本原因不能建立例外", () => {
		expect(
			createDelegationException({
				taskId: "task-14",
				reason: "trivial_change",
				approvedBy: "main",
				approvalEvidenceId: "claim:main",
				approvedAt: "2026-07-18T10:00:00.000Z",
			}),
		).toBeNull();
		expect(
			createDelegationException({
				taskId: "task-14",
				reason: "I think this is trivial",
				approvedBy: "user",
				approvalEvidenceId: "user-message:1",
				approvedAt: "2026-07-18T10:00:00.000Z",
			}),
		).toBeNull();
		expect(
			createDelegationException({
				taskId: "task-14",
				reason: "trivial_change",
				approvedBy: "user",
				approvalEvidenceId: "advisor:wrong-actor",
				approvedAt: "2026-07-18T10:00:00.000Z",
			}),
		).toBeNull();
	});

	it.each(["user", "advisor"] as const)("%s 显式批准固定原因时建立可审计例外", (approvedBy) => {
		const exception = createDelegationException({
			taskId: "task-14",
			reason: "unsafe_to_split",
			approvedBy,
			approvalEvidenceId: `${approvedBy}:approval-1`,
			approvedAt: "2026-07-18T10:00:00.000Z",
		});
		expect(exception).toEqual({
			taskId: "task-14",
			reason: "unsafe_to_split",
			approvedBy,
			approvalEvidenceId: `${approvedBy}:approval-1`,
			approvedAt: "2026-07-18T10:00:00.000Z",
		});
	});
});
