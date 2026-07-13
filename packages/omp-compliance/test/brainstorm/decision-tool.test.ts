/**
 * Tests for decision-tool — brainstorm_decision tool validation
 * and registration pattern.
 *
 * The brainstorm_decision tool is called by the main agent after
 * the user has made an explicit choice. It requires user_confirmed: true
 * to proceed — advisor 'support' alone cannot automatically decide.
 */

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	validateDecisionInput,
	createDecisionTool,
} from "../../src/brainstorm/decision-tool";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import { validTopicInput, fullCodebaseSnapshot, validReview } from "./fixtures";

// ─── Helpers ─────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `br-dt-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Create a TopicCoordinator with a topic in awaiting_user_decision state.
 * Uses only public APIs to establish state.
 */
async function fixtureCoordinatorWithReview(): Promise<TopicCoordinator> {
	const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
	const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	await coordinator.markReviewRequested(topic.topicId, "review-1");
	await coordinator.acceptReview(validReview(topic));
	return coordinator;
}

// ─── validateDecisionInput ───────────────────────────────────────────

describe("validateDecisionInput", () => {
	it("accepts valid input with user_confirmed true", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_candidate",
			user_confirmed: true,
		});
		expect(errors).toHaveLength(0);
	});

	it("accepts accept_alternative with selected_alternative", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_alternative",
			selected_alternative: "扁平架构",
			user_confirmed: true,
		});
		expect(errors).toHaveLength(0);
	});

	it("rejects missing topic_id", () => {
		const errors = validateDecisionInput({
			decision: "accept_candidate",
			user_confirmed: true,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("topic_id");
	});

	it("rejects missing decision", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			user_confirmed: true,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("decision");
	});

	it("rejects invalid decision value", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "invalid_value",
			user_confirmed: true,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("decision");
	});

	it("rejects missing user_confirmed", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_candidate",
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("user_confirmed");
	});

	it("rejects user_confirmed false", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_candidate",
			user_confirmed: false,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("user_confirmed");
	});

	it("rejects accept_alternative without selected_alternative", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_alternative",
			user_confirmed: true,
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("selected_alternative");
	});

	it("rejects rationale over 4000 characters", () => {
		const errors = validateDecisionInput({
			topic_id: "topic-01",
			decision: "accept_candidate",
			user_confirmed: true,
			rationale: "x".repeat(4001),
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("rationale");
	});
});

// ─── createDecisionTool ─────────────────────────────────────────────

describe("createDecisionTool", () => {
	it("creates a tool definition with the correct name", () => {
		const coordinator = {} as TopicCoordinator;
		const tool = createDecisionTool({ coordinator });
		expect(tool.name).toBe("brainstorm_decision");
		expect(tool.description).toBeTruthy();
	});

	it("creates a tool definition with parameters schema", () => {
		const coordinator = {} as TopicCoordinator;
		const tool = createDecisionTool({ coordinator });
		expect(tool.parameters).toBeTruthy();
		expect(typeof tool.parameters === "object").toBe(true);
	});

	it("rejects user_confirmed false even with valid decision", async () => {
		const coordinator = {} as TopicCoordinator;
		const tool = createDecisionTool({ coordinator });
		const result = await (tool.handler as (params: Record<string, unknown>) => Promise<unknown>)({
			topic_id: "topic-01",
			decision: "accept_candidate",
			user_confirmed: false,
			rationale: "test",
		});
		const r = result as Record<string, unknown>;
		expect(r.ok).toBe(false);
		expect(Array.isArray(r.errors)).toBe(true);
	});

	it("records only an explicit user decision and cannot decide from advisor support", async () => {
		const coordinator = await fixtureCoordinatorWithReview();
		const tool = createDecisionTool({ coordinator });

		// user_confirmed: false should be rejected
		const rejected = await (tool.handler as (params: Record<string, unknown>) => Promise<unknown>)({
			topic_id: coordinator.current()!.topicId,
			decision: "accept_candidate",
			user_confirmed: false,
			rationale: "should fail",
		});
		const rej = rejected as Record<string, unknown>;
		expect(rej.ok).toBe(false);

		// user_confirmed: true should succeed
		const accepted = await (tool.handler as (params: Record<string, unknown>) => Promise<unknown>)({
			topic_id: coordinator.current()!.topicId,
			decision: "accept_candidate",
			user_confirmed: true,
			rationale: "采用官方 Hook，保持核心改动最小",
		});
		const acc = accepted as Record<string, unknown>;
		expect(acc.ok).toBe(true);
		expect(coordinator.current()?.status).toBe("decided");
	});

	it("records an alternative decision when selected", async () => {
		const coordinator = await fixtureCoordinatorWithReview();
		const tool = createDecisionTool({ coordinator });

		const result = await (tool.handler as (params: Record<string, unknown>) => Promise<unknown>)({
			topic_id: coordinator.current()!.topicId,
			decision: "accept_alternative",
			selected_alternative: "扁平架构",
			user_confirmed: true,
			rationale: "更适合小团队",
		});
		const r = result as Record<string, unknown>;
		expect(r.ok).toBe(true);
		expect(coordinator.current()?.status).toBe("decided");
		expect(coordinator.current()?.decision?.selected_alternative).toBe("扁平架构");
	});

	it("parks a topic when park decision is made", async () => {
		const coordinator = await fixtureCoordinatorWithReview();
		const tool = createDecisionTool({ coordinator });

		const result = await (tool.handler as (params: Record<string, unknown>) => Promise<unknown>)({
			topic_id: coordinator.current()!.topicId,
			decision: "park",
			user_confirmed: true,
			rationale: "依赖项未准备好",
		});
		const r = result as Record<string, unknown>;
		expect(r.ok).toBe(true);
		expect(coordinator.current()?.status).toBe("parked");
	});
});
