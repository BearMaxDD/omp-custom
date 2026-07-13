import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { ComplianceReviewDependencies } from "../../src/advisor/review-envelope";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { buildCompletionSnapshot } from "../../src/runtime/completion-gate";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import type { AdvisorReviewReceipt, AdvisorReviewRequest, ExtensionAPI } from "../../src/types";

// ─── Minimal Fake API for runtime tests ─────────────────────────────

class MinimalAPI implements ExtensionAPI {
	public sentMessages: unknown[] = [];
	public entries: Array<{ type: string; data?: unknown }> = [];

	registerTool(): void {}
	requestAdvisorReview = (_request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> =>
		Promise.resolve({ reviewId: "test-review", status: "accepted" });
	on(): void {}

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
		task_id: state.taskId,
		contract_hash: state.contractHash,
		attempt: state.attempt,
		status: opts.status,
		findings: opts.findings ?? [],
	};
}

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

	const evidenceDir = join(tmpDir, ".omp", "evidence");
	api = new MinimalAPI();
	store = new EvidenceStore(evidenceDir);
	collector = new CollectorRuntime();
	mockRequestReviewReturn = { reviewId: "test-review", status: "accepted" };
	mockRequestReviewCalls = [];
	reviewDeps = {
		sessionId: () => "test-session",
		registry: new ComplianceReviewRegistry(),
		requestAdvisorReview: (req: AdvisorReviewRequest) => {
			mockRequestReviewCalls.push(req);
			return Promise.resolve(mockRequestReviewReturn);
		},
	};
	runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, reviewDeps);
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
		runtime.recordVerification({ command: "bun test", exitCode: 0 });
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
	it("应调用 requestAdvisorReview 并正确设置 trigger/metadata", async () => {
		await runtime.start("tdd.md");
		runtime.recordVerification({ command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "Done" });

		// One call to requestAdvisorReview
		expect(mockRequestReviewCalls.length).toBe(1);
		const req = mockRequestReviewCalls[0];
		expect(req.trigger).toBe("compliance_review");
		expect(req.reviewId).toMatch(/^compliance:/);

		// Metadata binds task/hash/attempt
		expect(req.metadata?.taskId).toBe(result.completionSnapshot.taskId);
		expect(req.metadata?.contractHash).toMatch(/^sha256:/);
		expect(req.metadata?.attempt).toBe(1);

		// Return includes reviewId and receipt
		expect(result.reviewId).toBe(req.reviewId);
		expect(result.receipt.status).toBe("accepted");
	});

	it("registry envelope 应包含 Completion Evidence 和 compliance_verdict rules", async () => {
		await runtime.start("tdd.md");
		runtime.recordVerification({ command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "Done" });

		const envelope = reviewDeps.registry.get(result.reviewId);
		expect(envelope).toBeDefined();
		const env = envelope as NonNullable<typeof envelope>;
		expect(env.context).toContain("compliance-task");
		expect(env.context).toContain("completion_claim");
		expect(env.rules).toContain("compliance_verdict");
	});

	it("rejected receipt 应写 advisor_unavailable Evidence 并保持 advisor_reviewing", async () => {
		await runtime.start("tdd.md");
		runtime.recordVerification({ command: "bun test", exitCode: 0 });

		// Replace requestAdvisorReview to throw
		const rejectSpy = () => Promise.reject(new Error("Advisor pool exhausted"));
		reviewDeps.requestAdvisorReview = rejectSpy;

		const result = await runtime.requestCompletion({ summary: "Done" });

		// Status stays advisor_reviewing
		expect(result.receipt.status).toBe("rejected");
		expect(result.receipt.reason).toContain("Advisor pool exhausted");

		expect(runtime.currentTaskState).toBeDefined();
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;
		expect(state.status).toBe("advisor_reviewing");
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
			if (m && typeof m === "object" && "data" in m) {
				const data = (m as Record<string, unknown>).data as Record<string, unknown>;
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
