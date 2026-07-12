/**
 * Tests for Brainstorm TopicCoordinator — state machine, dedup, decisions.
 *
 * Uses real temporary directories for each test group to isolate
 * file-system state. All tests are deterministic.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { TopicStore } from "../../src/brainstorm/topic-store";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import type {
	BrainstormDecision,
	BrainstormReview,
	BrainstormTopicState,
} from "../../src/brainstorm/types";
import {
	validTopicInput,
	makeTopicState,
	fullCodebaseSnapshot,
	emptyEvidenceSnapshot,
	validReview,
} from "./fixtures";

// ─── Helpers ─────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `coord-test-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function fixtureCoordinator(): TopicCoordinator {
	return new TopicCoordinator(new TopicStore(tempDir()));
}

// ─── Suite ───────────────────────────────────────────────────────────

describe("TopicCoordinator", () => {
	// ── Submit / Dedup ──────────────────────────────────────────────

	it("creates a new topic on first submit", async () => {
		const coordinator = fixtureCoordinator();
		const result = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());

		expect(result.kind).toBe("created");
		if (result.kind === "created") {
			expect(result.topic.status).toBe("ready_for_advisor_review");
			expect(result.topic.attempt).toBe(1);
		}
	});

	it("keeps one active topic and reuses a review for an identical fingerprint", async () => {
		const coordinator = fixtureCoordinator();
		const first = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		const duplicate = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());

		expect(first.kind).toBe("created");
		expect(duplicate).toEqual({ kind: "reused", topic: first.topic });
	});

	it("returns conflict when another topic is already waiting for review", async () => {
		const coordinator = fixtureCoordinator();
		const first = await coordinator.submit(validTopicInput({ title: "first" }), fullCodebaseSnapshot());
		// Manually set to advisor_reviewing to simulate pending
		await coordinator.markReviewRequested(first.topic.topicId, "review-1");

		const second = await coordinator.submit(
			validTopicInput({ title: "second", candidate_decision: "different decision" }),
			fullCodebaseSnapshot(),
		);
		expect(second.kind).toBe("conflict");
	});

	it("allows a new topic when the active topic is already decided", async () => {
		const coordinator = fixtureCoordinator();
		const first = await coordinator.submit(validTopicInput({ title: "first" }), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(first.topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(first.topic));
		await coordinator.recordDecision(first.topic.topicId, {
			topic_id: first.topic.topicId,
			decision: "accept_candidate",
			ts: new Date().toISOString(),
		});

		const second = await coordinator.submit(
			validTopicInput({ title: "second", candidate_decision: "different" }),
			fullCodebaseSnapshot(),
		);

		expect(second.kind).toBe("created");
	});

	it("keeps brainstorm state free of compliance completion fields", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));

		const current = coordinator.current();
		expect(current?.status).toBe("awaiting_user_decision");
		expect(current).not.toHaveProperty("taskId");
		expect(current).not.toHaveProperty("contractHash");
	});

	// ── State Transitions ───────────────────────────────────────────

	it("transitions through the full happy path lifecycle", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		expect(topic.status).toBe("ready_for_advisor_review");

		await coordinator.markReviewRequested(topic.topicId, "review-1");
		expect(coordinator.current()?.status).toBe("advisor_reviewing");

		await coordinator.acceptReview(validReview(topic));
		expect(coordinator.current()?.status).toBe("awaiting_user_decision");

		await coordinator.recordDecision(topic.topicId, {
			topic_id: topic.topicId,
			decision: "accept_candidate",
			ts: new Date().toISOString(),
		});
		expect(coordinator.current()?.status).toBe("decided");
	});

	it("transitions to review_unavailable on markReviewUnavailable", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.markReviewUnavailable(topic.topicId, "Advisor model not configured");

		expect(coordinator.current()?.status).toBe("review_unavailable");
	});

	it("allows retry from review_unavailable -> awaiting_user_decision", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.markReviewUnavailable(topic.topicId, "timeout");
		await coordinator.acceptReview(validReview(topic));

		expect(coordinator.current()?.status).toBe("awaiting_user_decision");
	});

	it("rejects invalid transitions (decided -> review_requested)", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));
		await coordinator.recordDecision(topic.topicId, {
			topic_id: topic.topicId,
			decision: "accept_candidate",
			ts: new Date().toISOString(),
		});

		// Attempting to request a review on a decided topic should throw
		expect(coordinator.current()?.status).toBe("decided");
		await expect(coordinator.markReviewRequested(topic.topicId, "review-2")).rejects.toThrow(/cannot transition|decided/i);
	});

	// ── Decision Recording ──────────────────────────────────────────

	it("records accept_candidate decision", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));

		const decision: BrainstormDecision = {
			topic_id: topic.topicId,
			decision: "accept_candidate",
			rationale: "方案通过，无重大风险",
			ts: new Date().toISOString(),
		};
		await coordinator.recordDecision(topic.topicId, decision);

		expect(coordinator.current()?.status).toBe("decided");
		expect(coordinator.current()?.decision?.decision).toBe("accept_candidate");
		expect(coordinator.current()?.decision?.rationale).toBe("方案通过，无重大风险");
	});

	it("records accept_alternative decision with selected alternative", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));

		await coordinator.recordDecision(topic.topicId, {
			topic_id: topic.topicId,
			decision: "accept_alternative",
			selected_alternative: "方案 B",
			rationale: "Advisor 认为 B 更具扩展性",
			ts: new Date().toISOString(),
		});

		expect(coordinator.current()?.status).toBe("decided");
		expect(coordinator.current()?.decision?.selected_alternative).toBe("方案 B");
	});

	it("records park decision", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));

		await coordinator.recordDecision(topic.topicId, {
			topic_id: topic.topicId,
			decision: "park",
			rationale: "依赖项未就绪",
			ts: new Date().toISOString(),
		});

		expect(coordinator.current()?.status).toBe("parked");
	});

	it("records reopen decision (returns to drafting)", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");
		await coordinator.acceptReview(validReview(topic));

		await coordinator.recordDecision(topic.topicId, {
			topic_id: topic.topicId,
			decision: "reopen",
			rationale: "需要补充约束条件",
			ts: new Date().toISOString(),
		});

		expect(coordinator.current()?.status).toBe("drafting");
		expect(coordinator.current()?.attempt).toBe(2);
	});

	// ── Recovery ────────────────────────────────────────────────────

	it("recovers current topic from disk after coordinator recreation", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const coordinator = new TopicCoordinator(store);
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());

		// Re-create coordinator with same store (simulating process restart)
		const coordinator2 = new TopicCoordinator(new TopicStore(dir));
		const recovered = coordinator2.current();
		expect(recovered).not.toBeNull();
		expect(recovered!.topicId).toBe(topic.topicId);
		expect(recovered!.status).toBe("ready_for_advisor_review");
	});

	// ── Read-only Queries ───────────────────────────────────────────

	it("returns null current() when no topic has been submitted", () => {
		const coordinator = fixtureCoordinator();
		expect(coordinator.current()).toBeNull();
	});

	it("returns topic history via getTopicEvents()", async () => {
		const coordinator = fixtureCoordinator();
		const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
		await coordinator.markReviewRequested(topic.topicId, "review-1");

		const events = await coordinator.getTopicEvents(topic.topicId);
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events.map(e => e.event)).toEqual(["topic_created", "review_requested"]);
	});
});
