/**
 * BrainstormReviewEnvelope and BrainstormReviewRegistry.
 *
 * Each envelope captures the identity of one brainstorm topic review session.
 * reviewId is an opaque string provided by the harness.
 *
 * BrainstormReviewRegistry provides put/get/consume lifecycle — an
 * envelope can be consumed at most once, enforcing at-most-once
 * processing of brainstorm reviews.
 */
// ─── Envelope interface ────────────────────────────────────────────

export interface BrainstormReviewEnvelope {
	readonly reviewId: string;
	readonly topicId: string;
	readonly inputHash: `sha256:${string}`;
	readonly context: string;
	readonly rules: string;
	readonly createdAt: string;
}

// ─── Registry ──────────────────────────────────────────────────────

/**
 * At-most-once registry for BrainstormReviewEnvelopes.
 *
 * An envelope can be `consume()`d only once; subsequent calls return
 * undefined. This enforces the "one topic, one review" invariant.
 */
export class BrainstormReviewRegistry {
	#active = new Map<string, BrainstormReviewEnvelope>();

	put(v: BrainstormReviewEnvelope): void {
		this.#active.set(v.reviewId, v);
	}

	get(id: string): BrainstormReviewEnvelope | undefined {
		return this.#active.get(id);
	}

	consume(id: string): BrainstormReviewEnvelope | undefined {
		const v = this.#active.get(id);
		if (v) {
			this.#active.delete(id);
		}
		return v;
	}
}
