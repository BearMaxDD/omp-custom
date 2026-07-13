import type { BackpressureQueue, ContextInjector } from "./types";
import type { TriggerEvent } from "./types";

export class Dispatcher {
	private inFlight = new Set<string>();

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
		if (this.inFlight.has(event.trigger)) {
			return { accepted: false, reason: "in_flight" };
		}
		try {
			await this.config.queue.enqueue(event.meta.source, event);
		} catch (err) {
			return { accepted: false, reason: err instanceof Error ? err.message : "queue_error" };
		}
		this.inFlight.add(event.trigger);
		try {
			const reserved = await this.config.queue.reserveNext();
			if (!reserved) {
				this.inFlight.delete(event.trigger);
				return { accepted: false, reason: "empty_queue" };
			}
			const ctx = this.config.contextInjector.inject(reserved.event.trigger);
			const receipt = await this.config.requestReview({
				reviewId: `t-${Date.now()}`,
				trigger: reserved.event.trigger,
				metadata: { context: ctx, body: reserved.event.body, source: reserved.event.meta.source },
			});
			if (receipt.status === "accepted") {
				await this.config.queue.ack(reserved.id);
				this.inFlight.delete(reserved.event.trigger);
				return { accepted: true };
			}
			// Not accepted → nack so it can be retried
			await this.config.queue.nack(reserved.id, reserved.event, reserved.producer);
			this.inFlight.delete(reserved.event.trigger);
			return { accepted: false, reason: receipt.reason ?? "review_not_accepted" };
		} catch (err) {
			this.inFlight.delete(event.trigger);
			return { accepted: false, reason: err instanceof Error ? err.message : "dispatch_error" };
		}
	}
}
