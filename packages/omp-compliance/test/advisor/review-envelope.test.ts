import { beforeEach, describe, expect, it } from "bun:test";
import { createEnvelope } from "../../src/advisor/review-envelope";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { ComplianceReviewEnvelope } from "../../src/advisor/review-envelope";

const HASH = "sha256:abc123def456" as const;
const DEFAULT_INPUTS = {
	sessionId: "session-1",
	taskId: "task-9",
	projectId: "123e4567-e89b-42d3-a456-426614174000",
	contractHash: HASH,
	evidenceRevision: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
	gitHead: "c".repeat(40),
	diffHash: `sha256:${"d".repeat(64)}` as `sha256:${string}`,
	trigger: "compliance_review",
	attempt: 1,
	context: "evidence-context",
	rules: "compliance-rules",
} as const;

// ─── createEnvelope ────────────────────────────────────────────────

describe("createEnvelope", () => {
	it("creates a stable reviewId from session/task/hash/attempt", () => {
		const env = createEnvelope(DEFAULT_INPUTS);
		expect(env.reviewId).toMatch(/^compliance:[a-f0-9]{64}$/);

		// Same inputs → same reviewId
		const env2 = createEnvelope(DEFAULT_INPUTS);
		expect(env2.reviewId).toBe(env.reviewId);
	});

	it("includes all input fields on the envelope", () => {
		const env = createEnvelope(DEFAULT_INPUTS);
		expect(env.sessionId).toBe("session-1");
		expect(env.taskId).toBe("task-9");
		expect(env.contractHash).toBe(HASH);
		expect(env.attempt).toBe(1);
		expect(env.context).toBe("evidence-context");
		expect(env.rules).toBe("compliance-rules");
	});

	it("sets createdAt as a non-empty ISO string", () => {
		const env = createEnvelope(DEFAULT_INPUTS);
		expect(env.createdAt).toBeTruthy();
		expect(() => new Date(env.createdAt)).not.toThrow();
	});

	it("produces different reviewId when inputs differ", () => {
		const env1 = createEnvelope(DEFAULT_INPUTS);
		const env2 = createEnvelope({ ...DEFAULT_INPUTS, sessionId: "session-2" });
		expect(env1.reviewId).not.toBe(env2.reviewId);
	});

	it("returns a frozen object", () => {
		const env = createEnvelope(DEFAULT_INPUTS);
		expect(Object.isFrozen(env)).toBe(true);
	});
});

// ─── ComplianceReviewRegistry ──────────────────────────────────────

describe("ComplianceReviewRegistry", () => {
	let registry: ComplianceReviewRegistry;
	let env: ComplianceReviewEnvelope;

	beforeEach(() => {
		registry = new ComplianceReviewRegistry();
		env = createEnvelope(DEFAULT_INPUTS);
	});

	it("put/get works", () => {
		registry.put(env);
		expect(registry.get(env.reviewId)).toBe(env);
	});

	it("consume returns the envelope and removes it", () => {
		registry.put(env);
		expect(registry.consume(env.reviewId)).toBe(env);
		expect(registry.get(env.reviewId)).toBeUndefined();
	});

	it("consume can only be called once", () => {
		registry.put(env);
		registry.consume(env.reviewId);
		expect(registry.get(env.reviewId)).toBeUndefined();
		expect(registry.consume(env.reviewId)).toBeUndefined();
	});

	it("get returns undefined for unknown id", () => {
		expect(registry.get("compliance:nonexistent")).toBeUndefined();
	});

	it("consume returns undefined for unknown id", () => {
		expect(registry.consume("compliance:nonexistent")).toBeUndefined();
	});

	it("handles multiple envelopes independently", () => {
		const envA = createEnvelope({ ...DEFAULT_INPUTS, sessionId: "a" });
		const envB = createEnvelope({ ...DEFAULT_INPUTS, sessionId: "b" });
		registry.put(envA);
		registry.put(envB);
		expect(registry.consume(envA.reviewId)).toBe(envA);
		expect(registry.get(envB.reviewId)).toBe(envB); // B still there
	});
});
