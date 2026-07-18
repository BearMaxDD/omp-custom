/**
 * Brainstorm Topic Type Definitions.
 *
 * Core types for the Brainstorm topic lifecycle: topic kinds, ready input,
 * packets for advisor context, reviews, decisions, and persistent state.
 *
 * All types are independent of compliance completion types — a brainstorm
 * topic is not a compliance task and uses its own status machine.
 *
 * @see 2026-07-13-omp-advisor-brainstorm-topic-review-trd.md §5
 */

// ─── Topic Kind ──────────────────────────────────────────────────────

/** Supported brainstorm topic kinds (TRD §5.1). */
export type BrainstormTopicKind = "architecture" | "scope" | "contract" | "migration" | "risk" | "implementation_route";

// ─── Ready Input ─────────────────────────────────────────────────────

/**
 * Validated and normalized input for a brainstorm topic (TRD §5.1).
 *
 * Snake_case fields — these are a tool-call boundary contract.
 * Strings are trimmed. Lists are deduplicated and sorted. Lengths are
 * capped as documented per field. The input is ready for fingerprint
 * computation and advisor review submission.
 *
 * @remarks
 * - title: max 200 characters
 * - candidate_decision: max 4,000 characters
 * - discussion_summary: max 8,000 characters
 * - constraints / success_criteria / unresolved_questions: max 30 items each
 */
export interface BrainstormTopicReadyInput {
	/** The category of the brainstorm topic. */
	topic_kind: BrainstormTopicKind;
	/**
	 * Short, descriptive title, max 200 chars.
	 * Used as the advisor review title and for display.
	 */
	title: string;
	/**
	 * The main decision the brainstorm has converged on, max 4,000 chars.
	 * Passed to the advisor as the candidate for review.
	 */
	candidate_decision: string;
	/**
	 * Constraints that bound the decision, max 30 items, each trimmed.
	 * E.g. ["只读 Advisor", "用户最终决定"].
	 */
	constraints: string[];
	/**
	 * Success criteria the decision must meet, max 30 items.
	 * E.g. ["结构化 review", "扩展关闭零副作用"].
	 */
	success_criteria: string[];
	/**
	 * Open questions still unresolved, max 30 items.
	 * These are hints to the advisor for further analysis.
	 */
	unresolved_questions?: string[];
	/**
	 * Whether codebase context is required for the advisor review.
	 * "required" — the review MUST include read-only codebase-memory tools.
	 * "optional" — the review MAY use codebase-memory tools if available.
	 * "none" — no codebase context needed.
	 */
	codebase_relevance: "required" | "optional" | "none";
	/**
	 * Discussion summary, max 8,000 chars.
	 * Free-text context the main agent has already discussed with the user.
	 */
	discussion_summary: string;
}

// ─── Topic Packet (Advisor Context) ──────────────────────────────────

/**
 * Context packet sent to the advisor for a brainstorm review (TRD §5.2).
 *
 * Flat structure with inlined input fields and codebase context metadata.
 * The advisor uses this to issue targeted read-only queries.
 */
export interface BrainstormTopicPacket {
	/** Schema version for forward compatibility. */
	schema_version: 1;
	/** Stable unique identifier for this topic. */
	topic_id: string;
	/** SHA-256 fingerprint of the normalized input (sha256:hex). */
	input_hash: `sha256:${string}`;
	/** The category of the brainstorm topic. */
	topic_kind: BrainstormTopicKind;
	/** Short title, max 200 chars. */
	title: string;
	/** The candidate decision under review. */
	candidate_decision: string;
	/** Constraints bounding the decision. */
	constraints: string[];
	/** Success criteria the decision must meet. */
	success_criteria: string[];
	/** Open questions still unresolved. */
	unresolved_questions: string[];
	/** Free-text discussion summary, max 8,000 chars. */
	discussion_summary: string;
	/**
	 * Codebase context metadata.
	 * - mode: whether codebase context was needed/available.
	 * - references: labelled references with their source type.
	 */
	codebase_context: {
		mode: "not_needed" | "available" | "unavailable";
		references: Array<{ label: string; source: "graph" | "snippet" | "trace" | "text" }>;
	};
}

// ─── Review ──────────────────────────────────────────────────────────

/** A single finding within a brainstorm review (TRD §5.3). */
export interface BrainstormFinding {
	/**
	 * Category of the finding:
	 * "risk" | "assumption" | "scope" | "contract" | "migration" | "feasibility".
	 */
	category: "risk" | "assumption" | "scope" | "contract" | "migration" | "feasibility";
	/** Human-readable statement of the finding. */
	statement: string;
	/**
	 * Impact assessment: "high", "medium", "low".
	 * Required — every finding carries an impact rating.
	 */
	impact: "high" | "medium" | "low";
	/** Optional references to codebase evidence supporting this finding. */
	evidence_refs?: string[];
}

/** An alternative the advisor proposes alongside its recommendation (TRD §5.3). */
export interface BrainstormAlternative {
	/** Short name for the alternative approach. */
	name: string;
	/** Description of what the alternative entails. */
	description: string;
	/** Key trade-offs compared to the candidate decision. */
	tradeoffs: string[];
	/** Guidance on when this alternative should be chosen. */
	when_to_choose: string;
}

/**
 * A structured review produced by an advisor for one brainstorm topic (TRD §5.3).
 *
 * The advisor receives the topic packet and produces this structured
 * review. It is NOT a ComplianceVerdict and shares no verdict type
 * hierarchy with compliance.
 */
export interface BrainstormReview {
	/** Schema version for forward compatibility. */
	schema_version: 1;
	/** Identifies which topic this review belongs to. */
	topic_id: string;
	/** The input fingerprint the advisor reviewed. */
	input_hash: `sha256:${string}`;
	/**
	 * Overall review status (TRD §5.3):
	 * - "support" — advisor supports the candidate decision
	 * - "challenge" — advisor identified issues or risks
	 * - "insufficient_evidence" — topic input lacks necessary detail or evidence
	 */
	status: "support" | "challenge" | "insufficient_evidence";
	/** One-paragraph summary of the review. */
	summary: string;
	/** Structured findings from the advisor. */
	findings: BrainstormFinding[];
	/** Alternative approaches the advisor considered. */
	alternatives: BrainstormAlternative[];
	/** The advisor's recommendation. */
	recommendation: string;
	/**
	 * Confidence in the review: "high", "medium", "low".
	 */
	confidence: "high" | "medium" | "low";
}

// ─── Decision ────────────────────────────────────────────────────────

/** The user's final decision on a brainstorm topic (TRD §5.4). */
export interface BrainstormDecision {
	/** The topic this decision applies to. */
	topic_id: string;
	/**
	 * Decision outcome (TRD §5.4):
	 * - "accept_candidate" — accept the candidate decision as-is
	 * - "accept_alternative" — accept an alternative approach instead
	 * - "reopen" — reopen the topic for further discussion
	 * - "park" — set aside for later
	 */
	decision: "accept_candidate" | "accept_alternative" | "reopen" | "park";
	/** If accepting an alternative, the name of the selected alternative. */
	selected_alternative?: string;
	/** Free-text rationale from the user explaining the decision. */
	rationale?: string;
	/** ISO-8601 timestamp of when the decision was made. */
	ts: string;
}

// ─── Topic Status ────────────────────────────────────────────────────

/**
 * The lifecycle status of a brainstorm topic.
 *
 * - drafting: the topic is being discussed, not yet ready for review
 * - ready_for_advisor_review: input is finalized, queued for advisor review
 * - advisor_reviewing: the advisor is actively producing a review
 * - awaiting_user_decision: the review is complete, waiting for the user
 * - review_unavailable: the advisor was unable to produce a review
 * - decided: the user has made a final decision
 * - parked: the topic has been set aside (e.g., dependencies not met)
 */
export type BrainstormTopicStatus =
	| "drafting"
	| "ready_for_advisor_review"
	| "advisor_reviewing"
	| "awaiting_user_decision"
	| "review_unavailable"
	| "decided"
	| "parked";

// ─── Persistent State ────────────────────────────────────────────────

/**
 * Full persistent state for one brainstorm topic.
 *
 * This is the serialized state record. It contains all fields needed
 * to display the topic, detect duplicate submissions, and track the
 * lifecycle. It is kept in a JSONL file by the topic store.
 */
export interface BrainstormTopicState {
	/** Stable unique identifier for the topic. */
	topicId: string;
	/**
	 * SHA-256 fingerprint of the normalized input.
	 * Used for duplicate detection.
	 * Format: `sha256:<hex>`.
	 */
	inputHash: `sha256:${string}`;
	/** Current lifecycle status. */
	status: BrainstormTopicStatus;
	/** Number of review attempts so far. */
	attempt: number;
	/** The normalized, validated input. */
	input: BrainstormTopicReadyInput;
	/** The advisor's review, if one has been produced. */
	review?: BrainstormReview;
	/** Prepared review journal awaiting Scheduler and Topic commit. */
	pendingReview?: BrainstormReview;
	/** Durable Envelope used to rebuild the Advisor hook after restart. */
	reviewEnvelope?: BrainstormReviewEnvelope;
	/** The user's decision, if one has been recorded. */
	decision?: BrainstormDecision;
}
import type { BrainstormReviewEnvelope } from "./review-registry";
