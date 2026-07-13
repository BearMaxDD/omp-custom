import type { BackpressureQueue, ContextInjector } from "./types";
import type { TriggerEvent } from "./types";

const DEDUPE_WINDOW_MS = 30_000;

export class Dispatcher {
	private readonly handled = new Map<string, number>();
	private processing = false;

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

		if (this.processing) return { accepted: true, reason: "queued" };
		this.processing = true;
		try {
			return await this._drain();
		} finally {
			this.processing = false;
		}
	}
	private async _drain(): Promise<{ accepted: boolean; reason?: string }> {
		let last: { accepted: boolean; reason?: string } = { accepted: true };
		while (true) {
			const reserved = await this.config.queue.reserveNext();
			if (!reserved) break;
			const result = await this._processOne(reserved.id, reserved.event, reserved.producer);
			if (!result.accepted) return result; // stop on failure — don't busy-loop
			last = result;
		}
		return last;
	}

	private async _processOne(
		id: string,
		event: TriggerEvent,
		producer: string,
	): Promise<{ accepted: boolean; reason?: string }> {
		try {
			const ctx = this.config.contextInjector.inject(event.trigger);
			const receipt = await this.config.requestReview({
				reviewId: `t-${Date.now()}`,
				trigger: event.trigger,
				metadata: { context: ctx, body: event.body, source: event.meta.source },
			});
			if (receipt.status === "accepted") {
				await this.config.queue.ack(id);
				return { accepted: true };
			}
			await this.config.queue.nack(id, event, producer);
			return { accepted: false, reason: receipt.reason ?? "review_not_accepted" };
		} catch (err) {
			await this.config.queue.nack(id, event, producer);
			return { accepted: false, reason: err instanceof Error ? err.message : "dispatch_error" };
		}
	}
}
