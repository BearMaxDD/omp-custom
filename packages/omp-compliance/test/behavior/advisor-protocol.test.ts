/**
 * Advisor verdict protocol tests.
 *
 * Verifies that verdicts travel through the full parseVerdict →
 * acceptVerdict pipeline and produce correct state transitions.
 *
 * Tests cover:
 *   - Verdict schema validation (pass/fail)
 *   - Verdict context binding (task_id, contract_hash, attempt)
 *   - Idempotency (duplicate verdicts are rejected)
 *   - Stale attempt detection
 *   - Post-pass lock (remediate after pass is rejected)
 *   - Sink persistence and hasPassed()
 *   - Protocol error handling
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import { VerdictValidationError, parseVerdict } from "../../src/advisor/verdict-schema";
import type { VerdictContext } from "../../src/advisor/verdict-schema";
import { acceptVerdict, hasPassed } from "../../src/advisor/verdict-sink";
import type { VerdictStore } from "../../src/advisor/verdict-sink";
import type { SHA256Hash } from "../../src/contract/types";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import type { ExtensionAPI } from "../../src/types";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "../../src/types";
import { FakeAdvisor } from "../support/fake-advisor";

// ─── Test Helper Types ──────────────────────────────────────────────

interface ProtocolFixture {
	runtime: ComplianceRuntime;
	api: MinimalTestAPI;
	advisor: FakeAdvisor;
}

// ─── Minimal API ─────────────────────────────────────────────────────

class MinimalTestAPI implements ExtensionAPI {
	public sentMessages: unknown[] = [];

	registerTool(): void {}
	registerCommand(): void {}
	on(): void {}
	sendMessage(m: unknown): void {
		this.sentMessages.push(m);
	}
	appendEntry(): void {}
	requestAdvisorReview = (_request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> =>
		Promise.resolve({ reviewId: "test-review", status: "accepted" });
	logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const DEFAULT_HASH: SHA256Hash = "sha256:abc123def456" as SHA256Hash;

const defaultContext: VerdictContext = {
	taskId: "protocol-test",
	contractHash: DEFAULT_HASH,
	attempt: 1,
};

function freshStore(): VerdictStore {
	return { records: [], lastPass: {}, acceptedKeys: new Set() };
}

function setupRuntimeFixture(): ProtocolFixture {
	const tmpDir = join(tmpdir(), `omp-protocol-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(tmpDir, { recursive: true });

	writeFileSync(
		join(tmpDir, "tdd.md"),
		[
			"# 目标: Protocol compliance test",
			"",
			"## 范围",
			"- verify verdict protocol",
			"",
			"## 文件",
			"- test/protocol.ts",
			"",
			"## 测试",
			"- protocol unit",
			"",
			"## 验证",
			"- bun test",
			"",
			"## 完成条件",
			"- all passing",
			"",
		].join("\n"),
		"utf-8",
	);

	const evidenceDir = join(tmpDir, ".omp", "evidence");
	mkdirSync(evidenceDir, { recursive: true });

	const api = new MinimalTestAPI();
	const store = new EvidenceStore(evidenceDir);
	const collector = new CollectorRuntime();
	const registry = new ComplianceReviewRegistry();
	const runtime = new ComplianceRuntime(() => store, collector, api, tmpDir, {
		sessionId: () => "test-session",
		registry,
		requestAdvisorReview: (_req) => Promise.resolve({ reviewId: "test-review", status: "accepted" }),
	});
	const advisor = new FakeAdvisor();

	return { runtime, api, advisor };
}

// ─── Tests: Verdict Schema ──────────────────────────────────────────

describe("Verdict schema validation", () => {
	it("valid pass verdict parses successfully", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		const parsed = parseVerdict(verdict, {
			taskId: "my-task",
			contractHash: DEFAULT_HASH,
			attempt: 1,
		});

		expect(parsed.status).toBe("pass");
		expect(parsed.schema_version).toBe(1);
	});

	it("valid remediate verdict with required_fix parses successfully", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [
				{
					id: "f1",
					reason: "Tests missing",
					required_fix: "Write tests",
				},
			],
		};

		const parsed = parseVerdict(verdict, {
			taskId: "my-task",
			contractHash: DEFAULT_HASH,
			attempt: 1,
		});

		expect(parsed.status).toBe("remediate");
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0].required_fix).toBe("Write tests");
	});

	it("remediate verdict without required_fix rejects", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [
				{
					id: "f1",
					reason: "Tests missing",
					// missing required_fix
				},
			],
		};

		expect(() =>
			parseVerdict(verdict, {
				taskId: "my-task",
				contractHash: DEFAULT_HASH,
				attempt: 1,
			}),
		).toThrow(VerdictValidationError);
	});

	it("mismatched task_id in context rejects", () => {
		const verdict = {
			schema_version: 1,
			task_id: "task-a",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		expect(() =>
			parseVerdict(verdict, {
				taskId: "task-b", // mismatched
				contractHash: DEFAULT_HASH,
				attempt: 1,
			}),
		).toThrow(VerdictValidationError);
	});

	it("mismatched contract_hash in context rejects", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: "sha256:abc",
			attempt: 1,
			status: "pass",
			findings: [],
		};

		expect(() =>
			parseVerdict(verdict, {
				taskId: "my-task",
				contractHash: "sha256:xyz" as SHA256Hash, // mismatched
				attempt: 1,
			}),
		).toThrow(VerdictValidationError);
	});

	it("mismatched attempt in context rejects", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: DEFAULT_HASH,
			attempt: 2, // mismatched with context
			status: "pass",
			findings: [],
		};

		expect(() =>
			parseVerdict(verdict, {
				taskId: "my-task",
				contractHash: DEFAULT_HASH,
				attempt: 1,
			}),
		).toThrow(VerdictValidationError);
	});

	it("unknown status value rejects", () => {
		const verdict = {
			schema_version: 1,
			task_id: "my-task",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "unknown_status",
			findings: [],
		};

		expect(() =>
			parseVerdict(verdict, {
				taskId: "my-task",
				contractHash: DEFAULT_HASH,
				attempt: 1,
			}),
		).toThrow(VerdictValidationError);
	});
});

// ─── Tests: Verdict Sink Protocol ────────────────────────────────────

describe("Verdict sink — acceptVerdict protocol rules", () => {
	it("accepts a valid pass verdict through the sink", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		const result = acceptVerdict(verdict, defaultContext, store);

		expect(result.status).toBe("accepted");
		expect(store.records).toHaveLength(1);
	});

	it("accepts a valid remediate verdict through the sink", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [{ id: "f1", reason: "Fix it", required_fix: "Do the fix" }],
		};

		const result = acceptVerdict(verdict, defaultContext, store);

		expect(result.status).toBe("accepted");
		expect(store.records).toHaveLength(1);
	});

	it("rejects invalid verdict schema through the sink", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			// Missing findings entirely — schema requires findings array
		};

		const result = acceptVerdict(verdict, defaultContext, store);

		expect(result.status).toBe("rejected");
		expect(result.protocolError).toBe(true);
	});

	it("rejects idempotent duplicate verdict", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		const first = acceptVerdict(verdict, defaultContext, store);
		expect(first.status).toBe("accepted");

		const second = acceptVerdict(verdict, defaultContext, store);
		expect(second.status).toBe("rejected");
		expect(second.reason).toContain("already processed");
	});

	it("rejects stale attempt (attempt < last pass attempt)", () => {
		const store = freshStore();
		const passVerdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 3,
			status: "pass",
			findings: [],
		};

		acceptVerdict(passVerdict, { ...defaultContext, attempt: 3 }, store);

		// Stale verdict with attempt 1 (less than last pass at 3)
		const staleVerdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		const result = acceptVerdict(staleVerdict, { ...defaultContext, attempt: 1 }, store);

		expect(result.status).toBe("rejected");
		expect(result.protocolError).toBe(true);
		// Message mentions "Stale" — check lowercase for reliability
		expect(result.reason?.toLowerCase()).toContain("stale");
	});

	it("rejects remediate after pass (post-pass lock)", () => {
		const store = freshStore();
		const passVerdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		acceptVerdict(passVerdict, defaultContext, store);

		// Attempt remediate after pass at same attempt
		const remediateVerdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [{ id: "f1", reason: "Fix", required_fix: "The fix" }],
		};

		const result = acceptVerdict(remediateVerdict, defaultContext, store);

		expect(result.status).toBe("rejected");
		expect(result.protocolError).toBe(true);
		expect(result.reason).toContain("pass");
	});

	it("allows remediate after remediate (no pass yet)", () => {
		const store = freshStore();
		const r1 = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [{ id: "f1", reason: "Fix 1", required_fix: "Do fix 1" }],
		};

		acceptVerdict(r1, defaultContext, store);
		expect(store.records).toHaveLength(1);

		// Second remediate at attempt 2 (different key, allowed)
		const r2 = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 2,
			status: "remediate",
			findings: [{ id: "f2", reason: "Fix 2", required_fix: "Do fix 2" }],
		};

		const result = acceptVerdict(r2, { ...defaultContext, attempt: 2 }, store);
		expect(result.status).toBe("accepted");
		expect(store.records).toHaveLength(2);
	});
});

// ─── Tests: Sink hasPassed() ─────────────────────────────────────────

describe("hasPassed — pass state tracking", () => {
	it("returns false when no verdict has been accepted", () => {
		const store = freshStore();
		expect(hasPassed("protocol-test", DEFAULT_HASH, store)).toBe(false);
	});

	it("returns true after a pass verdict has been accepted", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		acceptVerdict(verdict, defaultContext, store);
		expect(hasPassed("protocol-test", DEFAULT_HASH, store)).toBe(true);
	});

	it("returns false after only remediate verdicts", () => {
		const store = freshStore();
		const verdict = {
			schema_version: 1,
			task_id: "protocol-test",
			contract_hash: DEFAULT_HASH,
			attempt: 1,
			status: "remediate",
			findings: [{ id: "f1", reason: "Fix", required_fix: "The fix" }],
		};

		acceptVerdict(verdict, defaultContext, store);
		expect(hasPassed("protocol-test", DEFAULT_HASH, store)).toBe(false);
	});

	it("is isolated per (taskId, contractHash) pair", () => {
		const store = freshStore();
		const hashA = "sha256:aaa" as SHA256Hash;
		const hashB = "sha256:bbb" as SHA256Hash;

		acceptVerdict(
			{
				schema_version: 1,
				task_id: "task-A",
				contract_hash: hashA,
				attempt: 1,
				status: "pass",
				findings: [],
			},
			{ taskId: "task-A", contractHash: hashA, attempt: 1 },
			store,
		);

		expect(hasPassed("task-A", hashA, store)).toBe(true);
		expect(hasPassed("task-A", hashB, store)).toBe(false);
		expect(hasPassed("task-B", hashA, store)).toBe(false);
	});
});

// ─── Tests: Full Protocol Through Runtime ────────────────────────────

describe("Verdict protocol through ComplianceRuntime", () => {
	it("schema-invalid verdict transitions to protocol_error state", async () => {
		const { runtime } = setupRuntimeFixture();

		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		// Missing required fields — parseVerdict will reject
		await runtime.acceptVerdict({
			schema_version: 1,
			// Missing task_id, contract_hash, attempt, status, findings
		});

		// After protocol error, stay in advisor_reviewing
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("mismatched attempt in verdict transitions to protocol_error", async () => {
		const { runtime } = setupRuntimeFixture();

		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		const state = runtime.currentTaskState as NonNullable<typeof runtime.currentTaskState>;

		// Build verdict with wrong attempt (attempt=0, but runtime uses attempt=1)
		await runtime.acceptVerdict({
			schema_version: 1,
			task_id: state.taskId,
			contract_hash: state.contractHash,
			attempt: 0, // mismatched — actual attempt is 1
			status: "pass",
			findings: [],
		});

		// After protocol error, stay in advisor_reviewing — verdict not accepted
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("valid pass verdict transitions to completed", async () => {
		const { runtime, advisor } = setupRuntimeFixture();

		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const ctx = FakeAdvisor.contextFromRuntime(runtime);
		const passVerdict = advisor.passVerdict(ctx);

		await runtime.acceptVerdict(passVerdict);

		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("valid remediate verdict transitions to remediation_required", async () => {
		const { runtime, advisor } = setupRuntimeFixture();

		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const ctx = FakeAdvisor.contextFromRuntime(runtime);
		const remediateVerdict = advisor.remediateVerdict(ctx, [
			{
				id: "fix-1",
				reason: "Needs work",
				requiredFix: "Do the work",
			},
		]);

		await runtime.acceptVerdict(remediateVerdict);

		expect(runtime.currentTaskState?.status).toBe("remediation_required");
	});

	it("FakeAdvisor produces verdicts that pass parseVerdict validation", () => {
		const advisor = new FakeAdvisor();
		const context: VerdictContext = {
			taskId: "validate-me",
			contractHash: "sha256:verify-hash" as SHA256Hash,
			attempt: 1,
		};

		const passV = advisor.passVerdict(context);
		const parsed = parseVerdict(passV, context);
		expect(parsed.status).toBe("pass");

		const remediateV = advisor.remediateVerdict(context, [{ id: "f1", reason: "Issue", requiredFix: "Fix it" }]);
		const parsedR = parseVerdict(remediateV, context);
		expect(parsedR.status).toBe("remediate");
		expect(parsedR.findings[0].required_fix).toBe("Fix it");
	});

	it("pass verdict after remediate transitions to completed correctly", async () => {
		const { runtime, advisor } = setupRuntimeFixture();

		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Round 1" });

		// Remediate
		const ctx1 = FakeAdvisor.contextFromRuntime(runtime);
		await runtime.acceptVerdict(
			advisor.remediateVerdict(ctx1, [{ id: "f1", reason: "Fix needed", requiredFix: "Apply fix" }]),
		);

		expect(runtime.currentTaskState?.status).toBe("remediation_required");

		// Resume and re-complete
		runtime.resumeAfterRemediation();

		await runtime.requestCompletion({ summary: "Round 2" });

		// Pass
		const ctx2 = FakeAdvisor.contextFromRuntime(runtime);
		await runtime.acceptVerdict(advisor.passVerdict(ctx2, "Fixed all issues"));

		expect(runtime.currentTaskState?.status).toBe("completed");
	});
});
