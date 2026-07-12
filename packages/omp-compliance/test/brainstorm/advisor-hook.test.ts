import { describe, expect, it } from "bun:test";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import type { BrainstormReviewEnvelope } from "../../src/brainstorm/review-registry";
import type { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { BRAINSTORM_READ_ONLY_TOOL_NAMES, isCodebaseReadOnlyName } from "../../src/brainstorm/advisor-rules";
import type { AdvisorBeforeRunEvent } from "../../src/types";

function makeEnvelope(overrides: Partial<BrainstormReviewEnvelope> = {}): BrainstormReviewEnvelope {
	return Object.freeze({
		reviewId: "review-bs-1",
		topicId: "topic-01",
		inputHash: "sha256:abc" as const,
		context: "test-brainstorm-context",
		rules: "test-brainstorm-rules",
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	});
}

function makeCoordinator(): TopicCoordinator {
	// Minimal mock — not a real TopicCoordinator
	return {
		load: () => null,
		// @ts-expect-error -- just for hook shape
		acceptReview: () => Promise.resolve(),
	} as unknown as TopicCoordinator;
}

function brainstormEvent(overrides: Partial<AdvisorBeforeRunEvent> = {}): AdvisorBeforeRunEvent {
	return {
		type: "advisor_before_run",
		sessionId: "session-1",
		advisorId: "default",
		trigger: "brainstorm_review",
		messages: [],
		metadata: { reviewId: "review-bs-1" },
		...overrides,
	};
}

describe("createBrainstormAdvisorHook", () => {
	it("injects topic rules, brainstorm_review tool and read-only tool names only for its trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const coordinator = makeCoordinator();
		const env = makeEnvelope();
		registry.put(env);

		const hook = createBrainstormAdvisorHook(registry, coordinator);
		const result = hook(brainstormEvent());

		expect(result).toBeDefined();
		expect(result?.additionalSystemContext).toHaveLength(2);
		expect(result?.additionalTools?.map((t) => t.name)).toEqual(["brainstorm_review"]);
		expect(result?.additionalToolNames?.every((n) => isCodebaseReadOnlyName(n))).toBe(true);
	});

	it("returns undefined for compliance_review trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const coordinator = makeCoordinator();
		const env = makeEnvelope();
		registry.put(env);

		const hook = createBrainstormAdvisorHook(registry, coordinator);
		const result = hook({ ...brainstormEvent(), trigger: "compliance_review" });
		expect(result).toBeUndefined();
	});

	it("returns undefined when no envelope matches metadata", () => {
		const registry = new BrainstormReviewRegistry();
		const coordinator = makeCoordinator();

		const hook = createBrainstormAdvisorHook(registry, coordinator);
		const result = hook(brainstormEvent({ metadata: { reviewId: "nonexistent" } }));
		expect(result).toBeUndefined();
	});
});
