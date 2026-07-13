import type { BackpressureQueue, ContextInjector } from "./types";
import type { TriggerEvent } from "./types";

/**
 * Dedupe window in ms. Same fingerprint within this window is dropped.
 * User-approved policy: "排队等待" for backlog, fingerprint dedup within window.
 */
const DEDUPE_WINDOW_MS = 30_000;

export class Dispatcher {
	private readonly handled = new Map<string, number>();

	constructor(
		private readonly config: {
			queue: BackpressureQueue;
			contextInjector: ContextInjector;
			requestReview: (req: {
				reviewId: string;
				trigger: string;
				metadata?: Record<string, unknown>;
			}) => Promise<{ status: string; reviewId: string; reason?: string }>;
		},
	) {}

	async dispatch(event: TriggerEvent): Promise<{ accepted: boolean; reason?: string }> {
		// Fingerprint dedup: same fingerprint within window → silently drop
		const fp = event.meta.fingerprint;
		if (fp) {
			const last = this.handled.get(fp);
			if (last !== undefined && Date.now() - last < DEDUPE_WINDOW_MS) {
				return { accepted: true, reason: "deduped" };
			}
			this.handled.set(fp, Date.now());
		}

		try {
			await this.config.queue.enqueue(event.meta.source, event);
		} catch (err) {
			return { accepted: false, reason: err instanceof Error ? err.message : "queue_error" };
		}

		// Process one item from the queue
		return this.processNext();
	}

	private async processNext(): Promise<{ accepted: boolean; reason?: string }> {
		const reserved = await this.config.queue.reserveNext();
		if (!reserved) return { accepted: false, reason: "empty_queue" };

		try {
			const ctx = this.config.contextInjector.inject(reserved.event.trigger);
			const receipt = await this.config.requestReview({
				reviewId: `t-${Date.now()}`,
				trigger: reserved.event.trigger,
				metadata: { context: ctx, body: reserved.event.body, source: reserved.event.meta.source },
			});
			if (receipt.status === "accepted") {
				await this.config.queue.ack(reserved.id);
				return { accepted: true };
			}
			await this.config.queue.nack(reserved.id, reserved.event, reserved.producer);
			return { accepted: false, reason: receipt.reason ?? "review_not_accepted" };
		} catch (err) {
			await this.config.queue.nack(reserved.id, reserved.event, reserved.producer);
			return { accepted: false, reason: err instanceof Error ? err.message : "dispatch_error" };
		}
	}
}
