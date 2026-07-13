export interface BackpressureQueueConfig {
	maxSize: number;
	storagePath: string;
	perProducerQuota: number;
	restartRecovery: boolean;
}

export interface TriggerEvent {
	trigger: string;
	reviewKind: string;
	body: Record<string, unknown>;
	meta: {
		source: string;
		sessionId?: string;
		timestamp: string;
		fingerprint: string;
	};
}

export interface TriggerProducer {
	readonly trigger: string;
	readonly label: string;
	readonly enabled: boolean;
	start(): Promise<void>;
	stop(): Promise<void>;
	on(event: "produce" | "error", handler: (...args: unknown[]) => void): void;
}

export interface ContextInjector {
	inject(trigger: string): string[];
}
