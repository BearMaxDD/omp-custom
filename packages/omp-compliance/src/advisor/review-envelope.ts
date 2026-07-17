/**
 * ComplianceReviewEnvelope — immutable value object with stable reviewId.
 *
 * Each envelope captures the facts for one compliance review session.
 * reviewId is a deterministic SHA-256 of the 4-tuple
 *   [sessionId, taskId, contractHash, attempt],
 * formatted as `compliance:<64 hex>`.
 *
 * ComplianceReviewRegistry provides put/get/consume lifecycle — an
 * envelope can be consumed at most once, enforcing at-most-once
 * processing.
 */
import { createHash } from "node:crypto";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";

// ─── Input shape for createEnvelope ────────────────────────────────

export interface EnvelopeInput {
	readonly sessionId: string;
	readonly taskId: string;
	readonly contractHash: `sha256:${string}`;
	readonly attempt: number;
	readonly context: string;
	readonly rules: string;
}

// ─── Envelope interface ────────────────────────────────────────────

export interface ComplianceReviewEnvelope {
	readonly reviewId: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly contractHash: `sha256:${string}`;
	readonly attempt: number;
	readonly context: string;
	readonly rules: string;
	readonly createdAt: string;
}

// ─── createEnvelope ────────────────────────────────────────────────

/**
 * Create a frozen ComplianceReviewEnvelope with a stable, deterministic
 * reviewId derived from the identity fields.
 */
export function createEnvelope(input: EnvelopeInput): ComplianceReviewEnvelope {
	const reviewId = computeReviewId(input.sessionId, input.taskId, input.contractHash, input.attempt);
	const createdAt = new Date().toISOString();
	return Object.freeze({ reviewId, ...input, createdAt });
}

// ─── Registry ──────────────────────────────────────────────────────

/**
 * At-most-once registry for ComplianceReviewEnvelopes.
 *
 * An envelope can be `consume()`d only once; subsequent calls return
 * undefined. This enforces the "one review, one verdict" invariant.
 */
export class ComplianceReviewRegistry {
	#active = new Map<string, ComplianceReviewEnvelope>();

	put(v: ComplianceReviewEnvelope): void {
		this.#active.set(v.reviewId, v);
	}

	get(id: string): ComplianceReviewEnvelope | undefined {
		return this.#active.get(id);
	}

	consume(id: string): ComplianceReviewEnvelope | undefined {
		const v = this.#active.get(id);
		if (v) {
			this.#active.delete(id);
		}
		return v;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Deterministic SHA-256 of the 4-tuple, formatted `compliance:<64 hex>`.
 */
function computeReviewId(sessionId: string, taskId: string, contractHash: string, attempt: number): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify([sessionId, taskId, contractHash, attempt]));
	return `compliance:${hash.digest("hex")}`;
}

/**
 * Narrow dependency contract for the compliance review production path.
 *
 * Injected at construction time so the state machine never references
 * the entire ExtensionAPI for review operations.
 */
export interface ComplianceReviewDependencies {
	/** Current session identifier. */
	sessionId(): string;
	/** At-most-once envelope registry shared with the advisor hook. */
	registry: ComplianceReviewRegistry;
	/**
	 * Request the harness to start an Advisor review run.
	 * May throw if the harness is unable to accommodate the request.
	 */
	requestAdvisorReview(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt>;
}
