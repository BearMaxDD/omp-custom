/**
 * Brainstorm Topic Type Definitions.
 *
 * Core types for the Brainstorm topic lifecycle: topic kinds, ready input,
 * packets for advisor context, reviews, decisions, and persistent state.
 *
 * All types are independent of compliance completion types — a brainstorm
 * topic is not a compliance task and uses its own status machine.
 */

// ─── Topic Kind ──────────────────────────────────────────────────────

/** Supported brainstorm topic kinds. */
export type BrainstormTopicKind =
	| "architecture"
	| "api_design"
	| "workflow"
	| "tool_selection"
	| "refactoring"
	| "other";

// ─── Ready Input ─────────────────────────────────────────────────────

/**
 * Validated and normalized input for a brainstorm topic.
 *
 * Strings are trimmed. Lists are deduplicated and sorted. Lengths are
 * capped as documented per field. The input is ready for fingerprint
 * computation and advisor review submission.
 *
 * @remarks
 * - title: max 200 characters
 * - candidateDecision: max 4,000 characters
 * - discussionSummary: max 8,000 characters
 * - constraints / successCriteria / unresolvedQuestions: max 30 items each
 */
export interface BrainstormTopicReadyInput {
	/** The category of the brainstorm topic. */
	topicKind: BrainstormTopicKind;
	/**
	 * Short, descriptive title, max 200 chars.
	 * Used as the advisor review title and for display.
	 */
	title: string;
	/**
	 * The main decision the brainstorm has converged on, max 4,000 chars.
	 * Passed to the advisor as the candidate for review.
	 */
	candidateDecision: string;
	/**
	 * Constraints that bound the decision, max 30 items, each trimmed.
	 * E.g. ["只读 Advisor", "用户最终决定"].
	 */
	constraints: string[];
	/**
	 * Success criteria the decision must meet, max 30 items.
	 * E.g. ["结构化 review", "扩展关闭零副作用"].
	 */
	successCriteria: string[];
	/**
	 * Open questions still unresolved, max 30 items.
	 * These are hints to the advisor for further analysis.
	 */
	unresolvedQuestions: string[];
	/**
	 * Whether codebase context is required for the advisor review.
	 * "required" — the review MUST include read-only codebase-memory tools.
	 * "optional" — the review MAY use codebase-memory tools if available.
	 * "none" — no codebase context needed.
	 */
	codebaseRelevance: "required" | "optional" | "none";
	/**
	 * Discussion summary, max 8,000 chars.
	 * Free-text context the main agent has already discussed with the user.
	 */
	discussionSummary: string;
}

// ─── Topic Packet (Advisor Context) ──────────────────────────────────

/**
 * Context packet sent to the advisor for a brainstorm review.
 *
 * Includes the normalized input together with codebase evidence
 * references so the advisor can issue targeted read-only queries.
 */
export interface BrainstormTopicPacket {
	/** The normalized, validated topic input. */
	input: BrainstormTopicReadyInput;
	/**
	 * Codebase references collected during the discussion.
	 * Passed as tool-name hints for the advisor's read-only session.
	 */
	codebaseReferences: string[];
	/**
	 * The computed fingerprint — used to detect duplicate submissions.
	 * Format: `sha256:<hex>`.
	 */
	inputHash: `sha256:${string}`;
}

// ─── Review ──────────────────────────────────────────────────────────

/** A single finding within a brainstorm review. */
export interface BrainstormFinding {
	/** Category of the finding: "risk", "strength", "gap", "suggestion". */
	category: "risk" | "strength" | "gap" | "suggestion";
	/** Human-readable statement of the finding. */
	statement: string;
	/**
	 * Impact assessment: "low", "medium", "high", "critical".
	 * Optional — not all findings (e.g., strengths) carry impact.
	 */
	impact?: "low" | "medium" | "high" | "critical";
}

/** An alternative the advisor proposes alongside its recommendation. */
export interface BrainstormAlternative {
	/** Short title for the alternative approach. */
	title: string;
	/** Description of what the alternative entails. */
	description: string;
	/** Key trade-offs compared to the candidate decision. */
	tradeoffs: string[];
}

/**
 * A structured review produced by an advisor for one brainstorm topic.
 *
 * The advisor receives the topic packet and produces this structured
 * review. It is NOT a ComplianceVerdict and shares no verdict type
 * hierarchy with compliance.
 */
export interface BrainstormReview {
	/** Schema version for forward compatibility. */
	schema_version: number;
	/** Identifies which topic this review belongs to. */
	topic_id: string;
	/** The input fingerprint the advisor reviewed. */
	input_hash: `sha256:${string}`;
	/**
	 * Overall review status:
	 * - "challenge" — advisor identified issues or risks
	 * - "endorse" — advisor agrees with the candidate
	 * - "insufficient" — topic input lacks necessary detail
	 */
	status: "challenge" | "endorse" | "insufficient";
	/** One-paragraph summary of the review. */
	summary: string;
	/** Structured findings from the advisor. */
	findings: BrainstormFinding[];
	/** Alternative approaches the advisor considered. */
	alternatives: BrainstormAlternative[];
	/** The advisor's recommendation. */
	recommendation: string;
	/**
	 * Confidence in the review: "low", "medium", "high", "very_high".
	 */
	confidence: "low" | "medium" | "high" | "very_high";
}

// ─── Decision ────────────────────────────────────────────────────────

/** The user's final decision on a brainstorm topic. */
export interface BrainstormDecision {
	/**
	 * Decision outcome:
	 * - "adopt" — accept the candidate decision as-is
	 * - "adopt_with_changes" — accept with modifications
	 * - "reject" — reject and keep brainstorming
	 * - "defer" — postpone to a later session
	 */
	outcome: "adopt" | "adopt_with_changes" | "reject" | "defer";
	/** Free-text notes from the user explaining the decision. */
	notes: string;
	/**
	 * Optional: if the user provided a modified decision text
	 * (for adopt_with_changes), it goes here.
	 */
	revisedDecision?: string;
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
	/** The user's decision, if one has been recorded. */
	decision?: BrainstormDecision;
}
