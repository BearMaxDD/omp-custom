/**
 * BrainstormReview schema, validation, and parsing.
 *
 * The Advisor issues a BrainstormReview (schema_version=1) for each
 * brainstorm topic review. The review is validated against the expected
 * topic context (topic_id, input_hash) and structural rules:
 *
 *  - status MUST be one of: support | challenge | insufficient_evidence
 *  - pass/remediate are NOT valid brainstorm review statuses
 *  - Compliance identity fields (task_id, contract_hash, attempt) are rejected
 *
 * This module provides parseBrainstormReview() for strict one-shot validation
 * with detailed errors. It NEVER decides semantics — only shape and
 * context binding.
 */

import type { BrainstormAlternative, BrainstormFinding, BrainstormReview } from "./types";

// ─── Error ────────────────────────────────────────────────────────────

/**
 * Error thrown when a BrainstormReview fails validation.
 */
export class BrainstormReviewError extends Error {
	name = "BrainstormReviewError" as const;
}

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Expected context for brainstorm review validation.
 */
export interface ReviewContext {
	readonly topicId: string;
	readonly inputHash: string;
}

const ALLOWED_STATUSES = new Set(["support", "challenge", "insufficient_evidence"]);
const COMPLIANCE_FIELDS = ["task_id", "contract_hash", "attempt"];
const ALLOWED_CATEGORIES = new Set(["risk", "assumption", "scope", "contract", "migration", "feasibility"]);
const ALLOWED_IMPACTS = new Set(["high", "medium", "low"]);
const ALLOWED_CONFIDENCES = new Set(["high", "medium", "low"]);

/**
 * Validate a raw input object as a BrainstormReview against the expected
 * topic context (topicId and inputHash).
 *
 * Throws BrainstormReviewError on first validation failure.
 */
export function parseBrainstormReview(raw: Record<string, unknown>, context: ReviewContext): BrainstormReview {
	if (typeof raw !== "object" || raw === null) {
		throw new BrainstormReviewError("Input must be a non-null object");
	}

	// ── Reject compliance identity fields ───────────────────────────
	for (const field of COMPLIANCE_FIELDS) {
		if (field in raw) {
			throw new BrainstormReviewError(`Compliance identity field "${field}" is not allowed in brainstorm review`);
		}
	}

	// ── Schema version ─────────────────────────────────────────────
	if (raw.schema_version !== 1) {
		throw new BrainstormReviewError("Missing or invalid schema_version: expected 1");
	}

	// ── Identity ───────────────────────────────────────────────────
	if (raw.topic_id !== context.topicId) {
		throw new BrainstormReviewError(`topic_id mismatch: expected "${context.topicId}", got "${String(raw.topic_id)}"`);
	}

	const inputHash = raw.input_hash;
	if (typeof inputHash !== "string" || !inputHash.startsWith("sha256:")) {
		throw new BrainstormReviewError(`Invalid input_hash: must be a sha256: string, got "${String(inputHash)}"`);
	}
	if (inputHash !== context.inputHash) {
		throw new BrainstormReviewError(
			`input_hash mismatch: expected "${context.inputHash}", got "${inputHash}"`,
		);
	}

	// ── Status ─────────────────────────────────────────────────────
	const status = raw.status;
	if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
		throw new BrainstormReviewError(
			`Invalid status "${String(status)}": must be one of ${[...ALLOWED_STATUSES].join(", ")}`,
		);
	}

	// ── Summary ────────────────────────────────────────────────────
	if (typeof raw.summary !== "string" || raw.summary.length === 0) {
		throw new BrainstormReviewError("Missing or empty summary");
	}

	// ── Findings ───────────────────────────────────────────────────
	if (!Array.isArray(raw.findings)) {
		throw new BrainstormReviewError("Missing or non-array findings");
	}
	const findings: BrainstormFinding[] = raw.findings.map((f: unknown, i: number) => {
		if (typeof f !== "object" || f === null) {
			throw new BrainstormReviewError(`findings[${i}] is not an object`);
		}
		const finding = f as Record<string, unknown>;
		if (!ALLOWED_CATEGORIES.has(finding.category as string)) {
			throw new BrainstormReviewError(`findings[${i}].category is invalid: "${String(finding.category)}"`);
		}
		if (typeof finding.statement !== "string" || finding.statement.length === 0) {
			throw new BrainstormReviewError(`findings[${i}].statement is missing or empty`);
		}
		if (!ALLOWED_IMPACTS.has(finding.impact as string)) {
			throw new BrainstormReviewError(`findings[${i}].impact is invalid: "${String(finding.impact)}"`);
		}
		const evidence_refs: string[] | undefined = Array.isArray(finding.evidence_refs)
			? (finding.evidence_refs as string[])
			: undefined;
		return {
			category: finding.category as BrainstormFinding["category"],
			statement: finding.statement as string,
			impact: finding.impact as BrainstormFinding["impact"],
			...(evidence_refs ? { evidence_refs } : {}),
		};
	});

	// ── Alternatives ───────────────────────────────────────────────
	if (!Array.isArray(raw.alternatives)) {
		throw new BrainstormReviewError("Missing or non-array alternatives");
	}
	const alternatives: BrainstormAlternative[] = raw.alternatives.map((a: unknown, i: number) => {
		if (typeof a !== "object" || a === null) {
			throw new BrainstormReviewError(`alternatives[${i}] is not an object`);
		}
		const alt = a as Record<string, unknown>;
		if (typeof alt.name !== "string" || alt.name.length === 0) {
			throw new BrainstormReviewError(`alternatives[${i}].name is missing or empty`);
		}
		if (typeof alt.description !== "string" || alt.description.length === 0) {
			throw new BrainstormReviewError(`alternatives[${i}].description is missing or empty`);
		}
		if (!Array.isArray(alt.tradeoffs)) {
			throw new BrainstormReviewError(`alternatives[${i}].tradeoffs is missing or non-array`);
		}
		if (typeof alt.when_to_choose !== "string" || alt.when_to_choose.length === 0) {
			throw new BrainstormReviewError(`alternatives[${i}].when_to_choose is missing or empty`);
		}
		return {
			name: alt.name as string,
			description: alt.description as string,
			tradeoffs: alt.tradeoffs as string[],
			when_to_choose: alt.when_to_choose as string,
		};
	});

	// ── Recommendation ─────────────────────────────────────────────
	if (typeof raw.recommendation !== "string" || raw.recommendation.length === 0) {
		throw new BrainstormReviewError("Missing or empty recommendation");
	}

	// ── Confidence ─────────────────────────────────────────────────
	const confidence = raw.confidence;
	if (typeof confidence !== "string" || !ALLOWED_CONFIDENCES.has(confidence)) {
		throw new BrainstormReviewError(
			`Invalid confidence "${String(confidence)}": must be one of ${[...ALLOWED_CONFIDENCES].join(", ")}`,
		);
	}

	return {
		schema_version: 1,
		topic_id: context.topicId,
		input_hash: context.inputHash as `sha256:${string}`,
		status: status as BrainstormReview["status"],
		summary: raw.summary as string,
		findings,
		alternatives,
		recommendation: raw.recommendation as string,
		confidence: confidence as BrainstormReview["confidence"],
	};
}
