/**
 * ImpactPlanSink — deferred promise registry for impact plans.
 *
 * Callers register with a review id and timeout; the plan arrives later
 * via accept() or reject().  Duplicate accept/reject calls are silently
 * ignored.  Timeout automatically rejects the promise.
 */

export interface ImpactPlan {
	/** Schema version for forward compatibility. */
	schema_version: string;
	/** Modules that are affected by the change. */
	affected_modules: string[];
	/** Tests that are affected by the change. */
	affected_tests: string[];
	/** Commands that the plan suggests should be run. */
	suggested_commands: string[];
}

interface DeferredEntry {
	resolve: (plan: ImpactPlan) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export class ImpactPlanSink {
	#entries = new Map<string, DeferredEntry>();

	/**
	 * Register interest in a review outcome.
	 *
	 * @param reviewId — unique review identifier
	 * @param timeoutMs — milliseconds before auto-rejection
	 * @returns a promise that resolves with the ImpactPlan or rejects on timeout
	 */
	register(reviewId: string, timeoutMs: number): Promise<ImpactPlan> {
		if (this.#entries.has(reviewId)) {
			throw new Error(`Duplicate reviewId: ${reviewId}`);
		}

		return new Promise<ImpactPlan>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#entries.delete(reviewId);
				reject(new Error(`ImpactPlanSink timeout for reviewId: ${reviewId}`));
			}, timeoutMs);

			this.#entries.set(reviewId, { resolve, reject, timer });
		});
	}

	/**
	 * Fulfill a previously registered review with an ImpactPlan.
	 * Silently ignored if the reviewId is unknown or already settled.
	 */
	accept(reviewId: string, plan: ImpactPlan): void {
		const entry = this.#entries.get(reviewId);
		if (!entry) return;

		clearTimeout(entry.timer);
		this.#entries.delete(reviewId);
		entry.resolve(plan);
	}

	/**
	 * Reject a previously registered review with an error reason.
	 * Silently ignored if the reviewId is unknown or already settled.
	 */
	reject(reviewId: string, reason: string): void {
		const entry = this.#entries.get(reviewId);
		if (!entry) return;

		clearTimeout(entry.timer);
		this.#entries.delete(reviewId);
		entry.reject(new Error(reason));
	}
}
