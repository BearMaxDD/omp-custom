import { describe, expect, it } from "bun:test";
import { createLightweightTaskContract } from "../../src/contracts/task-contract";
import {
	createDelegationApprovalVerifier,
	createDelegationException,
} from "../../src/delegation/delegation-exception";
import {
	applyDelegationEvent,
	createDelegationEvidenceVerifier,
	createDelegationRecord,
	createTrustedDelegationContext,
	delegationSatisfiesGate,
} from "../../src/delegation/delegation-supervisor";

const REVISION = `sha256:${"b".repeat(64)}` as const;

function contract() {
	return createLightweightTaskContract({
		projectId: "123e4567-e89b-42d3-a456-426614174000",
		gitHead: "a".repeat(40),
		taskId: "task-14",
		affectedFiles: ["src/owned.ts"],
		scope: ["实现任务 14"],
		acceptanceCriteria: ["目标测试通过"],
		verificationCommands: ["bun test"],
		createdAt: "2026-07-18T10:00:00.000Z",
		lowRisk: true,
	});
}

function trustedContext() {
	const taskContract = contract();
	const verifier = createDelegationEvidenceVerifier((revision) => ({
		taskId: taskContract.taskId,
		contractHash: taskContract.contractHash,
		evidenceRevision: revision,
	}));
	return createTrustedDelegationContext({ taskContract, evidenceRevision: REVISION }, verifier);
}

function queuedRecord(overrides: Partial<Parameters<typeof createDelegationRecord>[0]> = {}) {
	return createDelegationRecord({
		delegationId: "delegation-14",
		agentId: "agent-14",
		sessionId: "session-14",
		toolCallId: "tool-call-14",
		transport: "task",
		workPackage: "实现任务 14",
		context: trustedContext(),
		...overrides,
	});
}

describe("DelegationSupervisor 生命周期与完成门", () => {
	it("只允许 queued -> running -> completed，并用可信实际文件和真实工具结果满足 Gate", () => {
		const queued = queuedRecord();
		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: queued.delegationId,
			type: "completed",
			originToolCallId: "tool-call-14",
			resultToolCallId: "tool-call-14",
			actualFiles: ["src/owned.ts"],
			actualFilesKnown: true,
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

	it("未知 actualFiles 即使有工具结果也不能通过", () => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: "delegation-14",
			type: "completed",
			originToolCallId: "tool-call-14",
			resultToolCallId: "tool-call-14",
			actualFilesKnown: false,
			toolEvidenceIds: ["tool-result:tool-call-14"],
		});
		expect(completed.gateStatus).toBe("insufficient");
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("actualFiles 超出 ownedFiles 时形成违规且不满足 Gate", () => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, {
			delegationId: "delegation-14",
			type: "completed",
			originToolCallId: "tool-call-14",
			resultToolCallId: "tool-call-14",
			actualFiles: ["src/owned.ts", "src/outside.ts"],
			actualFilesKnown: true,
			toolEvidenceIds: ["tool-result:tool-call-14"],
		});
		expect(completed.gateStatus).toBe("violation");
		expect(completed.violations).toEqual([{ kind: "outside_owned_files", files: ["src/outside.ts"] }]);
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("规范化仓库相对路径并拒绝越界、绝对路径、NUL 与 Windows drive", () => {
		const taskContract = contract();
		const verifier = createDelegationEvidenceVerifier((revision) => ({
			taskId: taskContract.taskId,
			contractHash: taskContract.contractHash,
			evidenceRevision: revision,
		}));
		expect(() => queuedRecord({ context: createTrustedDelegationContext({
			taskContract: { ...taskContract, affectedFiles: ["src/../outside.ts"] },
			evidenceRevision: REVISION,
		}, verifier) })).toThrow();
		for (const file of ["", "../outside.ts", "/tmp/file.ts", "C:\\repo\\file.ts", "src/\0file.ts"]) {
			expect(() => applyDelegationEvent(
				applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" }),
				{
					delegationId: "delegation-14",
					type: "completed",
					originToolCallId: "tool-call-14",
					resultToolCallId: "tool-call-14",
					actualFiles: [file],
					actualFilesKnown: true,
					toolEvidenceIds: ["tool-result:tool-call-14"],
				},
			)).toThrow();
		}
	});

	it("创建和迁移后的记录、数组与违规对象全部深冻结", () => {
		const queued = queuedRecord();
		expect(Object.isFrozen(queued)).toBe(true);
		expect(Object.isFrozen(queued.ownedFiles)).toBe(true);
		expect(() => (queued.ownedFiles as string[]).push("src/outside.ts")).toThrow();
		const completed = applyDelegationEvent(
			applyDelegationEvent(queued, { delegationId: "delegation-14", type: "started" }),
			{
				delegationId: "delegation-14",
				type: "completed",
				originToolCallId: "tool-call-14",
				resultToolCallId: "tool-call-14",
				actualFiles: ["src/outside.ts"],
				actualFilesKnown: true,
				toolEvidenceIds: ["tool-result:tool-call-14"],
			},
		);
		expect(Object.isFrozen(completed.violations[0])).toBe(true);
		expect(Object.isFrozen(completed.violations[0]?.files)).toBe(true);
	});

	it("拒绝未品牌化上下文、未知 agentId 和超大输入", () => {
		expect(() => createDelegationRecord({
			delegationId: "delegation-14",
			agentId: "agent-14",
			sessionId: "session-14",
			toolCallId: "tool-call-14",
			transport: "task",
			workPackage: "实现任务 14",
			context: { taskContract: contract(), evidenceRevision: REVISION } as ReturnType<typeof trustedContext>,
		})).toThrow("invalid_trusted_delegation_context");
		expect(delegationSatisfiesGate({ ...queuedRecord({ agentId: undefined }), status: "completed", gateStatus: "sufficient" })).toBe(false);
		expect(() => queuedRecord({ workPackage: "x".repeat(5000) })).toThrow();
	});
});

describe("DelegationException 可信审批边界", () => {
	const evidence = {
		id: "evidence-approval-1",
		eventType: "delegation_exception_approved" as const,
		taskId: "task-14",
		reason: "unsafe_to_split" as const,
		operator: { kind: "user" as const, id: "user-1" },
		approvedAt: "2026-07-18T10:00:00.000Z",
	};
	const verifier = createDelegationApprovalVerifier((id) => id === evidence.id ? evidence : null);

	it("字符串前缀或未认证 verifier 不能建立例外", () => {
		const request = { taskId: "task-14", reason: "unsafe_to_split", approvalEvidenceId: evidence.id };
		expect(createDelegationException(request)).toBeNull();
		expect(createDelegationException(request, { verify: () => evidence })).toBeNull();
		expect(createDelegationException({ ...request, approvalEvidenceId: "user:anything" }, verifier)).toBeNull();
	});

	it("仅接受绑定 event type、taskId、reason、operator 与 Evidence ID 的可信审批", () => {
		expect(createDelegationException({
			taskId: "task-14",
			reason: "unsafe_to_split",
			approvalEvidenceId: evidence.id,
		}, verifier)).toEqual({
			taskId: "task-14",
			reason: "unsafe_to_split",
			approvedBy: "user",
			operatorId: "user-1",
			approvalEvidenceId: evidence.id,
			approvedAt: evidence.approvedAt,
		});
	});
});
