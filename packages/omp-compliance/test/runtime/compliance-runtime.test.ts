import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { ComplianceReviewDependencies } from "../../src/advisor/review-envelope";
import { createReviewEnvelope } from "../../src/contracts/review-envelope";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { buildCompletionSnapshot } from "../../src/runtime/completion-gate";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import { createStrictRuntimeDependencies } from "../support/strict-runtime-dependencies";

// ─── Minimal Fake API for runtime tests ─────────────────────────────

class MinimalAPI {
	public sentMessages: unknown[] = [];
	public entries: Array<{ type: string; data?: unknown }> = [];

	registerTool(): void {}
	requestAdvisorReview = (_request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> =>
		Promise.resolve({ status: "accepted" as const, reviewId: "test-review" });

	sendMessage(message: unknown, _options?: { triggerTurn?: boolean; deliverAs?: string }): void {
		this.sentMessages.push(message);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: customType, data });
	}

	logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ─── Test Setup ─────────────────────────────────────────────────────

let tmpDir: string;
let reviewDeps: ComplianceReviewDependencies;
let mockRequestReviewReturn: AdvisorReviewReceipt;
let mockRequestReviewCalls: AdvisorReviewRequest[];
let api: MinimalAPI;
let store: EvidenceStore;
let collector: CollectorRuntime;
let runtime: ComplianceRuntime;
let verificationSequence = 0;

function recordTrustedVerification(
	target: CollectorRuntime,
	verification: { command: string; exitCode: number },
): void {
	const toolCallId = `trusted-verification-${++verificationSequence}`;
	const timestamp = new Date().toISOString();
	target.collector.recordCall({ toolName: "bash", toolCallId, params: { command: verification.command }, timestamp });
	target.collector.recordResult({
		toolCallId,
		success: verification.exitCode === 0,
		resultRef: JSON.stringify({ exitCode: verification.exitCode }),
		timestamp,
	});
}

function advisorVerdict(
	runtime: ComplianceRuntime,
	opts: {
		status: "pass" | "remediate";
		findings?: Array<{ id: string; reason: string; required_fix?: string }>;
	},
): Record<string, unknown> {
	const state = runtime.currentTaskState;
	if (!state) throw new Error("No active task — verdict helper called at wrong time");
	return {
		schema_version: 1,
		review_id: state.activeReviewId,
		task_id: state.taskId,
		project_id: state.projectId,
		contract_hash: state.contractHash,
		evidence_revision: state.evidenceRevision,
		git_head: state.gitHead,
		diff_hash: state.diffHash,
		trigger: "compliance_review",
		attempt: state.attempt,
		status: opts.status,
		findings: opts.findings ?? [],
	};
}

describe("ReviewEnvelope — 严格上下文", () => {
	it("相同输入生成稳定 reviewId 并深冻结", () => {
		const input = {
			taskId: "task-1",
			projectId: "project-1",
			contractHash: `sha256:${"a".repeat(64)}`,
			evidenceRevision: `sha256:${"b".repeat(64)}`,
			gitHead: "c".repeat(40),
			diffHash: `sha256:${"d".repeat(64)}`,
			attempt: 1,
			trigger: "compliance_review" as const,
			createdAt: "2026-07-18T00:00:00.000Z",
		};
		const first = createReviewEnvelope(input);
		const second = createReviewEnvelope(input);
		expect(first.reviewId).toBe(second.reviewId);
		expect(Object.isFrozen(first)).toBe(true);
	});

	it("拒绝 accessor 与无界字段", () => {
		const hostile = Object.defineProperty({}, "taskId", { get: () => "task-1", enumerable: true });
		expect(() => createReviewEnvelope(hostile as never)).toThrow();
	});
});

function finding(
	id: string,
	reason: string,
	requiredFix?: string,
): { id: string; reason: string; required_fix?: string } {
	const f: { id: string; reason: string; required_fix?: string } = { id, reason };
	if (requiredFix !== undefined) f.required_fix = requiredFix;
	return f;
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `omp-runtime-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });

	// Write a minimal TDD file
	writeFileSync(
		join(tmpDir, "tdd.md"),
		[
			"# Goal: Build feature",
			"",
			"## Scope",
			"- core module",
			"",
			"## Files",
			"- src/index.ts",
			"",
			"## Tests",
			"- bun test",
			"",
			"## Verification",
			"- biome check",
			"",
			"## Completion",
			"- all passing",
			"",
		].join("\n"),
		"utf-8",
	);
	Bun.spawnSync(["git", "init"], { cwd: tmpDir });
	Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: tmpDir });
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmpDir });
	Bun.spawnSync(["git", "add", "tdd.md"], { cwd: tmpDir });
	Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: tmpDir });

	const evidenceDir = join(tmpDir, ".omp", "evidence");
	api = new MinimalAPI();
	store = new EvidenceStore(evidenceDir);
	collector = new CollectorRuntime();
	mockRequestReviewCalls = [];
	mockRequestReviewReturn = { status: "accepted" as const, reviewId: "test-review" };
	reviewDeps = {
		sessionId: () => "test-session",
		registry: new ComplianceReviewRegistry(),
		requestAdvisorReview: (req: AdvisorReviewRequest) => {
			mockRequestReviewCalls.push(req);
			return Promise.resolve(mockRequestReviewReturn);
		},
	};
	runtime = new ComplianceRuntime(
		() => store,
		collector,
		api,
		tmpDir,
		reviewDeps,
		createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		}),
	);
	recordTrustedVerification(collector, { command: "bun test", exitCode: 0 });
});

// ─── Tests: Start ───────────────────────────────────────────────────

describe("ComplianceRuntime — start", () => {
	it("should start a managed code task and return task id", async () => {
		const result = await runtime.start("tdd.md");
		expect(result.taskId).toBeDefined();
		expect(result.taskId.length).toBeGreaterThan(0);
		expect(result.status).toBe("active");
	});

	it("should write active evidence record on start", async () => {
		const { taskId } = await runtime.start("tdd.md");
		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "active")).toBe(true);
	});

	it("should send compliance_managed message on start", async () => {
		await runtime.start("tdd.md");
		expect(api.sentMessages.length).toBeGreaterThan(0);
	});

	it("should throw when starting a second task while one is active", async () => {
		await runtime.start("tdd.md");
		expect(runtime.start("tdd.md")).rejects.toThrow("already active");
	});
});

// ─── Tests: Stop ────────────────────────────────────────────────────

describe("ComplianceRuntime — stop", () => {
	it("should stop an active task and record stopped event", async () => {
		const { taskId } = await runtime.start("tdd.md");
		const result = await runtime.stop();
		expect(result.stopped).toBe(true);
		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "stopped")).toBe(true);
	});

	it("should return false when no task is active", async () => {
		const result = await runtime.stop();
		expect(result.stopped).toBe(false);
	});
});

// ─── Tests: Resume ──────────────────────────────────────────────────

describe("ComplianceRuntime — resume", () => {
	it("should throw when no stalled task matches the given id", async () => {
		expect(runtime.resume("non-existent")).rejects.toThrow("No stalled task");
	});

	it("should throw when task is not stalled", async () => {
		const { taskId } = await runtime.start("tdd.md");
		expect(runtime.resume(taskId)).rejects.toThrow("not stalled");
	});
});

// ─── Tests: Request Completion ──────────────────────────────────────

describe("ComplianceRuntime — requestCompletion", () => {
	it("完成请求只进入 advisor_reviewing，不会自行通过", async () => {
		await runtime.start("tdd.md");
		recordTrustedVerification(collector, { command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "已完成" });

		expect(result.status).toBe("advisor_reviewing");
		expect(result.completionSnapshot).toBeDefined();
		expect(result.completionSnapshot.codebaseMemory).toBeDefined();
		expect(result.completionSnapshot.verifications).toBeDefined();
	});

	it("should throw when no task is active", async () => {
		expect(runtime.requestCompletion({ summary: "Done" })).rejects.toThrow("No active compliance task");
	});

	it("should throw when task is not in active status", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		expect(runtime.requestCompletion({ summary: "Again" })).rejects.toThrow("Cannot request completion");
	});

	it("should include agent claim params in the snapshot", async () => {
		await runtime.start("tdd.md");
		const result = await runtime.requestCompletion({
			summary: "Completed feature X",
			claimedVerification: ["test passes", "lint clean"],
		});

		expect(result.completionSnapshot.agentClaim.summary).toBe("Completed feature X");
		expect(result.completionSnapshot.agentClaim.claimedVerification).toEqual(["test passes", "lint clean"]);
	});
});

// ─── Tests: Request Completion — Advisor Review Path ─────────────────

describe("ComplianceRuntime — requestCompletion advisor review path", () => {
	it("Envelope 持久化失败时保持 active 且不入队", async () => {
		await runtime.start("tdd.md");
		const original = store.append.bind(store);
		store.append = async (record) => {
			if (record.event === "completion_requested") throw new Error("disk down");
			await original(record);
		};
		await expect(runtime.requestCompletion({ summary: "Done" })).rejects.toThrow("disk down");
		expect(runtime.currentTaskState?.status).toBe("active");
		expect(mockRequestReviewCalls).toHaveLength(0);
	});

	it("应调用 requestAdvisorReview 并正确设置 trigger/metadata", async () => {
		await runtime.start("tdd.md");
		recordTrustedVerification(collector, { command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "Done" });

		// One call to requestAdvisorReview
		expect(mockRequestReviewCalls.length).toBe(1);
		const req = mockRequestReviewCalls[0];
		expect(req.reviewId).toMatch(/^review:/);
		expect(req).toMatchObject({ trigger: "compliance_review", priority: 100 });
		// Metadata binds task/hash/attempt
		expect(req.metadata?.taskId).toBe(result.completionSnapshot.taskId);
		expect(req.metadata?.contractHash).toMatch(/^sha256:/);
		expect(req.metadata?.attempt).toBe(1);
		expect(req.metadata?.context).toBeTruthy();
		expect(req.metadata?.rules).toBeTruthy();
		expect(req.metadata?.sessionId).toBeTruthy();

		// Return includes reviewId and receipt
		expect(result.reviewId).toBe(req.reviewId);
		expect(result.receipt.status).toBe("accepted");
	});

	it("registry envelope 应包含 Completion Evidence 和 compliance_verdict rules", async () => {
		const { taskId } = await runtime.start("tdd.md");
		recordTrustedVerification(collector, { command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "Done" });

		const envelope = reviewDeps.registry.get(result.reviewId);
		expect(envelope).toBeDefined();
		const env = envelope as NonNullable<typeof envelope>;
		expect(env.context).toContain("compliance-task");
		expect(env.context).toContain("completion_claim");
		expect(env.rules).toContain("compliance_verdict");
		const persisted = await store.readAll(taskId);
		const requested = persisted.find((record) => record.event === "completion_requested") as
			| ((typeof persisted)[number] & { reviewEnvelope?: { reviewId: string } })
			| undefined;
		expect(requested?.reviewEnvelope?.reviewId).toBe(result.reviewId);
	});

	it("宿主 accepted 解决前状态保持 completion_requested", async () => {
		let resolveReceipt: ((receipt: AdvisorReviewReceipt) => void) | undefined;
		reviewDeps.requestAdvisorReview = (request) =>
			new Promise((resolve) => {
				resolveReceipt = (receipt) => resolve({ ...receipt, reviewId: request.reviewId });
			});
		await runtime.start("tdd.md");
		const pending = runtime.requestCompletion({ summary: "Done" });
		await Bun.sleep(10);
		expect(runtime.currentTaskState?.status).toBe("completion_requested");
		resolveReceipt?.({ status: "accepted", reviewId: "ignored" });
		await pending;
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("completion_requested 阶段拒绝提前 Verdict 且不写 completed Evidence", async () => {
		let resolveReceipt: ((receipt: AdvisorReviewReceipt) => void) | undefined;
		reviewDeps.requestAdvisorReview = (request) =>
			new Promise((resolve) => {
				resolveReceipt = (receipt) => resolve({ ...receipt, reviewId: request.reviewId });
			});
		const { taskId } = await runtime.start("tdd.md");
		const pending = runtime.requestCompletion({ summary: "Done" });
		await Bun.sleep(10);

		const result = await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));
		const evidence = await store.readAll(taskId);

		expect(result.accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("completion_requested");
		expect(evidence.some((record) => record.event === "completed")).toBe(false);

		resolveReceipt?.({ status: "accepted", reviewId: "ignored" });
		await pending;
	});

	it("rejected receipt 应写 advisor_unavailable Evidence 并进入 stalled", async () => {
		await runtime.start("tdd.md");
		recordTrustedVerification(collector, { command: "bun test", exitCode: 0 });

		// Replace requestAdvisorReview to throw
		const rejectSpy = () => Promise.reject(new Error("Advisor pool exhausted"));
		reviewDeps.requestAdvisorReview = rejectSpy;

		const result = await runtime.requestCompletion({ summary: "Done" });

		// Fail closed until the scheduler retries.
		expect(result.receipt.status).toBe("rejected");
		expect(result.receipt.reason).toContain("Advisor pool exhausted");

		expect(runtime.currentTaskState).toBeDefined();
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;
		expect(state.status).toBe("stalled");
	});
});

describe("ComplianceRuntime — lifecycle 与严格 Verdict 绑定", () => {
	it("宿主完成但没有 Verdict 时进入 stalled", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const reviewId = runtime.currentTaskState?.activeReviewId;
		if (!reviewId) throw new Error("missing review id");
		await runtime.handleAdvisorLifecycle({
			type: "advisor_run_completed",
			reviewId,
			trigger: "compliance_review",
			priority: 100,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: "2026-07-18T00:00:00.000Z",
			verdictSubmitted: false,
		});
		expect(runtime.currentTaskState?.status).toBe("stalled");
	});

	it("拒绝跨项目 Verdict", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		verdict.project_id = "another-project";
		const result = await runtime.acceptVerdict(verdict);
		expect(result.accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("拒绝同 reviewId 的冲突重复 Verdict", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const first = advisorVerdict(runtime, {
			status: "remediate",
			findings: [finding("f1", "fix", "first")],
		});
		expect((await runtime.acceptVerdict(first)).accepted).toBe(true);
		const conflict = { ...first, findings: [finding("f2", "different", "second")] };
		const second = await runtime.acceptVerdict(conflict);
		expect(second.accepted).toBe(false);
		expect(second.reason).toContain("Conflicting verdict");
	});

	it("pass 前 Git diff 漂移会被拒绝", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		writeFileSync(join(tmpDir, "changed.ts"), "export const changed = true;\n");
		const result = await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));
		expect(result.accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("Git 重算失败不消费 Verdict，恢复后同一 Verdict 可成功", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const changedPath = join(tmpDir, "changed.ts");
		writeFileSync(changedPath, "export const changed = true;\n");

		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");

		unlinkSync(changedPath);
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("Envelope 权威查询失败不消费 Verdict，恢复后同一 Verdict 可成功", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const original = store.readAll.bind(store);
		let unavailable = true;
		store.readAll = async (taskId) => (unavailable ? [] : original(taskId));

		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");

		unavailable = false;
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("completed Evidence 写入失败时不得进入 completed", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const original = store.append.bind(store);
		store.append = async (record) => {
			if (record.event === "completed") throw new Error("evidence disk full");
			await original(record);
		};

		await expect(runtime.acceptVerdict(verdict)).rejects.toThrow("evidence disk full");
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		store.append = original;
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("缺任一严格 Verdict 字段均拒绝", async () => {
		const fields = ["review_id", "project_id", "evidence_revision", "git_head", "diff_hash", "trigger"] as const;
		for (const field of fields) {
			await runtime.start("tdd.md");
			await runtime.requestCompletion({ summary: "Done" });
			const verdict = advisorVerdict(runtime, { status: "pass" });
			delete verdict[field];
			expect((await runtime.acceptVerdict(verdict)).accepted).toBe(false);
			await runtime.stop();
		}
	});

	it("缺严格 provider 时拒绝 Completion Gate", async () => {
		expect(() => new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {} as never)).toThrow(
			/strict|authoritative/i,
		);
	});
});

// ─── Tests: Accept Verdict (Pass) ───────────────────────────────────

describe("ComplianceRuntime — acceptVerdict (pass)", () => {
	it("should transition to completed on pass verdict", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));

		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("should write completed evidence record", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));

		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "completed")).toBe(true);
	});

	it("should not inject remediation message on pass", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;
		await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));

		// No new messages should be sent for pass verdict
		expect(api.sentMessages.length).toBe(beforeCount);
	});
});

// ─── Tests: Accept Verdict (Remediation) ────────────────────────────

describe("ComplianceRuntime — acceptVerdict (remediation)", () => {
	it("remediate 自动回送 required_fix，并允许无限次再次完成", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "第一次" });

		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				status: "remediate",
				findings: [finding("f1", "Needs more testing", "补测试")],
			}),
		);

		// Status should be remediation_required
		expect(runtime.currentTaskState?.status).toBe("remediation_required");

		// The injectRemediation should have sent a message with the required fix
		const hasFixMessage = api.sentMessages.some((m) => {
			if (m && typeof m === "object" && "details" in m) {
				const data = (m as Record<string, unknown>).details as Record<string, unknown>;
				return (
					Array.isArray(data?.findings) &&
					(data.findings as Array<{ requiredFix: string }>).some(
						(f: { requiredFix: string }) => f.requiredFix === "补测试",
					)
				);
			}
			return false;
		});
		expect(hasFixMessage).toBe(true);

		// resumeAfterRemediation should return "active"
		const status = runtime.resumeAfterRemediation();
		expect(status).toBe("active");
	});

	it("should not inject remediation when requiredFixes is empty", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;

		// remediate verdict with empty findings → parseVerdict rejects it (schema requires
		// at least one finding with required_fix for remediate status) → stays in
		// advisor_reviewing, no injection
		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				status: "remediate",
				findings: [],
			}),
		);

		// No new messages for schema-rejected verdict
		expect(api.sentMessages.length).toBe(beforeCount);
	});

	it("should not inject when verdict schema is invalid", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;

		// Build a verdict with mismatched contract_hash → parseVerdict rejects context binding
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;
		await runtime.acceptVerdict({
			schema_version: 1,
			task_id: state.taskId,
			// Wrong hash — doesn't match the runtime's contractHash
			contract_hash: "sha256:mismatched-hash",
			attempt: state.attempt,
			status: "pass",
			findings: [],
		});

		// No injection for invalid schema — stays in advisor_reviewing
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		expect(api.sentMessages.length).toBe(beforeCount);
	});

	it("should write remediation evidence on remediation verdict", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				status: "remediate",
				findings: [finding("f1", "Fix issues", "fix foo"), finding("f2", "Fix more", "fix bar")],
			}),
		);

		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "remediation_required")).toBe(true);
	});

	it("should handle unknown verdict status as protocol error", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		// Build a schema-valid verdict shape but with unknown status
		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				// @ts-expect-error testing invalid status
				status: "unknown_status",
			}),
		);

		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});
});

// ─── Tests: resumeAfterRemediation ──────────────────────────────────

describe("ComplianceRuntime — resumeAfterRemediation", () => {
	it("should throw when no task is active", () => {
		expect(() => runtime.resumeAfterRemediation()).toThrow("No active compliance task");
	});

	it("should throw when task is not remediation_required", async () => {
		await runtime.start("tdd.md");
		expect(() => runtime.resumeAfterRemediation()).toThrow("Cannot resume from status");
	});

	it("should increment attempt on resume", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				status: "remediate",
				findings: [finding("f1", "Fix it", "fix it")],
			}),
		);

		const attemptBefore = runtime.currentTaskState?.attempt;
		runtime.resumeAfterRemediation();
		expect(runtime.currentTaskState?.attempt).toBe(attemptBefore + 1);
	});
});
