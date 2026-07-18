import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import { buildReviewDedupeKey } from "./dedupe-key";
import { reviewRetryDelayMs } from "./retry-policy";
import {
	type ReviewIntent,
	type ReviewIntentInput,
	normalizeReviewIntentInput,
	sameReviewScope,
} from "./review-intent";

const STATE_VERSION = 1 as const;
const DEFAULT_MAX_QUEUE_SIZE = 256;
const MAX_COMPLETED_HISTORY = 256;

export interface ReviewSchedulerClock {
	now(): number;
}

export interface ReviewSchedulerState {
	readonly version: typeof STATE_VERSION;
	readonly queued: readonly ReviewIntent[];
	readonly inFlight?: ReviewIntent;
	readonly completed: readonly ReviewIntent[];
}

export interface ReviewSchedulerStore {
	load(): Promise<ReviewSchedulerState | undefined>;
	save(state: ReviewSchedulerState): Promise<void>;
}

export class JsonFileReviewSchedulerStore implements ReviewSchedulerStore {
	constructor(private readonly path: string) {}

	async load(): Promise<ReviewSchedulerState | undefined> {
		try {
			return JSON.parse(await readFile(this.path, "utf8")) as ReviewSchedulerState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async save(state: ReviewSchedulerState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.path);
	}
}

export type ReviewEnqueueResult = {
	readonly kind: "enqueued" | "deduplicated" | "absorbed";
	readonly intent: ReviewIntent;
};

export interface ReviewSchedulerOptions {
	readonly clock: ReviewSchedulerClock;
	readonly random: () => number;
	readonly requester: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	readonly store: ReviewSchedulerStore;
	readonly maxQueueSize?: number;
}

function isTerminal(event: AdvisorReviewLifecycleEvent): boolean {
	return (
		event.type === "advisor_run_completed" ||
		event.type === "advisor_run_failed" ||
		event.type === "advisor_run_cancelled"
	);
}

function requestFor(intent: ReviewIntent): AdvisorReviewRequest {
	return {
		reviewId: intent.reviewId,
		trigger: intent.trigger,
		priority: intent.priority,
		dedupeKey: intent.dedupeKey,
		metadata: {
			...(intent.metadata ?? {}),
			projectId: intent.projectId,
			taskId: intent.taskId,
			topicId: intent.topicId,
			contractHash: intent.contractHash,
			evidenceRevision: intent.evidenceRevision,
			gitHead: intent.gitHead,
			diffHash: intent.diffHash,
			attempt: intent.attempt,
		},
	};
}

function sortQueue(queue: ReviewIntent[]): void {
	queue.sort(
		(left, right) =>
			right.priority - left.priority || left.notBefore - right.notBefore || left.createdAt - right.createdAt,
	);
}

export class ReviewScheduler {
	readonly #clock: ReviewSchedulerClock;
	readonly #random: () => number;
	readonly #requester: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	readonly #store: ReviewSchedulerStore;
	readonly #maxQueueSize: number;
	#queued: ReviewIntent[] = [];
	#inFlight: ReviewIntent | undefined;
	#completed: ReviewIntent[] = [];
	#pumping: Promise<void> | undefined;

	constructor(options: ReviewSchedulerOptions) {
		this.#clock = options.clock;
		this.#random = options.random;
		this.#requester = options.requester;
		this.#store = options.store;
		this.#maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		if (!Number.isInteger(this.#maxQueueSize) || this.#maxQueueSize < 1 || this.#maxQueueSize > 10_000) {
			throw new Error("maxQueueSize must be an integer between 1 and 10000");
		}
	}

	async restore(): Promise<void> {
		const state = await this.#store.load();
		if (!state) return;
		if (state.version !== STATE_VERSION || !Array.isArray(state.queued) || !Array.isArray(state.completed)) {
			throw new Error("invalid review scheduler state");
		}
		if (state.queued.length + (state.inFlight ? 1 : 0) > this.#maxQueueSize) {
			throw new Error("persisted review queue exceeds capacity");
		}
		if (state.completed.length > MAX_COMPLETED_HISTORY) {
			throw new Error("persisted completed review history exceeds capacity");
		}
		this.#queued = state.queued.map((item) => this.#validatePersistedIntent(item, ["queued", "stalled"]));
		this.#completed = state.completed
			.slice(-MAX_COMPLETED_HISTORY)
			.map((item) => this.#validatePersistedIntent(item, ["completed"]));
		if (state.inFlight) {
			const interrupted = this.#validatePersistedIntent(state.inFlight, ["in_flight"]);
			this.#queued.push({
				...interrupted,
				status: "stalled",
				notBefore: this.#clock.now(),
				updatedAt: this.#clock.now(),
			});
		}
		sortQueue(this.#queued);
		await this.#persist();
	}

	async enqueue(raw: ReviewIntentInput): Promise<ReviewEnqueueResult> {
		const input = normalizeReviewIntentInput(raw);
		const dedupeKey = buildReviewDedupeKey(input);
		const existing = [...this.#queued, ...(this.#inFlight ? [this.#inFlight] : []), ...this.#completed].find(
			(item) => item.dedupeKey === dedupeKey,
		);
		if (existing) return { kind: "deduplicated", intent: existing };

		if (input.trigger === "file_change") {
			const impact = [...this.#queued, ...(this.#inFlight ? [this.#inFlight] : [])].find(
				(item) => item.trigger === "impact_analysis" && sameReviewScope(item, input),
			);
			if (impact) return { kind: "absorbed", intent: impact };
		}
		const nextQueue =
			input.trigger === "impact_analysis"
				? this.#queued.filter((item) => item.trigger !== "file_change" || !sameReviewScope(item, input))
				: this.#queued;
		if (nextQueue.length + (this.#inFlight ? 1 : 0) >= this.#maxQueueSize) {
			throw new Error("review queue capacity exceeded");
		}

		this.#queued = nextQueue;
		const now = this.#clock.now();
		const next: ReviewIntent = {
			...input,
			dedupeKey,
			reviewId: this.#reviewId(dedupeKey, 0),
			status: "queued",
			attempt: 0,
			notBefore: now,
			createdAt: now,
			updatedAt: now,
		};
		this.#queued.push(next);
		sortQueue(this.#queued);
		await this.#persist();
		return { kind: "enqueued", intent: next };
	}

	pump(): Promise<void> {
		if (this.#pumping) return this.#pumping;
		this.#pumping = this.#pumpOnce().finally(() => {
			this.#pumping = undefined;
		});
		return this.#pumping;
	}

	async handleLifecycle(event: AdvisorReviewLifecycleEvent): Promise<void> {
		if (!isTerminal(event) || event.reviewId !== this.#inFlight?.reviewId) return;
		const active = this.#inFlight;
		this.#inFlight = undefined;
		if (event.type === "advisor_run_completed") {
			this.#completed.push({ ...active, status: "completed", updatedAt: this.#clock.now() });
			this.#completed = this.#completed.slice(-MAX_COMPLETED_HISTORY);
		} else {
			this.#queued.push(this.#stall(active));
			sortQueue(this.#queued);
		}
		await this.#persist();
	}

	snapshot(): ReviewSchedulerState {
		return structuredClone({
			version: STATE_VERSION,
			queued: this.#queued,
			inFlight: this.#inFlight,
			completed: this.#completed,
		});
	}

	async #pumpOnce(): Promise<void> {
		if (this.#inFlight) return;
		sortQueue(this.#queued);
		const index = this.#queued.findIndex((item) => item.notBefore <= this.#clock.now());
		if (index < 0) return;
		const queued = this.#queued.splice(index, 1)[0];
		if (!queued) return;
		const attempt = queued.attempt + 1;
		const candidate: ReviewIntent = {
			...queued,
			attempt,
			reviewId: this.#reviewId(queued.dedupeKey, attempt),
			status: "in_flight",
			updatedAt: this.#clock.now(),
		};
		this.#inFlight = candidate;
		await this.#persist();

		let receipt: AdvisorReviewReceipt;
		try {
			receipt = await this.#requester(requestFor(candidate));
		} catch {
			this.#inFlight = undefined;
			this.#queued.push(this.#stall(candidate));
			sortQueue(this.#queued);
			await this.#persist();
			return;
		}
		if (receipt.status !== "accepted" || receipt.reviewId !== candidate.reviewId) {
			this.#inFlight = undefined;
			this.#queued.push(this.#stall(candidate));
			sortQueue(this.#queued);
		}
		await this.#persist();
	}

	#stall(intent: ReviewIntent): ReviewIntent {
		const now = this.#clock.now();
		return {
			...intent,
			status: "stalled",
			notBefore: now + reviewRetryDelayMs(intent.attempt, this.#random),
			updatedAt: now,
		};
	}

	#reviewId(dedupeKey: string, attempt: number): string {
		return `review:${dedupeKey.slice("sha256:".length)}:${attempt}`;
	}

	#validatePersistedIntent(raw: ReviewIntent, allowedStatuses: readonly ReviewIntent["status"][]): ReviewIntent {
		const input = normalizeReviewIntentInput(raw);
		if (
			!allowedStatuses.includes(raw.status) ||
			!Number.isInteger(raw.attempt) ||
			raw.attempt < 0 ||
			!Number.isFinite(raw.notBefore) ||
			!Number.isFinite(raw.createdAt) ||
			!Number.isFinite(raw.updatedAt) ||
			raw.dedupeKey !== buildReviewDedupeKey(input) ||
			typeof raw.reviewId !== "string" ||
			raw.reviewId.length > 128
		) {
			throw new Error("invalid persisted review intent");
		}
		return { ...raw, ...input };
	}

	async #persist(): Promise<void> {
		await this.#store.save(this.snapshot());
	}
}
