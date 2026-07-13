import type { TriggerProducer } from "./types";

export class TriggerRegistry {
	private readonly producers = new Map<string, TriggerProducer>();

	register(producer: TriggerProducer): void {
		this.producers.set(producer.trigger, producer);
	}

	async startAll(): Promise<void> {
		for (const producer of this.producers.values()) {
			if (producer.enabled) await producer.start();
		}
	}

	async stopAll(): Promise<void> {
		for (const producer of this.producers.values()) {
			await producer.stop();
		}
	}

	get registered(): string[] {
		return [...this.producers.keys()];
	}
}
