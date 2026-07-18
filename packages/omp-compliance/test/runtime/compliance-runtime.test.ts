import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { ComplianceReviewDependencies } from "../../src/advisor/review-envelope";
import { createReviewEnvelope } from "../../src/contracts/review-envelope";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { buildCompletionSnapshot } from "../../src/runtime/completion-gate";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import type {
	ComplianceRuntimeDependencies,
	ComplianceRuntimePersistenceSnapshot,
} from "../../src/runtime/compliance-runtime";
import type { ReviewSchedulerState, ReviewSchedulerStore } from "../../src/scheduler/review-scheduler";
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

class ControllableSchedulerStore implements ReviewSchedulerStore {
	state: ReviewSchedulerState | undefined;
	failWhen: ((state: ReviewSchedulerState) => boolean) | undefined;
	async load(): Promise<ReviewSchedulerState | undefined> {
		return this.state ? structuredClone(this.state) : undefined;
	}
	async save(state: ReviewSchedulerState): Promise<void> {
		if (this.failWhen?.(state)) throw new Error("scheduler disk down");
		this.state = structuredClone(state);
	}
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
let runtimeDependencies: ComplianceRuntimeDependencies;
let envelopeOverride:
	| ((taskId: string, reviewId: string) => ReturnType<ComplianceRuntimeDependencies["readEnvelope"]>)
	| undefined;
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
			advisorPayloadHash: `sha256:${"e".repeat(64)}`,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
		await Bun.sleep(5);
	}
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
	runtimeDependencies = createStrictRuntimeDependencies({
		repoRoot: tmpDir,
		store,
		requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
	});
	const authoritativeEnvelope = runtimeDependencies.readEnvelope;
	envelopeOverride = undefined;
	runtimeDependencies = {
		...runtimeDependencies,
		readEnvelope: (taskId, reviewId) =>
			envelopeOverride ? envelopeOverride(taskId, reviewId) : authoritativeEnvelope(taskId, reviewId),
	};
	runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
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

	it("stalled 任务也不能通过再次 start 重置失败状态", async () => {
		await runtime.start("tdd.md");
		await runtime.stallForInfrastructure("disk down");
		expect(runtime.currentTaskState?.status).toBe("stalled");
		await expect(runtime.start("tdd.md")).rejects.toThrow("already active");
		expect(runtime.currentTaskState?.status).toBe("stalled");
	});

	it("并发 start 只允许一个调用建立 active 任务", async () => {
		const results = await Promise.allSettled([runtime.start("tdd.md"), runtime.start("tdd.md")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const taskId = runtime.currentTaskState?.taskId;
		if (!taskId) throw new Error("missing active task");
		const evidence = await store.readAll(taskId);
		expect(evidence.filter((record) => record.event === "active")).toHaveLength(1);
	});

	it("首次状态落盘失败时不提交 active Evidence 或启动消息", async () => {
		let persistAttempts = 0;
		const dependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const failingRuntime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...dependencies,
			persistRuntimeState: () => {
				persistAttempts += 1;
				if (persistAttempts === 1) throw new Error("state disk unavailable");
			},
		});

		await expect(failingRuntime.start("tdd.md")).rejects.toThrow("state disk unavailable");
		expect(failingRuntime.currentTaskState).toBeNull();
		expect(api.sentMessages).toHaveLength(0);
		const taskId = dependencies.strictEvidence().taskContract.taskId;
		expect((await store.readAll(taskId)).filter((record) => record.event === "active")).toHaveLength(0);

		await failingRuntime.start("tdd.md");
		expect((await store.readAll(taskId)).filter((record) => record.event === "active")).toHaveLength(1);
	});

	it("active Evidence 写入失败时补偿已落盘状态并允许干净重试", async () => {
		let failActiveEvidence = true;
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		const failingStore = new EvidenceStore(join(tmpDir, ".omp", "failing-active-evidence"));
		const append = failingStore.append.bind(failingStore);
		failingStore.append = async (record) => {
			if (record.event === "active" && failActiveEvidence) {
				failActiveEvidence = false;
				throw new Error("active evidence disk unavailable");
			}
			await append(record);
		};
		const dependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store: failingStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const failingRuntime = new ComplianceRuntime(() => failingStore, collector, api, tmpDir, reviewDeps, {
			...dependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});

		await expect(failingRuntime.start("tdd.md")).rejects.toThrow("active evidence disk unavailable");
		expect(failingRuntime.currentTaskState).toBeNull();
		expect(persisted?.taskState).toBeNull();
		expect(api.sentMessages).toHaveLength(0);

		const result = await failingRuntime.start("tdd.md");
		expect(result.status).toBe("active");
		expect(persisted?.taskState?.status).toBe("active");
		expect((await failingStore.readAll(result.taskId)).filter((record) => record.event === "active")).toHaveLength(1);
	});
});

describe("ComplianceRuntime — persisted recovery", () => {
	it("state 写盘失败后从 Scheduler 和 Evidence 恢复孤立 Completion Review", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let durableSnapshot: ComplianceRuntimePersistenceSnapshot | undefined;
		let stateWrites = 0;
		let reviewRequests = 0;
		const firstDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: async (request) => {
				reviewRequests += 1;
				return { status: "accepted", reviewId: request.reviewId };
			},
		});
		const firstRuntime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...firstDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				stateWrites += 1;
				if (stateWrites > 1) throw new Error("state disk full");
				durableSnapshot = structuredClone(snapshot);
			},
		});
		await firstRuntime.start("tdd.md");
		await expect(firstRuntime.requestCompletion({ summary: "Done" })).rejects.toThrow("state disk full");
		if (!durableSnapshot) throw new Error("active state was not persisted");
		expect(durableSnapshot.taskState?.status).toBe("active");

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: async (request) => {
				reviewRequests += 1;
				return { status: "accepted", reviewId: request.reviewId };
			},
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		await recoveredDependencies.scheduler.restore();
		await recovered.restorePersistedState(firstDependencies.strictEvidence().taskContract, durableSnapshot);
		await recovered.retryDueReviews();

		expect(reviewRequests).toBe(2);
		expect(recovered.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("重启后将 Scheduler 回收的 in-flight Completion Review 自动重新提交", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		let reviewRequests = 0;
		const firstDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: async (request) => {
				reviewRequests += 1;
				return { status: "accepted", reviewId: request.reviewId };
			},
		});
		const firstRuntime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...firstDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});
		await firstRuntime.start("tdd.md");
		expect((await firstRuntime.requestCompletion({ summary: "Done" })).status).toBe("advisor_reviewing");
		if (!persisted) throw new Error("runtime state was not persisted");

		const secondDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: async (request) => {
				reviewRequests += 1;
				return { status: "accepted", reviewId: request.reviewId };
			},
		});
		const recoveredRuntime = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			secondDependencies,
		);
		await secondDependencies.scheduler.restore();
		const originalAdvisorEnvelope = reviewDeps.registry.get(String(persisted.activeEnvelope?.reviewId));
		if (!originalAdvisorEnvelope) throw new Error("authoritative Advisor Envelope was not registered");
		const tamperedSnapshot = {
			...persisted,
			advisorEnvelope: { ...originalAdvisorEnvelope, context: "UNTRUSTED STATE INJECTION" },
		} as unknown as ComplianceRuntimePersistenceSnapshot;
		await recoveredRuntime.restorePersistedState(firstDependencies.strictEvidence().taskContract, tamperedSnapshot);
		expect(reviewDeps.registry.get(String(persisted.activeEnvelope?.reviewId))?.context).not.toContain(
			"UNTRUSTED STATE INJECTION",
		);
		await recoveredRuntime.retryDueReviews();

		expect(reviewRequests).toBe(2);
		expect(recoveredRuntime.currentTaskState?.status).toBe("advisor_reviewing");
		expect(recoveredRuntime.currentTaskState?.activeReviewId).not.toBe(persisted.activeEnvelope?.reviewId);
	});

	it("拒绝恢复与严格信封摘要不一致的 Advisor 上下文", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		const firstDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const firstRuntime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...firstDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});
		await firstRuntime.start("tdd.md");
		await firstRuntime.requestCompletion({ summary: "Done" });
		if (!persisted?.activeEnvelope || !persisted.taskState?.activeReviewId) {
			throw new Error("active review was not persisted");
		}
		const originalAdvisor = reviewDeps.registry.get(persisted.taskState.activeReviewId);
		if (!originalAdvisor) throw new Error("Advisor Envelope was not registered");

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(() => store, new CollectorRuntime(), api, tmpDir, reviewDeps, {
			...recoveredDependencies,
			readAdvisorEnvelope: async () => ({ ...originalAdvisor, context: "UNTRUSTED EVIDENCE INJECTION" }),
		});
		await recoveredDependencies.scheduler.restore();

		await expect(
			recovered.restorePersistedState(firstDependencies.strictEvidence().taskContract, persisted),
		).rejects.toThrow("Persisted compliance Review Envelope mismatch");
	});

	it("session 恢复会续提 remediate journal 并重新下发修复任务", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		const firstDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const firstRuntime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...firstDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});
		const { taskId } = await firstRuntime.start("tdd.md");
		await firstRuntime.requestCompletion({ summary: "Done" });
		if (!persisted?.taskState?.activeReviewId || !persisted.activeEnvelope) {
			throw new Error("advisor reviewing state was not persisted");
		}
		await store.append({
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			taskId,
			contractPath: "tdd.md",
			contractHash: persisted.taskState.contractHash,
			attempt: persisted.taskState.attempt,
			event: "verdict_commit_prepared",
			signalDigest: persisted.activeEnvelope.reviewId,
			commitRecovery: {
				reviewEnvelope: persisted.activeEnvelope,
				status: "remediate",
				summary: "需要补充恢复验证",
				requiredFixes: ["补充崩溃恢复测试"],
			},
		} as never);
		await firstDependencies.scheduler.handleLifecycle(
			{
				type: "advisor_run_completed",
				reviewId: persisted.activeEnvelope.reviewId,
				trigger: "compliance_review",
				priority: 100,
				primarySessionId: "primary",
				advisorSessionId: "advisor",
				timestamp: new Date().toISOString(),
				verdictSubmitted: true,
			},
			false,
		);

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		await recoveredDependencies.scheduler.restore();
		const messagesBeforeRecovery = api.sentMessages.length;
		await recovered.restorePersistedState(firstDependencies.strictEvidence().taskContract, persisted);

		expect(recovered.currentTaskState?.status).toBe("remediation_required");
		expect((await store.readAll(taskId)).some((record) => record.event === "remediation_required")).toBe(true);
		expect(api.sentMessages.length).toBe(messagesBeforeRecovery + 1);
		expect(JSON.stringify(api.sentMessages.at(-1))).toContain("补充崩溃恢复测试");
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
	it("关键 Evidence 持久化失败后可将活动任务置为 stalled", async () => {
		await runtime.start("tdd.md");
		const state = await runtime.stallForInfrastructure("Evidence persistence failed");

		expect(state?.status).toBe("stalled");
		expect(runtime.currentTaskState).toMatchObject({
			status: "stalled",
			error: "Evidence persistence failed",
		});
	});

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
	it("Envelope 持久化失败时进入 stalled 且不入队", async () => {
		await runtime.start("tdd.md");
		const original = store.append.bind(store);
		store.append = async (record) => {
			if (record.event === "completion_requested") throw new Error("disk down");
			await original(record);
		};
		await expect(runtime.requestCompletion({ summary: "Done" })).rejects.toThrow("disk down");
		expect(runtime.currentTaskState?.status).toBe("stalled");
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
		await waitUntil(() => resolveReceipt !== undefined);
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
		await waitUntil(() => resolveReceipt !== undefined);

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
	it("重试在 Host requester 运行前持久化并注册新的 Envelope", async () => {
		let now = Date.now();
		let firstRequest = true;
		let retryObserved = false;
		reviewDeps.requestAdvisorReview = async (request) => {
			if (firstRequest) {
				firstRequest = false;
				throw new Error("temporary unavailable");
			}
			const taskId = String(request.metadata?.taskId);
			const records = await store.readAll(taskId);
			expect(records.some((record) => record.event === "completion_retry" && record.signalDigest)).toBe(true);
			expect(reviewDeps.registry.get(request.reviewId)).toBeDefined();
			const hook = createComplianceAdvisorHook(reviewDeps.registry, runtime);
			const augmentation = hook({
				type: "advisor_before_run",
				reviewId: request.reviewId,
				trigger: "compliance_review",
				priority: 100,
				metadata: request.metadata,
				primarySessionId: "primary",
				advisorSessionId: "advisor",
			});
			expect(request.metadata?.attempt).toBe(1);
			expect(request.metadata?.reviewAttempt).toBe(2);
			expect(augmentation?.additionalTools?.[0]?.name).toBe("compliance_verdict");
			retryObserved = true;
			return { status: "accepted", reviewId: request.reviewId };
		};
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			now: () => now,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);

		await runtime.start("tdd.md");
		const initial = await runtime.requestCompletion({ summary: "Done" });
		expect(initial.status).toBe("stalled");
		now += 5_000;
		await runtime.retryDueReviews();

		expect(retryObserved).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("retry Scheduler 落盘失败后回到 stalled 并可再次重试", async () => {
		let now = Date.now();
		let reject = true;
		const schedulerStore = new ControllableSchedulerStore();
		reviewDeps.requestAdvisorReview = async (request) => {
			if (reject) throw new Error("temporary unavailable");
			return { status: "accepted", reviewId: request.reviewId };
		};
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			now: () => now,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
		await runtime.start("tdd.md");
		expect((await runtime.requestCompletion({ summary: "Done" })).status).toBe("stalled");

		reject = false;
		now += 5_000;
		schedulerStore.failWhen = (state) => state.inFlight?.attempt === 2;
		await runtime.retryDueReviews();
		expect(runtime.currentTaskState?.status).toBe("stalled");

		schedulerStore.failWhen = undefined;
		await runtime.retryDueReviews();
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("resume 必须等待进行中的 retry 事务并拒绝分裂状态", async () => {
		let now = Date.now();
		let reject = true;
		reviewDeps.requestAdvisorReview = async (request) => {
			if (reject) throw new Error("temporary unavailable");
			return { status: "accepted", reviewId: request.reviewId };
		};
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			now: () => now,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
		const { taskId } = await runtime.start("tdd.md");
		expect((await runtime.requestCompletion({ summary: "Done" })).status).toBe("stalled");

		let releaseRetryEvidence: (() => void) | undefined;
		const retryEvidenceGate = new Promise<void>((resolve) => {
			releaseRetryEvidence = resolve;
		});
		const originalAppend = store.append.bind(store);
		store.append = async (record) => {
			if (record.event === "completion_retry") await retryEvidenceGate;
			await originalAppend(record);
		};
		reject = false;
		now += 5_000;
		const retrying = runtime.retryDueReviews();
		await Bun.sleep(10);
		const resuming = runtime.resume(taskId);
		await Bun.sleep(10);
		expect(runtime.currentTaskState?.status).toBe("stalled");

		releaseRetryEvidence?.();
		await retrying;
		await expect(resuming).rejects.toThrow("not stalled");
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		expect(runtimeDependencies.scheduler.snapshot().inFlight?.reviewId).toBe(runtime.currentTaskState?.activeReviewId);
	});

	it("Verdict 与失败 lifecycle 并发时保持单一 completed 终态", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const reviewId = String(runtime.currentTaskState?.activeReviewId);
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const persistedEnvelope = await runtimeDependencies.readEnvelope(
			String(runtime.currentTaskState?.taskId),
			reviewId,
		);
		if (!persistedEnvelope) throw new Error("missing persisted envelope");
		let releaseEnvelope: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseEnvelope = resolve;
		});
		envelopeOverride = async () => {
			await gate;
			return persistedEnvelope;
		};
		const accepting = runtime.acceptVerdict(verdict);
		await Bun.sleep(10);
		const lifecycle = runtime.handleAdvisorLifecycle({
			type: "advisor_run_failed",
			reviewId,
			trigger: "compliance_review",
			priority: 100,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: new Date().toISOString(),
			failureClass: "provider",
			errorSummary: "late failure",
		});
		releaseEnvelope?.();
		expect((await accepting).accepted).toBe(true);
		await lifecycle;
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("Verdict 提交期间人工 override 必须排队且不能制造矛盾终态", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const persistedEnvelope = await runtimeDependencies.readEnvelope(
			String(runtime.currentTaskState?.taskId),
			String(runtime.currentTaskState?.activeReviewId),
		);
		if (!persistedEnvelope) throw new Error("missing persisted envelope");
		let releaseEnvelope: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseEnvelope = resolve;
		});
		envelopeOverride = async () => {
			await gate;
			return persistedEnvelope;
		};

		const accepting = runtime.acceptVerdict(verdict);
		await Bun.sleep(10);
		const overriding = runtime.overrideCompletion("manual exception");
		await Bun.sleep(10);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		releaseEnvelope?.();

		expect((await accepting).accepted).toBe(true);
		expect((await overriding).status).toBe("completed");
		expect(runtime.currentTaskState?.status).toBe("completed");
		const evidence = await store.readAll(taskId);
		expect(evidence.filter((record) => record.event === "completed")).toHaveLength(1);
	});

	it("Completion 等待 Host receipt 时 stop 必须排队到事务结束", async () => {
		let resolveReceipt: ((receipt: AdvisorReviewReceipt) => void) | undefined;
		reviewDeps.requestAdvisorReview = (request) =>
			new Promise((resolve) => {
				resolveReceipt = (receipt) => resolve({ ...receipt, reviewId: request.reviewId });
			});
		const { taskId } = await runtime.start("tdd.md");
		const completion = runtime.requestCompletion({ summary: "Done" });
		await waitUntil(() => resolveReceipt !== undefined);
		const stopping = runtime.stop();
		await Bun.sleep(10);
		expect(runtime.currentTaskState?.status).toBe("completion_requested");

		resolveReceipt?.({ status: "accepted", reviewId: "ignored" });
		await completion;
		expect((await stopping).stopped).toBe(true);
		expect(runtime.currentTaskState).toBeNull();
		const evidence = await store.readAll(taskId);
		expect(evidence.some((record) => record.event === "stopped")).toBe(true);
	});

	it("并发 completion 请求只持久化一个权威 Envelope", async () => {
		const { taskId } = await runtime.start("tdd.md");
		const first = runtime.requestCompletion({ summary: "first" });
		const second = runtime.requestCompletion({ summary: "second" });
		await first;
		await expect(second).rejects.toThrow("Cannot request completion");
		const records = await store.readAll(taskId);
		expect(records.filter((record) => record.event === "completion_requested")).toHaveLength(1);
	});

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

	it("Envelope 内容被篡改时即使沿用 reviewId 与 envelopeHash 也拒绝", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const verdict = advisorVerdict(runtime, { status: "pass" });
		const original = runtimeDependencies.readEnvelope;
		const persisted = await original(
			String(runtime.currentTaskState?.taskId),
			String(runtime.currentTaskState?.activeReviewId),
		);
		if (!persisted) throw new Error("missing persisted envelope");
		const tampered = { ...persisted, projectId: "tampered-project" };
		envelopeOverride = async () => tampered;
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(false);
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		envelopeOverride = undefined;
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(true);
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
		expect(runtimeDependencies.scheduler.snapshot().inFlight?.reviewId).toBe(runtime.currentTaskState?.activeReviewId);
		store.append = original;
		expect((await runtime.acceptVerdict(verdict)).accepted).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("并发冲突 Verdict 只允许一个提交并只写一条终态 Evidence", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const first = advisorVerdict(runtime, { status: "pass" });
		const second = { ...first, findings: [finding("conflict", "different")] };
		const [left, right] = await Promise.all([runtime.acceptVerdict(first), runtime.acceptVerdict(second)]);
		expect([left.accepted, right.accepted].filter(Boolean)).toHaveLength(1);
		const evidence = await store.readAll(taskId);
		expect(evidence.filter((record) => record.event === "completed")).toHaveLength(1);
	});

	it("终态后续队列派发失败不反转当前 Verdict 结果", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;
		await runtimeDependencies.scheduler.enqueue({
			trigger: "manual_review",
			priority: 80,
			projectId: state.projectId,
			taskId: state.taskId,
			contractHash: state.contractHash,
			evidenceRevision: state.evidenceRevision,
			gitHead: state.gitHead,
			diffHash: state.diffHash,
			force: true,
		});
		schedulerStore.failWhen = (schedulerState) => schedulerState.inFlight?.trigger === "manual_review";

		const result = await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }));
		expect(result.accepted).toBe(true);
		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("重启时从持久化 journal 恢复 Scheduler 已提交但终态 Evidence 未写入的 Verdict", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;
		const records = (await store.readAll(taskId)) as Array<{
			event: string;
			reviewEnvelope?: ReturnType<typeof createReviewEnvelope>;
		}>;
		const envelope = records.find((record) => record.event === "completion_requested")?.reviewEnvelope;
		if (!envelope) throw new Error("missing completion envelope");
		await store.append({
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			taskId,
			contractPath: "tdd.md",
			contractHash: state.contractHash,
			attempt: state.attempt,
			event: "verdict_commit_prepared",
			signalDigest: envelope.reviewId,
			commitRecovery: { reviewEnvelope: envelope, status: "pass" },
		} as never);
		await runtimeDependencies.scheduler.handleLifecycle(
			{
				type: "advisor_run_completed",
				reviewId: envelope.reviewId,
				trigger: "compliance_review",
				priority: 100,
				primarySessionId: "primary",
				advisorSessionId: "advisor",
				timestamp: new Date().toISOString(),
				verdictSubmitted: true,
			},
			false,
		);

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		const result = await recovered.start("tdd.md");
		expect(result.status).toBe("completed");
		expect(recovered.currentTaskState?.status).toBe("completed");
		const recoveredEvidence = await store.readAll(taskId);
		expect(
			recoveredEvidence.some((record) => record.event === "completed" && record.signalDigest === envelope.reviewId),
		).toBe(true);
	});

	it("后续 completion 已开始时不得复活旧 remediation journal", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		const initialDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...initialDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "first" });
		await runtime.acceptVerdict(
			advisorVerdict(runtime, {
				status: "remediate",
				findings: [finding("round-1", "fix round one", "apply fix")],
			}),
		);
		await runtime.resumeAfterRemediation();
		const second = await runtime.requestCompletion({ summary: "second" });
		if (!persisted?.taskState || persisted.taskState.activeReviewId !== second.reviewId) {
			throw new Error("second-round state was not persisted");
		}
		const oldJournalReviewId = (await store.readAll(persisted.taskState.taskId)).find(
			(record) => record.event === "verdict_commit_prepared",
		)?.signalDigest;

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		await recoveredDependencies.scheduler.restore();
		await recovered.restorePersistedState(initialDependencies.strictEvidence().taskContract, persisted);
		await recovered.retryDueReviews();

		expect(recovered.currentTaskState?.status).toBe("advisor_reviewing");
		expect(recovered.currentTaskState?.activeReviewId).not.toBe(oldJournalReviewId);
		expect(recovered.currentTaskState?.activeReviewId).not.toBe(second.reviewId);
		expect(mockRequestReviewCalls.length).toBe(3);
		const schedulerState = recoveredDependencies.scheduler.snapshot();
		expect(schedulerState.inFlight?.reviewId).toBe(recovered.currentTaskState?.activeReviewId);
	});

	it("工作区 Git 上下文变化后不得恢复旧 pass", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		runtimeDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, runtimeDependencies);
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		expect((await runtime.acceptVerdict(advisorVerdict(runtime, { status: "pass" }))).accepted).toBe(true);

		writeFileSync(join(tmpDir, "runtime-change.ts"), "export const changed = true;\n", "utf-8");
		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		const result = await recovered.start("tdd.md");

		expect(result.status).toBe("active");
		expect(recovered.currentTaskState?.status).toBe("active");
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
		const status = await runtime.resumeAfterRemediation();
		expect(status).toBe("active");
		const secondRound = await runtime.requestCompletion({ summary: "第二次" });
		const request = mockRequestReviewCalls.at(-1);
		if (!request) throw new Error("missing second-round review request");
		expect(request.metadata?.attempt).toBe(2);
		expect(request.metadata?.reviewAttempt).toBe(1);
		const hook = createComplianceAdvisorHook(reviewDeps.registry, runtime);
		expect(
			hook({
				type: "advisor_before_run",
				reviewId: secondRound.reviewId,
				trigger: "compliance_review",
				priority: 100,
				metadata: request.metadata,
				primarySessionId: "primary",
				advisorSessionId: "advisor",
			})?.additionalTools?.[0]?.name,
		).toBe("compliance_verdict");
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
	it("should throw when no task is active", async () => {
		await expect(runtime.resumeAfterRemediation()).rejects.toThrow("No active compliance task");
	});

	it("should throw when task is not remediation_required", async () => {
		await runtime.start("tdd.md");
		await expect(runtime.resumeAfterRemediation()).rejects.toThrow("Cannot resume from status");
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
		await runtime.resumeAfterRemediation();
		expect(runtime.currentTaskState?.attempt).toBe(attemptBefore + 1);
	});

	it("整改修改代码后恢复为无旧 Review 身份的可重启 active 状态", async () => {
		const schedulerStore = new ControllableSchedulerStore();
		let persisted: ComplianceRuntimePersistenceSnapshot | undefined;
		const initialDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const initial = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps, {
			...initialDependencies,
			persistRuntimeState: (_taskId, snapshot) => {
				persisted = structuredClone(snapshot);
			},
		});
		await initial.start("tdd.md");
		await initial.requestCompletion({ summary: "Done" });
		await initial.acceptVerdict(
			advisorVerdict(initial, {
				status: "remediate",
				findings: [finding("f1", "Fix it", "fix it")],
			}),
		);
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "index.ts"), "export const fixed = true;\n", "utf8");
		await initial.resumeAfterRemediation();
		if (!persisted?.taskState) throw new Error("resumed state was not persisted");
		expect(persisted.taskState.status).toBe("active");
		expect(persisted.taskState.activeReviewId).toBeUndefined();
		expect(persisted.activeEnvelope).toBeUndefined();

		const recoveredDependencies = createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			schedulerStore,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		});
		const recovered = new ComplianceRuntime(
			() => store,
			new CollectorRuntime(),
			api,
			tmpDir,
			reviewDeps,
			recoveredDependencies,
		);
		await recoveredDependencies.scheduler.restore();
		await recovered.restorePersistedState(initialDependencies.strictEvidence().taskContract, persisted);
		expect(recovered.currentTaskState?.status).toBe("active");
		expect(recovered.currentTaskState?.activeReviewId).toBeUndefined();
	});
});
