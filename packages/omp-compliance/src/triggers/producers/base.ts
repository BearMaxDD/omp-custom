import { EventEmitter } from "node:events";
import type { TriggerEvent, TriggerProducer } from "../types";

/**
 * Abstract base shared by all TriggerProducers.
 * Provides EventEmitter-backed emit for "produce" and "error" events
 * so each concrete producer only implements start/stop + domain logic.
 */
export abstract class BaseProducer implements TriggerProducer {
	private readonly emitter = new EventEmitter();
	abstract readonly trigger: string;
	abstract readonly label: string;
	readonly enabled: boolean;
	private readonly _handlerStore = new Map<string, (...args: unknown[]) => void>();

	constructor(enabled = true) {
		this.enabled = enabled;
	}

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;

	on(event: "produce" | "error", handler: (...args: unknown[]) => void): void {
		this._handlerStore.set(event, handler);
		this.emitter.on(event, handler);
	}

	protected emitEvent(body: Record<string, unknown>, fingerprint?: string): void {
		const event: TriggerEvent = {
			trigger: this.trigger,
			reviewKind: "compliance",
			body,
			meta: {
				source: this.trigger,
				timestamp: new Date().toISOString(),
				fingerprint: fingerprint ?? `${this.trigger}-${Date.now()}`,
			},
		};
		this.emitter.emit("produce", event);
	}

	protected emitError(error: Error): void {
		this.emitter.emit("error", error);
	}
}
