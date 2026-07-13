/**
 * BrainstormRuntime — orchestrates topic submission, evidence gathering,
 * packet building, envelope registration, and advisor review requests.
 *
 * This is the entry point for the main agent's brainstorm_topic_ready tool.
 * It manages the complete lifecycle of submitting a converged topic to an
 * independent advisor for review.
 */

import { randomUUID } from "node:crypto";
import type { CollectorRuntime } from "../signals/collector-runtime";
import { buildTopicCodebaseEvidence } from "./codebase-evidence";
import { buildTopicPacket, renderTopicPacket } from "./topic-packet";
import type { BrainstormReviewRegistry } from "./review-registry";
import type { TopicCoordinator } from "./topic-coordinator";
import { BRAINSTORM_REVIEW_RULES } from "./advisor-rules";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "../types";
import type { BrainstormTopicReadyInput, BrainstormTopicState } from "./types";

// ─── Configuration ─────────────────────────────────────────────────────

export interface BrainstormRuntimeConfig {
	/** The extension API (used for requestAdvisorReview in production). */
	readonly api: { requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt> };
	/** Tool event collector for evidence snapshots. */
	readonly collector: CollectorRuntime;
	/** Topic coordinator for state management. */
	readonly coordinator: TopicCoordinator;
	/** Registry for review envelopes. */
	readonly registry: BrainstormReviewRegistry;
	/** Adapter for requesting an advisor review (injectable for tests). */
	readonly requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	/** Get all currently registered tool names. */
	readonly getAllTools: () => readonly string[];
	/** Get the current session ID. */
	readonly sessionId: () => string;
}

// ─── Submit Topic Result ───────────────────────────────────────────────

export interface BrainstormSubmitTopicResult {
	/** The review ID, set only when a new advisor review was requested. */
	readonly reviewId?: string;
	/** The topic state after submission. */
	readonly topic: BrainstormTopicState;
	/**
	 * The outcome status:
	 * - "advisor_reviewing" — new topic created and advisor review requested
	 * - "review_unavailable" — advisor rejected or request failed
	 * - "reused" — identical fingerprint, existing topic returned
	 * - "conflict" — another topic is mid-review
	 */
	readonly status: string;
}

// ─── Runtime ───────────────────────────────────────────────────────────

/**
 * BrainstormRuntime — orchestrates the full topic submission flow.
 *
 * Call `submitTopic()` with a converged topic input to:
 * 1. Collect tool event evidence snapshot
 * 2. Delegate to TopicCoordinator for dedup/conflict management
 * 3. Build codebase evidence and a bounded topic packet
 * 4. Register a review envelope in the registry
 * 5. Request an advisor review via the brainstorm_review trigger
 */
export class BrainstormRuntime {
	private config: BrainstormRuntimeConfig;

	constructor(config: BrainstormRuntimeConfig) {
		this.config = config;
	}

	/**
	 * Submit a substantive brainstorm topic for independent advisor review.
	 *
	 * On success the topic transitions to "advisor_reviewing".
	 * On rejection/error the topic transitions to "review_unavailable".
	 * Duplicate fingerprints return the existing topic without creating
	 * a new review. Conflicts return the active topic id without change.
	 */
	async submitTopic(input: BrainstormTopicReadyInput): Promise<BrainstormSubmitTopicResult> {
		const { coordinator, registry, collector } = this.config;

		// 1. Collect tool event evidence snapshot
		const snapshot = collector.collector.snapshot();

		// 2. Delegate to coordinator for dedup and conflict detection
		const submitResult = await coordinator.submit(input, snapshot);

		if (submitResult.kind === "reused") {
			return { topic: submitResult.topic, status: "reused" };
		}

		if (submitResult.kind === "conflict") {
			const currentTopic = coordinator.current();
			if (currentTopic && currentTopic.topicId === submitResult.activeTopicId) {
				return { topic: currentTopic, status: "conflict" };
			}
			return { topic: { topicId: submitResult.activeTopicId } as BrainstormTopicState, status: "conflict" };
		}

		// submitResult.kind === "created"
		const topic = submitResult.topic;

		// 3. Build codebase evidence, topic packet, rules, and envelope
		const codebaseEvidence = buildTopicCodebaseEvidence(topic.input.codebase_relevance, snapshot);
		const packet = buildTopicPacket(topic, snapshot);
		const context = renderTopicPacket(packet);
		const toolNames = codebaseEvidence.requestedToolNames;
		const rules =
			toolNames.length > 0
				? `${BRAINSTORM_REVIEW_RULES}\n\nAvailable codebase read-only tools: ${toolNames.join(", ")}`
				: BRAINSTORM_REVIEW_RULES;

		const reviewId = `br-${randomUUID()}`;
		const envelope = {
			reviewId,
			topicId: topic.topicId,
			inputHash: topic.inputHash,
			context,
			rules,
			createdAt: new Date().toISOString(),
		};

		// 4. Transition state and register envelope (inside try for atomicity)
		try {
			await coordinator.markReviewRequested(topic.topicId, reviewId);
			registry.put(envelope);
		} catch {
			registry.consume(reviewId);
			await coordinator.markReviewUnavailable(topic.topicId, "Failed to initiate review");
			return { reviewId, topic, status: "review_unavailable" };
		}
		// 5. Request advisor review
		try {
			const receipt = await this.config.requestAdvisorReview({
				trigger: "brainstorm_review",
				reviewId,
				metadata: {
					sessionId: this.config.sessionId(),
					taskId: `brainstorm-${topic.topicId}`,
					topicId: topic.topicId,
					inputHash: topic.inputHash,
					codebaseRelevance: topic.input.codebase_relevance,
				},
			});
			if (receipt.status !== "accepted") {
				registry.consume(reviewId);
				await coordinator.markReviewUnavailable(topic.topicId, "Advisor review not accepted");
				return { reviewId, topic, status: "review_unavailable" };
			}
			return { reviewId, topic, status: "advisor_reviewing" };
		} catch {
			registry.consume(reviewId);
			await coordinator.markReviewUnavailable(topic.topicId, "Advisor review request failed");
			return { reviewId, topic, status: "review_unavailable" };
		}
	}
}
