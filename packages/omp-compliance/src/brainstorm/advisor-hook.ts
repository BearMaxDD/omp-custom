/**
 * Brainstorm Advisor Hook — injects topic review context and the
 * `brainstorm_review` tool into a dedicated Advisor run.
 *
 * The hook matches a `brainstorm_review` event against an envelope in
 * the registry. On match it returns:
 *  - additionalSystemContext: [rules, context] from the envelope
 *  - additionalTools: one immutable brainstorm_review tool
 *  - additionalToolNames: the read-only codebase tool names
 *  - metadata: { brainstormReviewId }
 *
 * The tool validates that the review's identity fields (topic_id,
 * input_hash) match the envelope, then delegates to
 * `coordinator.acceptReview()`. The envelope is consumed only on success.
 *
 * For `compliance_review` trigger, the hook returns undefined (no
 * intervention).
 */

import type { AdvisorBeforeRunEvent, AdvisorBeforeRunResult, AgentTool } from "../types";
import { BRAINSTORM_READ_ONLY_TOOL_NAMES } from "./advisor-rules";
import { renderDecisionCard } from "./decision-card";
import type { BrainstormReviewRegistry } from "./review-registry";
import type { BrainstormReviewEnvelope } from "./review-registry";
import { parseBrainstormReview } from "./review-schema";
import type { TopicCoordinator } from "./topic-coordinator";

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Create an advisor_before_run handler that injects brainstorm review
 * context and a dedicated brainstorm_review tool for matching events.
 */
export function createBrainstormAdvisorHook(
	registry: BrainstormReviewRegistry,
	coordinator: TopicCoordinator,
	sendMessage: (
		msg: { customType: string; content: string; display: boolean; attribution: "agent" | "user"; details?: unknown },
		options?: { deliverAs?: string; triggerTurn?: boolean },
	) => void,
): (event: AdvisorBeforeRunEvent) => AdvisorBeforeRunResult | undefined {
	return (event: AdvisorBeforeRunEvent): AdvisorBeforeRunResult | undefined => {
		if (event.trigger !== "compliance_review") {
			return undefined;
		}

		const reviewId = typeof event.metadata?.reviewId === "string" ? (event.metadata.reviewId as string) : "";

		const envelope = registry.get(reviewId);
		if (!envelope) {
			return undefined;
		}

		return {
			additionalSystemContext: Object.freeze([envelope.rules, envelope.context]),
			additionalTools: Object.freeze([createBrainstormReviewTool(envelope, coordinator, registry, sendMessage)]),
			metadata: Object.freeze({ brainstormReviewId: envelope.reviewId }),
		};
	};
}

// ─── Tool factory ───────────────────────────────────────────────────

/**
 * Create the `brainstorm_review` tool bound to a specific envelope,
 * coordinator instance, and registry.
 *
 * Validation order:
 *  1. Parse and validate the review against the envelope's identity
 *     (topic_id, input_hash) — mismatches throw before touching the
 *     coordinator.
 *  2. On match, coordinator.acceptReview() handles full state transition.
 *  3. On success the envelope is consumed (at-most-once).
 */
export function createBrainstormReviewTool(
	envelope: BrainstormReviewEnvelope,
	coordinator: TopicCoordinator,
	registry: BrainstormReviewRegistry,
	sendMessage: (
		msg: { customType: string; content: string; display: boolean; attribution: "agent" | "user"; details?: unknown },
		options?: { deliverAs?: string; triggerTurn?: boolean },
	) => void,
): AgentTool {
	return {
		name: "brainstorm_review",
		label: "Brainstorm Review",
		description: "Submit a structured brainstorm review after evaluating the topic",
		intent: "omit",
		parameters: {
			type: "object",
			properties: {
				schema_version: { type: "number", const: 1 },
				topic_id: { type: "string" },
				input_hash: { type: "string" },
				status: { type: "string", enum: ["support", "challenge", "insufficient_evidence"] },
				summary: { type: "string" },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							category: {
								type: "string",
								enum: ["risk", "assumption", "scope", "contract", "migration", "feasibility"],
							},
							statement: { type: "string" },
							impact: { type: "string", enum: ["high", "medium", "low"] },
							evidence_refs: { type: "array", items: { type: "string" } },
						},
						required: ["category", "statement", "impact"],
					},
				},
				alternatives: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							description: { type: "string" },
							tradeoffs: { type: "array", items: { type: "string" } },
							when_to_choose: { type: "string" },
						},
						required: ["name", "description", "tradeoffs", "when_to_choose"],
					},
				},
				recommendation: { type: "string" },
				confidence: { type: "string", enum: ["high", "medium", "low"] },
			},
			required: [
				"schema_version",
				"topic_id",
				"input_hash",
				"status",
				"summary",
				"findings",
				"alternatives",
				"recommendation",
				"confidence",
			],
		},
		execute: async (_toolCallId: string, params: Record<string, unknown>) => {
			const review = parseBrainstormReview(params, {
				topicId: envelope.topicId,
				inputHash: envelope.inputHash,
			});
			await coordinator.acceptReview(review);
			registry.consume(envelope.reviewId);
			const topic = coordinator.current();
			if (topic) {
				sendMessage(
					{
						customType: "brainstorm_review",
						content: renderDecisionCard(topic),
						display: true,
						attribution: "agent",
						details: { topicId: review.topic_id, review },
					},
					{ deliverAs: "nextTurn", triggerTurn: true },
				);
			}
			return {
				content: [{ type: "text" as const, text: "Brainstorm review accepted." }],
				details: { topicId: review.topic_id, status: review.status },
			};
		},
	};
}
