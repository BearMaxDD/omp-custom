import { BaseProducer } from "./base";

export interface ScheduleOptions {
	intervalMs: number;
	label?: string;
}

/**
 * Timer-based scheduled producer.
 *
 * Fires a produce event on a fixed interval using setInterval.
 * start() begins the timer, stop() clears it.
 */
export class ScheduledProducer extends BaseProducer {
	readonly trigger = "scheduled";
	readonly label: string;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	constructor(options: ScheduleOptions, enabled = true) {
		super(enabled);
		this.intervalMs = options.intervalMs;
		this.label = options.label ?? `Every ${this.intervalMs}ms`;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.timer = setInterval(() => {
			this.emitEvent(
				{ intervalMs: this.intervalMs, firedAt: new Date().toISOString() },
				`scheduled-${Date.now()}`,
			);
		}, this.intervalMs);
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
