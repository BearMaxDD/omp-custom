/**
 * Brainstorm TopicCoordinator — state machine, dedup, review reception,
 * and user decision recording for brainstorm topics.
 *
 * Responsibilities:
 * - Maintain the single active topic (serial processing)
 * - Deduplicate via input fingerprint
 * - Validate state transitions
 * - Log each lifecycle event to the persistent TopicStore
 * - Restore state on process restart
 */

import { randomUUID } from "node:crypto";
import type { EvidenceSnapshot } from "../signals/types";
import type { BrainstormReviewEnvelope } from "./review-registry";
import { computeTopicFingerprint, normalizeTopicInput } from "./topic-fingerprint";
import type { TopicEventRecord, TopicStore } from "./topic-store";
import type { BrainstormDecision, BrainstormReview, BrainstormTopicReadyInput, BrainstormTopicState } from "./types";

// ─── Submit Result ───────────────────────────────────────────────────

/**
 * Result of submitting a topic for review.
 *
 * - "created": a new topic was created and queued for advisor review.
 * - "reused": an identical topic (same fingerprint) already exists and
 *   its current state is returned — no new advisor call is needed.
 * - "conflict": another topic is already waiting for review; the caller
 *   must resolve before submitting a different topic.
 */
export type SubmitTopicResult =
	| { kind: "created"; topic: BrainstormTopicState }
	| { kind: "reused"; topic: BrainstormTopicState }
	| { kind: "conflict"; activeTopicId: string; reason: "another_topic_waiting" };

// ─── State Transition Map ────────────────────────────────────────────

type BrainstormTopicStatus = BrainstormTopicState["status"];

/** Valid state transitions: source -> [allowed targets]. */
const TRANSITIONS: Record<BrainstormTopicStatus, BrainstormTopicStatus[]> = {
	drafting: ["ready_for_advisor_review"],
	ready_for_advisor_review: ["advisor_reviewing", "review_unavailable"],
	advisor_reviewing: ["awaiting_user_decision", "review_unavailable"],
	review_unavailable: ["awaiting_user_decision", "drafting", "ready_for_advisor_review"],
	awaiting_user_decision: ["decided", "parked", "drafting"],
	decided: [],
	parked: [],
};

// ─── TopicCoordinator ────────────────────────────────────────────────

export class TopicCoordinator {
	private store: TopicStore;

	constructor(store: TopicStore) {
		this.store = store;
		// Restore cached state from disk on construction
		this.store.load();
	}

	// ── Lifecycle Entry Points ──────────────────────────────────────

	/**
	 * Submit a brainstorm topic for advisor review.
	 *
	 * If a topic with the same normalized fingerprint already exists,
	 * returns the existing state with kind "reused".
	 * If another topic is currently waiting for review, returns "conflict".
	 * Otherwise, creates a new topic and returns kind "created".
	 */
	async submit(input: BrainstormTopicReadyInput, evidence: EvidenceSnapshot): Promise<SubmitTopicResult> {
		const normalized = normalizeTopicInput(input);
		const inputHash = computeTopicFingerprint(normalized, evidence.codebaseMemory.references);
		const existingTopic = this.store.load();

		// Dedup first: identical fingerprint always reuses, regardless of status
		if (existingTopic && existingTopic.inputHash === inputHash) {
			return { kind: "reused", topic: existingTopic };
		}

		// Conflict: another (different) topic is mid-review — cannot submit a new one
		if (existingTopic && this.isWaitingForReview(existingTopic.status)) {
			return {
				kind: "conflict",
				activeTopicId: existingTopic.topicId,
				reason: "another_topic_waiting",
			};
		}

		// Create new topic
		const topicId = this.generateTopicId();
		const topic: BrainstormTopicState = {
			topicId,
			inputHash,
			status: "ready_for_advisor_review",
			attempt: 1,
			input: normalized,
		};

		await this.store.saveState(topic);
		await this.store.appendEvent(topicId, "topic_created", { attempt: 1 });

		return { kind: "created", topic };
	}

	// ── Review Flow ─────────────────────────────────────────────────

	/**
	 * Mark the topic as being reviewed by the advisor.
	 * Transitions: ready_for_advisor_review -> advisor_reviewing
	 */
	async markReviewRequested(
		topicId: string,
		reviewId: string,
		reviewEnvelope?: BrainstormReviewEnvelope,
	): Promise<void> {
		await this.transition(topicId, "advisor_reviewing", {
			reviewId,
			reviewEnvelope,
		});
		await this.store.appendEvent(topicId, "review_requested", { reviewId });
	}

	/**
	 * Mark a topic as ready for advisor review again.
	 *
	 * Supports two source states:
	 *   drafting -> ready_for_advisor_review (reopen)
	 *   review_unavailable -> ready_for_advisor_review (retry)
	 *
	 * When transitioning from review_unavailable, clears review/decision
	 * and increments the attempt counter.
	 */
	async markReady(topicId: string): Promise<void> {
		const topic = this.getCurrentOrThrow();
		const fromStatus = topic.status;
		if (fromStatus === "review_unavailable") {
			topic.review = undefined;
			topic.decision = undefined;
			topic.attempt += 1;
			topic.status = "ready_for_advisor_review";
			await this.store.saveState(topic);
		} else {
			await this.transition(topicId, "ready_for_advisor_review");
		}
		await this.store.appendEvent(topicId, "topic_created", { attempt: topic.attempt });
	}

	/**
	 * Accept and store the advisor's review.
	 * Transitions: advisor_reviewing -> awaiting_user_decision
	 *              review_unavailable -> awaiting_user_decision (retry)
	 */
	async acceptReview(review: BrainstormReview): Promise<void> {
		await this.prepareReview(review);
		await this.commitPreparedReview(review.topic_id);
	}

	async prepareReview(review: BrainstormReview): Promise<void> {
		const topic = this.getCurrentOrThrow();
		this.assertTopicId(topic, review.topic_id);
		if (topic.status !== "advisor_reviewing") {
			throw new Error(`Cannot prepare review: cannot transition from "${topic.status}"`);
		}
		if (topic.pendingReview) throw new Error("Cannot prepare review: a review journal is already pending");
		topic.pendingReview = review;
		await this.store.saveState(topic);
	}

	async commitPreparedReview(topicId: string): Promise<void> {
		const topic = this.getCurrentOrThrow();
		this.assertTopicId(topic, topicId);
		if (topic.status !== "advisor_reviewing" || !topic.pendingReview) {
			throw new Error("Cannot commit review: no prepared review is active");
		}
		const review = topic.pendingReview;
		topic.status = "awaiting_user_decision";
		topic.review = review;
		topic.pendingReview = undefined;
		await this.store.saveState(topic);
		await this.store.appendEvent(topic.topicId, "review_received", { reviewStatus: review.status });
	}

	async rollbackPreparedReview(topicId: string): Promise<void> {
		const topic = this.getCurrentOrThrow();
		this.assertTopicId(topic, topicId);
		if (topic.status !== "advisor_reviewing") return;
		topic.pendingReview = undefined;
		await this.store.saveState(topic);
	}

	/**
	 * Mark the review as unavailable (advisor error, timeout, no model).
	 * Transitions: advisor_reviewing -> review_unavailable
	 */
	async markReviewUnavailable(topicId: string, reason: string): Promise<void> {
		await this.transition(topicId, "review_unavailable", { reason });
		await this.store.appendEvent(topicId, "review_unavailable", { reason });
	}

	// ── Decision Recording ──────────────────────────────────────────

	/**
	 * Record the user's final decision on a topic.
	 *
	 * Decision outcomes:
	 * - "accept_candidate" -> decided
	 * - "accept_alternative" -> decided
	 * - "park" -> parked
	 * - "reopen" -> drafting (attempt incremented)
	 */
	async recordDecision(topicId: string, decision: BrainstormDecision): Promise<void> {
		const topic = this.getCurrentOrThrow();
		this.assertTopicId(topic, decision.topic_id);

		if (topic.status !== "awaiting_user_decision") {
			throw new Error(`Cannot record decision: topic is "${topic.status}", expected "awaiting_user_decision"`);
		}

		switch (decision.decision) {
			case "accept_candidate":
			case "accept_alternative":
				topic.status = "decided";
				topic.decision = decision;
				await this.store.saveState(topic);
				await this.store.appendEvent(topicId, "decision_recorded", {
					decision: decision.decision,
					selectedAlternative: decision.selected_alternative,
				});
				break;

			case "park":
				topic.status = "parked";
				topic.decision = decision;
				await this.store.saveState(topic);
				await this.store.appendEvent(topicId, "topic_parked", {
					rationale: decision.rationale,
				});
				break;

			case "reopen": {
				topic.status = "drafting";
				topic.attempt += 1;
				// Clear review and decision for the new attempt
				topic.review = undefined;
				topic.decision = undefined;
				await this.store.saveState(topic);
				await this.store.appendEvent(topicId, "topic_reopened", {
					newAttempt: topic.attempt,
					rationale: decision.rationale,
				});
				break;
			}
		}
	}

	// ── Read-only Queries ───────────────────────────────────────────

	/** Get the current topic state, or null if none exists. */
	current(): BrainstormTopicState | null {
		return this.store.load();
	}

	/** Get the event history for a specific topic. */
	async getTopicEvents(topicId: string): Promise<TopicEventRecord[]> {
		return this.store.readEvents(topicId);
	}

	// ── Private Helpers ─────────────────────────────────────────────

	private generateTopicId(): string {
		return `topic-${randomUUID()}`;
	}

	private getCurrentOrThrow(): BrainstormTopicState {
		const topic = this.current();
		if (!topic) throw new Error("No active topic");
		return topic;
	}

	private assertTopicId(topic: BrainstormTopicState, expectedId: string): void {
		if (topic.topicId !== expectedId) {
			throw new Error(`Topic ID mismatch: expected "${topic.topicId}", got "${expectedId}"`);
		}
	}

	/**
	 * Check if a status means the topic is actively waiting for review
	 * — in which case a new submit should return "conflict".
	 */
	private isWaitingForReview(status: BrainstormTopicStatus): boolean {
		return status === "ready_for_advisor_review" || status === "advisor_reviewing" || status === "review_unavailable";
	}

	/**
	 * Transition the current topic to a new status, validating legality.
	 * Logs the transition as an event.
	 */
	private async transition(
		topicId: string,
		target: BrainstormTopicStatus,
		extra: { reviewId?: string; reviewEnvelope?: BrainstormReviewEnvelope; reason?: string } = {},
	): Promise<void> {
		const topic = this.getCurrentOrThrow();
		this.assertTopicId(topic, topicId);

		const allowed = TRANSITIONS[topic.status];
		if (!allowed?.includes(target)) {
			throw new Error(`Cannot transition: from "${topic.status}" to "${target}" is not allowed`);
		}

		topic.status = target;
		if (extra.reviewEnvelope) topic.reviewEnvelope = extra.reviewEnvelope;
		await this.store.saveState(topic);
	}
}
