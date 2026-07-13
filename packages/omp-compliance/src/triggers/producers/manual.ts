import { BaseProducer } from "./base";

/**
 * Manual trigger producer.
 *
 * Emits a produce event on demand via fire(body).
 * Useful for testing, CLI invocations, and API-driven triggers.
 */
export class ManualProducer extends BaseProducer {
	readonly trigger = "manual";
	readonly label = "Manual Trigger";

	constructor(enabled = true) {
		super(enabled);
	}

	async start(): Promise<void> {
		// No persistent runtime needed.
	}

	async stop(): Promise<void> {
		// No persistent runtime needed.
	}

	/**
	 * Immediately emit a produce event with the given body.
	 */
	fire(body: Record<string, unknown>): void {
		this.emitEvent(body, `manual-${Date.now()}`);
	}
}
