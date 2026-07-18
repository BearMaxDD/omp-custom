import { describe, expect, it } from "bun:test";
import { createLightweightTaskContract } from "../../src/contracts/task-contract";
import {
	createDelegationApprovalVerifier,
	createDelegationException,
} from "../../src/delegation/delegation-exception";
import {
	applyDelegationEvent,
	createDelegationCompletionAttestation,
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

function trustedContext(
	actualFiles: readonly string[] | null = ["src/owned.ts"],
	toolEvidenceIds: readonly string[] = ["tool-result:tool-call-14"],
) {
	const taskContract = contract();
	const verifier = createDelegationEvidenceVerifier((revision) => ({
		taskId: taskContract.taskId,
		contractHash: taskContract.contractHash,
		evidenceRevision: revision,
		delegations: actualFiles === null ? [] : [{ delegationId: "delegation-14", actualFiles, toolEvidenceIds }],
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
		const context = trustedContext();
		const queued = queuedRecord({ context });
		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const completed = applyDelegationEvent(running, createDelegationCompletionAttestation(context, {
				delegationId: queued.delegationId,
				originToolCallId: "tool-call-14",
				resultToolCallId: "tool-call-14",
				toolEvidenceIds: ["tool-result:tool-call-14"],
			}));

		expect([queued.status, running.status, completed.status]).toEqual(["queued", "running", "completed"]);
		expect(completed.gateStatus).toBe("sufficient");
		expect(delegationSatisfiesGate(completed)).toBe(true);
	});

	it("拒绝用相同任务哈希的另一个可信上下文替换原上下文", () => {
		const originalContext = trustedContext();
		const replacementContext = trustedContext();
		const queued = queuedRecord({ context: originalContext });
		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const replaced = applyDelegationEvent(running, createDelegationCompletionAttestation(replacementContext, {
			delegationId: queued.delegationId,
			originToolCallId: queued.toolCallId,
			resultToolCallId: queued.toolCallId,
			toolEvidenceIds: [`tool-result:${queued.toolCallId}`],
		}));

		expect(replaced).toBe(running);
		expect(delegationSatisfiesGate(replaced)).toBe(false);
	});

	it("工具结果 ID 必须由记录原上下文的 Evidence verifier 证明", () => {
		const context = trustedContext(["src/owned.ts"], []);
		const queued = queuedRecord({ context });
		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const completed = applyDelegationEvent(running, createDelegationCompletionAttestation(context, {
			delegationId: queued.delegationId,
			originToolCallId: queued.toolCallId,
			resultToolCallId: queued.toolCallId,
			toolEvidenceIds: [`tool-result:${queued.toolCallId}`],
		}));

		expect(completed.status).toBe("completed");
		expect(completed.toolEvidenceIds).toEqual([]);
		expect(completed.gateStatus).toBe("insufficient");
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it.each(["failed", "cancelled", "timed_out"] as const)("支持 running -> %s 终态", (type) => {
		const running = applyDelegationEvent(queuedRecord(), { delegationId: "delegation-14", type: "started" });
		const terminal = applyDelegationEvent(running, { delegationId: "delegation-14", type });
		expect(terminal.status).toBe(type);
		expect(delegationSatisfiesGate(terminal)).toBe(false);
	});

	it("未知 actualFiles 即使有工具结果也不能通过", () => {
		const context = trustedContext(null);
		const running = applyDelegationEvent(queuedRecord({ context }), { delegationId: "delegation-14", type: "started" });
		const completed = applyDelegationEvent(running, createDelegationCompletionAttestation(context, {
				delegationId: "delegation-14",
				originToolCallId: "tool-call-14",
				resultToolCallId: "tool-call-14",
				toolEvidenceIds: ["tool-result:tool-call-14"],
			}));
		expect(completed.gateStatus).toBe("insufficient");
		expect(delegationSatisfiesGate(completed)).toBe(false);
	});

	it("actualFiles 超出 ownedFiles 时形成违规且不满足 Gate", () => {
		const outsideContract = contract();
		const verifier = createDelegationEvidenceVerifier((revision) => ({
			taskId: outsideContract.taskId,
			contractHash: outsideContract.contractHash,
			evidenceRevision: revision,
			delegations: [{
				delegationId: "delegation-14",
				actualFiles: ["src/owned.ts", "src/outside.ts"],
				toolEvidenceIds: ["tool-result:tool-call-14"],
			}],
		}));
		const context = createTrustedDelegationContext({ taskContract: outsideContract, evidenceRevision: REVISION }, verifier);
		const running = applyDelegationEvent(
			queuedRecord({ context }),
			{ delegationId: "delegation-14", type: "started" },
		);
		const completed = applyDelegationEvent(running, createDelegationCompletionAttestation(context, {
			delegationId: "delegation-14",
			originToolCallId: "tool-call-14",
			resultToolCallId: "tool-call-14",
			toolEvidenceIds: ["tool-result:tool-call-14"],
		}));
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
			const invalidVerifier = createDelegationEvidenceVerifier((revision) => ({
				taskId: taskContract.taskId,
				contractHash: taskContract.contractHash,
				evidenceRevision: revision,
				delegations: [{ delegationId: "delegation-14", actualFiles: [file] }],
			}));
			expect(() => createTrustedDelegationContext({ taskContract, evidenceRevision: REVISION }, invalidVerifier)).toThrow();
		}
	});

	it("创建和迁移后的记录、数组与违规对象全部深冻结", () => {
		const outsideContract = contract();
		const verifier = createDelegationEvidenceVerifier((revision) => ({
			taskId: outsideContract.taskId,
			contractHash: outsideContract.contractHash,
			evidenceRevision: revision,
			delegations: [{
				delegationId: "delegation-14",
				actualFiles: ["src/outside.ts"],
				toolEvidenceIds: ["tool-result:tool-call-14"],
			}],
		}));
		const context = createTrustedDelegationContext({ taskContract: outsideContract, evidenceRevision: REVISION }, verifier);
		const queued = queuedRecord({ context });
		expect(Object.isFrozen(queued)).toBe(true);
		expect(Object.isFrozen(queued.ownedFiles)).toBe(true);
		expect(() => (queued.ownedFiles as string[]).push("src/outside.ts")).toThrow();
		const completed = applyDelegationEvent(
			applyDelegationEvent(queued, { delegationId: "delegation-14", type: "started" }),
			createDelegationCompletionAttestation(context, {
				delegationId: "delegation-14",
				originToolCallId: "tool-call-14",
				resultToolCallId: "tool-call-14",
				toolEvidenceIds: ["tool-result:tool-call-14"],
			}),
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

	it("普通对象不能伪造可信记录或完成证明", () => {
		const queued = queuedRecord();
		const forgedRecord = { ...queued };
		const started = applyDelegationEvent(forgedRecord, { delegationId: queued.delegationId, type: "started" });
		expect(started).toBe(forgedRecord);
		expect(started.status).toBe("queued");

		const running = applyDelegationEvent(queued, { delegationId: queued.delegationId, type: "started" });
		const forgedCompletion = {
			delegationId: queued.delegationId,
			type: "completed" as const,
			originToolCallId: queued.toolCallId,
			resultToolCallId: queued.toolCallId,
			actualFilesKnown: true,
			actualFiles: ["src/owned.ts"],
			toolEvidenceIds: [`tool-result:${queued.toolCallId}`],
		};
		expect(applyDelegationEvent(running, forgedCompletion)).toBe(running);
		expect(delegationSatisfiesGate(running)).toBe(false);
	});

	it("实际文件 Evidence 数组 getter 与 Proxy 被拒绝且不执行 getter", () => {
		const taskContract = contract();
		let getterReads = 0;
		const getterFiles = [] as string[];
		Object.defineProperty(getterFiles, "0", { enumerable: true, get() { getterReads += 1; return "src/owned.ts"; } });
		Object.defineProperty(getterFiles, "length", { value: 1 });
		for (const actualFiles of [getterFiles, new Proxy(["src/owned.ts"], {})]) {
			const verifier = createDelegationEvidenceVerifier((revision) => ({
				taskId: taskContract.taskId,
				contractHash: taskContract.contractHash,
				evidenceRevision: revision,
				delegations: [{ delegationId: "delegation-14", actualFiles }],
			}));
			expect(() => createTrustedDelegationContext({ taskContract, evidenceRevision: REVISION }, verifier)).toThrow();
		}
		expect(getterReads).toBe(0);
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
