import { describe, expect, it } from "bun:test";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import type { BrainstormReviewEnvelope } from "../../src/brainstorm/review-registry";

function makeEnvelope(overrides: Partial<BrainstormReviewEnvelope> = {}): BrainstormReviewEnvelope {
	return Object.freeze({
		reviewId: "review-1",
		topicId: "topic-01",
		projectId: "project-brainstorm",
		inputHash: "sha256:abc" as const,
		evidenceRevision: "sha256:evidence",
		gitHead: "a".repeat(40),
		diffHash: "sha256:diff",
		trigger: "brainstorm_review",
		context: "test-context",
		rules: "test-rules",
		requestedToolNames: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	});
}

describe("BrainstormReviewRegistry", () => {
	it("put/get/consume lifecycle", () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);
		expect(registry.get("review-1")).toBe(env);
		const consumed = registry.consume("review-1");
		expect(consumed).toBe(env);
		expect(registry.get("review-1")).toBeUndefined();
	});

	it("consume works only once", () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);
		expect(registry.consume("review-1")).toBe(env);
		expect(registry.consume("review-1")).toBeUndefined();
	});

	it("get returns undefined for unknown id", () => {
		const registry = new BrainstormReviewRegistry();
		expect(registry.get("unknown")).toBeUndefined();
	});
});
