import { describe, expect, it } from "bun:test";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BRAINSTORM_READ_ONLY_TOOL_NAMES, isCodebaseReadOnlyName } from "../../src/brainstorm/advisor-rules";
import { renderDecisionCard } from "../../src/brainstorm/decision-card";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import type { BrainstormReviewEnvelope } from "../../src/brainstorm/review-registry";
import { BrainstormReviewError } from "../../src/brainstorm/review-schema";
import type { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import type { BrainstormTopicState } from "../../src/brainstorm/types";
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

/**
 * A valid BrainstormReview-like params object that passes
 * parseBrainstormReview against the default envelope.
 */
const validReviewParams: Record<string, unknown> = Object.freeze({
	schema_version: 1,
	topic_id: "topic-01",
	input_hash: "sha256:abc",
	status: "support",
	summary: "The proposed architecture is sound and well-reasoned.",
	findings: [{ category: "risk", statement: "Migration complexity is moderate", impact: "medium" }],
	alternatives: [
		{
			name: "Incremental rollout",
			description: "Phase the migration over several sprints",
			tradeoffs: ["Longer timeline", "Lower risk per deployment"],
			when_to_choose: "When team capacity is constrained",
		},
	],
	recommendation: "Proceed with event-driven design",
	confidence: "high",
});

/**
 * A minimal BrainstormTopicState the coordinator's current() can return
 * after a successful acceptReview. Matches the envelope identity fields.
 */
const defaultTopic: BrainstormTopicState = Object.freeze({
	topicId: "topic-01",
	inputHash: "sha256:abc",
	status: "awaiting_user_decision",
	attempt: 1,
	input: Object.freeze({
		topic_kind: "architecture",
		title: "Adopt event-driven architecture",
		candidate_decision: "Migrate to event-driven architecture",
		constraints: [],
		success_criteria: [],
		codebase_relevance: "none",
		discussion_summary: "",
	}),
	review: {
		schema_version: 1,
		topic_id: "topic-01",
		input_hash: "sha256:abc",
		status: "support",
		summary: "The proposed architecture is sound",
		findings: [],
		alternatives: [],
		recommendation: "Proceed with event-driven design",
		confidence: "high",
	},
});

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

describe("brainstorm_review tool — sendMessage", () => {
	it("calls sendMessage with correct shape on successful review", async () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);

		const messages: Array<[unknown, unknown]> = [];
		const sendMessage = (msg: unknown, opts?: unknown): void => {
			messages.push([msg, opts]);
		};

		const coordinator = {
			acceptReview: async () => {},
			current: () => defaultTopic,
		} as unknown as TopicCoordinator;

		const hook = createBrainstormAdvisorHook(registry, coordinator, sendMessage);
		const result = hook(brainstormEvent());
		expect(result).toBeDefined();
		const tool = result!.additionalTools![0];

		await tool.execute("tool-call-1", validReviewParams);

		expect(messages).toHaveLength(1);
		const [msg, options] = messages[0] as [
			{ customType: string; content: string; display: boolean; attribution: string; details?: unknown },
			{ deliverAs?: string; triggerTurn?: boolean } | undefined,
		];

		expect(msg.customType).toBe("brainstorm_review");
		expect(msg.display).toBe(true);
		expect(msg.attribution).toBe("agent");
		expect(msg.details).toEqual({
			topicId: "topic-01",
			review: expect.objectContaining({
				schema_version: 1,
				topic_id: "topic-01",
				input_hash: "sha256:abc",
				status: "support",
			}),
		});
		expect(msg.content).toBe(renderDecisionCard(defaultTopic));
		expect(options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
	});

	it("does not call sendMessage on parse failure (invalid status)", async () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);

		const messages: Array<[unknown, unknown]> = [];
		const sendMessage = (msg: unknown, opts?: unknown): void => {
			messages.push([msg, opts]);
		};

		const hook = createBrainstormAdvisorHook(registry, makeCoordinator(), sendMessage);
		const result = hook(brainstormEvent());
		expect(result).toBeDefined();
		const tool = result!.additionalTools![0];

		const badParams = { ...validReviewParams, status: "pass" };
		await expect(tool.execute("tool-call-2", badParams)).rejects.toThrow(BrainstormReviewError);
		expect(messages).toHaveLength(0);
	});

	it("does not call sendMessage on identity mismatch (wrong topic_id)", async () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);

		const messages: Array<[unknown, unknown]> = [];
		const sendMessage = (msg: unknown, opts?: unknown): void => {
			messages.push([msg, opts]);
		};

		const hook = createBrainstormAdvisorHook(registry, makeCoordinator(), sendMessage);
		const result = hook(brainstormEvent());
		expect(result).toBeDefined();
		const tool = result!.additionalTools![0];

		const badParams = { ...validReviewParams, topic_id: "wrong-topic" };
		await expect(tool.execute("tool-call-3", badParams)).rejects.toThrow(BrainstormReviewError);
		expect(messages).toHaveLength(0);
	});

	it("does NOT call sendMessage on acceptReview rejection and keeps envelope", async () => {
		const registry = new BrainstormReviewRegistry();
		const env = makeEnvelope();
		registry.put(env);

		const messages: Array<[unknown, unknown]> = [];
		const sendMessage = (msg: unknown, opts?: unknown): void => {
			messages.push([msg, opts]);
		};

		const coordinator = {
			acceptReview: async () => {
				throw new Error('Cannot accept review: cannot transition from "decided"');
			},
			current: () => null,
		} as unknown as TopicCoordinator;

		const hook = createBrainstormAdvisorHook(registry, coordinator, sendMessage);
		const result = hook(brainstormEvent());
		expect(result).toBeDefined();
		const tool = result!.additionalTools![0];

		await expect(tool.execute("tool-call-reject", validReviewParams)).rejects.toThrow(
			'Cannot accept review: cannot transition from "decided"',
		);

		expect(messages).toHaveLength(0);
		expect(registry.get(env.reviewId)).toBe(env);
	});
});
