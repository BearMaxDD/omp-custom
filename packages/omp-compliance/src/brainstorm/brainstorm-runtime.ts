/**
 * BrainstormRuntime — orchestrates topic submission, evidence gathering,
 * packet building, envelope registration, and advisor review requests.
 *
 * This is the entry point for the main agent's brainstorm_topic_ready tool.
 * It manages the complete lifecycle of submitting a converged topic to an
 * independent advisor for review.
 */

import { createHash } from "node:crypto";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import type { ReviewIntent } from "../scheduler/review-intent";
import type { ReviewScheduler } from "../scheduler/review-scheduler";
import type { CollectorRuntime } from "../signals/collector-runtime";
import { BRAINSTORM_REVIEW_RULES } from "./advisor-rules";
import { buildTopicCodebaseEvidence } from "./codebase-evidence";
import type { BrainstormReviewRegistry } from "./review-registry";
import type { TopicCoordinator } from "./topic-coordinator";
import { buildTopicPacket, renderTopicPacket } from "./topic-packet";
import type { BrainstormReview, BrainstormTopicReadyInput, BrainstormTopicState } from "./types";

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
	/** Shared single-priority Advisor scheduler. */
	readonly scheduler: ReviewScheduler;
	/** Idempotently restore the shared scheduler before first use. */
	readonly ensureSchedulerReady?: () => Promise<void>;
	/** Authoritative project and Git identity for the review scope. */
	readonly projectContext: () => {
		readonly projectId: string;
		readonly gitHead: string;
		readonly diffHash: string;
	};
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
	private activeEnvelope: import("./review-registry").BrainstormReviewEnvelope | undefined;
	private operationTail: Promise<void> = Promise.resolve();

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
		const { coordinator, registry, collector, scheduler } = this.config;
		await this.ensureSchedulerReady();

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
		if (topic.input.codebase_relevance === "required" && codebaseEvidence.mode !== "available") {
			await coordinator.markReviewUnavailable(topic.topicId, "Required read-only codebase evidence is unavailable");
			return { topic, status: "review_unavailable" };
		}
		const packet = buildTopicPacket(topic, snapshot);
		const context = renderTopicPacket(packet);
		const available = new Set(this.config.getAllTools());
		const toolNames = codebaseEvidence.requestedToolNames.filter((name) => available.has(name));
		const rules =
			toolNames.length > 0
				? `${BRAINSTORM_REVIEW_RULES}\n\nAvailable codebase read-only tools: ${toolNames.join(", ")}`
				: BRAINSTORM_REVIEW_RULES;
		const project = this.config.projectContext();
		const evidenceRevision = snapshot.codebaseMemory.pack?.evidenceRevision ?? evidenceRevisionFor(snapshot);
		const enqueued = await scheduler.enqueue({
			trigger: "brainstorm_review",
			priority: 80,
			projectId: project.projectId,
			taskId: `brainstorm-${topic.topicId}`,
			topicId: topic.topicId,
			contractHash: topic.inputHash,
			evidenceRevision,
			gitHead: project.gitHead,
			diffHash: project.diffHash,
			taskAttempt: topic.attempt,
			metadata: {
				sessionId: this.config.sessionId(),
				topicId: topic.topicId,
				inputHash: topic.inputHash,
				codebaseRelevance: topic.input.codebase_relevance,
				context,
				rules,
				requestedToolNames: toolNames,
			},
		});
		const reviewAttempt = Math.max(1, enqueued.intent.attempt + 1);
		const reviewId = reviewIdFor(enqueued.intent.dedupeKey, reviewAttempt);
		const envelope = {
			reviewId,
			topicId: topic.topicId,
			projectId: project.projectId,
			inputHash: topic.inputHash,
			evidenceRevision,
			gitHead: project.gitHead,
			diffHash: project.diffHash,
			trigger: "brainstorm_review" as const,
			context,
			rules,
			requestedToolNames: Object.freeze([...toolNames]),
			createdAt: new Date().toISOString(),
		};

		// 4a. Transition state before envelope registration
		try {
			await coordinator.markReviewRequested(topic.topicId, reviewId, envelope);
		} catch (error) {
			await scheduler.abandonReview(enqueued.intent.reviewId);
			throw error;
		}
		// 4b. Register envelope (state is now advisor_reviewing)
		registry.put(envelope);
		this.activeEnvelope = envelope;
		// 5. Dispatch through the shared Scheduler.
		try {
			await scheduler.pump();
			const schedulerState = scheduler.snapshot();
			if (schedulerState.inFlight?.reviewId === reviewId) {
				return { reviewId, topic, status: "advisor_reviewing" };
			}
			const queued = schedulerState.queued.find((intent) => intent.dedupeKey === enqueued.intent.dedupeKey);
			if (queued && schedulerState.inFlight) {
				return { reviewId, topic, status: "advisor_reviewing" };
			}
			registry.consume(reviewId);
			await coordinator.markReviewUnavailable(topic.topicId, "Advisor review not accepted");
			return { reviewId, topic, status: "review_unavailable" };
		} catch {
			registry.consume(reviewId);
			await coordinator.markReviewUnavailable(topic.topicId, "Advisor review request failed");
			return { reviewId, topic, status: "review_unavailable" };
		}
	}

	handleAdvisorLifecycle(event: AdvisorReviewLifecycleEvent): Promise<void> {
		return this.serializeOperation(() => this.handleAdvisorLifecycleExclusive(event));
	}

	private async handleAdvisorLifecycleExclusive(event: AdvisorReviewLifecycleEvent): Promise<void> {
		if (event.trigger !== "brainstorm_review") return;
		await this.config.scheduler.handleLifecycle(event, false);
		const topic = this.config.coordinator.current();
		if (!topic || event.reviewId !== this.activeEnvelope?.reviewId) return;
		if (
			event.type === "advisor_run_failed" ||
			event.type === "advisor_run_cancelled" ||
			(event.type === "advisor_run_completed" && !event.verdictSubmitted)
		) {
			this.config.registry.consume(event.reviewId);
			if (topic.status === "advisor_reviewing") {
				await this.config.coordinator.markReviewUnavailable(topic.topicId, "Advisor review ended without a verdict");
			}
		}
	}

	retryDueReviews(): Promise<void> {
		return this.serializeOperation(() => this.retryDueReviewsExclusive());
	}

	private async retryDueReviewsExclusive(): Promise<void> {
		await this.ensureSchedulerReady();
		let topic = this.config.coordinator.current();
		let schedulerSnapshot = this.config.scheduler.snapshot();
		const persistedIntent = topic
			? schedulerSnapshot.queued.find(
					(intent) => intent.taskId === `brainstorm-${topic?.topicId}` && intent.trigger === "brainstorm_review",
				)
			: undefined;
		if (topic?.status === "ready_for_advisor_review" && persistedIntent) {
			const envelope = this.envelopeFromIntent(topic, persistedIntent);
			await this.config.coordinator.markReviewRequested(topic.topicId, envelope.reviewId, envelope);
			this.config.registry.put(envelope);
			this.activeEnvelope = envelope;
			topic = this.config.coordinator.current();
		}
		if (topic?.reviewEnvelope && !this.activeEnvelope) {
			this.activeEnvelope = topic.reviewEnvelope;
			this.config.registry.put(topic.reviewEnvelope);
		}
		if (topic?.status === "advisor_reviewing" && topic.pendingReview && this.activeEnvelope) {
			const completed = await this.config.scheduler.completeReview(this.activeEnvelope.reviewId);
			if (!completed) throw new Error("Prepared Brainstorm review has no matching Scheduler intent");
			this.config.registry.consume(this.activeEnvelope.reviewId);
			await this.config.coordinator.commitPreparedReview(topic.topicId);
			await this.dispatchFollowingReviews();
			return;
		}
		const queuedBrainstorm = schedulerSnapshot.queued.find(
			(intent) => topic && intent.taskId === `brainstorm-${topic.topicId}` && intent.trigger === "brainstorm_review",
		);
		const canPumpWithoutPreparingRetry =
			topic?.status === "ready_for_advisor_review" ||
			(topic?.status === "advisor_reviewing" && queuedBrainstorm?.attempt === 0);
		if (!schedulerSnapshot.inFlight && schedulerSnapshot.queued.length > 0 && canPumpWithoutPreparingRetry) {
			await this.config.scheduler.pump();
			schedulerSnapshot = this.config.scheduler.snapshot();
		}
		if (topic?.status === "advisor_reviewing" && this.activeEnvelope) {
			const schedulerState = this.config.scheduler.snapshot();
			if (schedulerState.inFlight?.reviewId === this.activeEnvelope.reviewId) return;
			const queued = schedulerState.queued.find(
				(intent) => intent.taskId === `brainstorm-${topic?.topicId}` && intent.trigger === "brainstorm_review",
			);
			if (!queued || queued.attempt === 0) return;
			this.config.registry.consume(this.activeEnvelope.reviewId);
			await this.config.coordinator.markReviewUnavailable(
				topic.topicId,
				"Advisor dispatch failed or was restored after interruption",
			);
			topic = this.config.coordinator.current();
		}
		if (!topic || topic.status !== "review_unavailable" || !this.activeEnvelope) return;
		const queued = this.config.scheduler.nextDueIntent(`brainstorm-${topic.topicId}`, "brainstorm_review");
		if (!queued) return;
		const reviewId = reviewIdFor(queued.dedupeKey, queued.attempt + 1);
		try {
			await this.config.coordinator.markReady(topic.topicId);
			const envelope = Object.freeze({ ...this.activeEnvelope, reviewId, createdAt: new Date().toISOString() });
			await this.config.coordinator.markReviewRequested(topic.topicId, reviewId, envelope);
			this.config.registry.put(envelope);
			this.activeEnvelope = envelope;
		} catch (error) {
			if (this.config.coordinator.current()?.status === "ready_for_advisor_review") {
				await this.config.coordinator.markReviewUnavailable(topic.topicId, "Advisor retry state persistence failed");
			}
			throw error;
		}
		try {
			await this.config.scheduler.pump();
		} catch {
			this.config.registry.consume(reviewId);
			await this.config.coordinator.markReviewUnavailable(topic.topicId, "Advisor retry request failed");
			return;
		}
		const schedulerState = this.config.scheduler.snapshot();
		if (schedulerState.inFlight?.reviewId === reviewId) return;
		const stillQueued = schedulerState.queued.some((intent) => intent.dedupeKey === queued.dedupeKey);
		if (stillQueued && schedulerState.inFlight) return;
		this.config.registry.consume(reviewId);
		if (this.config.coordinator.current()?.status === "advisor_reviewing") {
			await this.config.coordinator.markReviewUnavailable(topic.topicId, "Advisor retry not accepted");
		}
	}

	acceptReview(
		envelope: import("./review-registry").BrainstormReviewEnvelope,
		review: BrainstormReview,
	): Promise<BrainstormTopicState> {
		return this.serializeOperation(() => this.acceptReviewExclusive(envelope, review));
	}

	private async acceptReviewExclusive(
		envelope: import("./review-registry").BrainstormReviewEnvelope,
		review: BrainstormReview,
	): Promise<BrainstormTopicState> {
		const topic = this.config.coordinator.current();
		if (
			this.config.registry.get(envelope.reviewId) !== envelope ||
			this.activeEnvelope?.reviewId !== envelope.reviewId ||
			topic?.status !== "advisor_reviewing"
		) {
			throw new Error("Brainstorm review is stale or no longer active");
		}
		this.config.registry.consume(envelope.reviewId);
		try {
			await this.config.coordinator.prepareReview(review);
		} catch (error) {
			this.config.registry.put(envelope);
			throw error;
		}
		try {
			const completed = await this.config.scheduler.completeReview(envelope.reviewId);
			if (!completed) throw new Error("Brainstorm Scheduler intent is no longer active");
		} catch (error) {
			await this.config.coordinator.rollbackPreparedReview(envelope.topicId);
			this.config.registry.put(envelope);
			throw error;
		}
		await this.config.coordinator.commitPreparedReview(envelope.topicId);
		await this.dispatchFollowingReviews();
		const accepted = this.config.coordinator.current();
		if (!accepted) throw new Error("Brainstorm topic disappeared after review acceptance");
		return accepted;
	}

	private async ensureSchedulerReady(): Promise<void> {
		if (this.config.ensureSchedulerReady) await this.config.ensureSchedulerReady();
	}

	private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async dispatchFollowingReviews(): Promise<void> {
		try {
			await this.config.scheduler.pump();
		} catch {
			// The accepted review is already durable; a later turn retries queued work.
		}
	}

	restoreAdvisorEnvelope(reviewId: string): Promise<boolean> {
		return this.serializeOperation(async () => {
			await this.ensureSchedulerReady();
			const topic = this.config.coordinator.current();
			const envelope = topic?.reviewEnvelope;
			if (!topic || !envelope || envelope.reviewId !== reviewId) return false;
			this.activeEnvelope = envelope;
			if (topic.status === "advisor_reviewing" && topic.pendingReview) {
				const completed = await this.config.scheduler.completeReview(reviewId);
				if (!completed) throw new Error("Prepared Brainstorm review has no matching Scheduler intent");
				await this.config.coordinator.commitPreparedReview(topic.topicId);
				await this.dispatchFollowingReviews();
				return false;
			}
			this.config.registry.put(envelope);
			return true;
		});
	}

	private envelopeFromIntent(topic: BrainstormTopicState, intent: ReviewIntent) {
		const metadata = intent.metadata ?? {};
		const requestedToolNames = Array.isArray(metadata.requestedToolNames)
			? metadata.requestedToolNames.filter((name): name is string => typeof name === "string")
			: [];
		const snapshot = this.config.collector.collector.snapshot();
		const context =
			typeof metadata.context === "string" ? metadata.context : renderTopicPacket(buildTopicPacket(topic, snapshot));
		const rules = typeof metadata.rules === "string" ? metadata.rules : BRAINSTORM_REVIEW_RULES;
		return Object.freeze({
			reviewId: reviewIdFor(intent.dedupeKey, intent.attempt + 1),
			topicId: topic.topicId,
			projectId: intent.projectId,
			inputHash: topic.inputHash,
			evidenceRevision: intent.evidenceRevision,
			gitHead: intent.gitHead,
			diffHash: intent.diffHash,
			trigger: "brainstorm_review" as const,
			context,
			rules,
			requestedToolNames: Object.freeze(requestedToolNames),
			createdAt: new Date().toISOString(),
		});
	}
}

function reviewIdFor(dedupeKey: string, attempt: number): string {
	return `review:${dedupeKey.slice("sha256:".length)}:${attempt}`;
}

function evidenceRevisionFor(snapshot: ReturnType<CollectorRuntime["collector"]["snapshot"]>): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}
