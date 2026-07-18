import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { types as utilTypes } from "node:util";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import { buildForcedReviewDedupeKey, buildReviewDedupeKey } from "./dedupe-key";
import { REVIEW_RETRY_MAX_ATTEMPT, reviewRetryDelayMs } from "./retry-policy";
import {
	REVIEW_INTENT_MAX_STRING_LENGTH,
	type ReviewIntent,
	type ReviewIntentInput,
	normalizeReviewIntentInput,
	sameReviewScope,
} from "./review-intent";

const STATE_VERSION = 2 as const;
const DEFAULT_MAX_QUEUE_SIZE = 256;
const MAX_COMPLETED_HISTORY = 256;
const MAX_DEDUPE_LEDGER_SIZE = 50_000;
const DEFAULT_REQUEST_RECEIPT_TIMEOUT_MS = 30_000;
export const MAX_REVIEW_SCHEDULER_STATE_BYTES = 8 * 1024 * 1024;

export interface ReviewSchedulerClock {
	now(): number;
}

export interface ReviewSchedulerState {
	readonly version: typeof STATE_VERSION;
	readonly queued: readonly ReviewIntent[];
	readonly inFlight?: ReviewIntent;
	readonly completed: readonly ReviewIntent[];
	readonly dedupeLedger: readonly string[];
	readonly nextSequence: number;
}

export interface ReviewSchedulerStore {
	load(): Promise<ReviewSchedulerState | undefined>;
	save(state: ReviewSchedulerState): Promise<void>;
}

export interface ReviewDedupeArchiveBatch {
	readonly reason: string;
	readonly archivedAt: number;
	readonly keys: readonly string[];
}

export interface ReviewDedupeArchive {
	has(key: string): Promise<boolean>;
	archive(batch: ReviewDedupeArchiveBatch): Promise<{ readonly archiveId: string }>;
}

export interface ReviewDedupeArchiveReceipt {
	readonly archiveId: string;
	readonly archivedCount: number;
	readonly reason: string;
	readonly archivedAt: number;
}

export class JsonFileReviewSchedulerStore implements ReviewSchedulerStore {
	constructor(private readonly path: string) {}

	async load(): Promise<ReviewSchedulerState | undefined> {
		try {
			const details = await stat(this.path);
			if (details.size > MAX_REVIEW_SCHEDULER_STATE_BYTES) {
				throw new Error(`review scheduler state size exceeds ${MAX_REVIEW_SCHEDULER_STATE_BYTES} bytes`);
			}
			return JSON.parse(await readFile(this.path, "utf8")) as ReviewSchedulerState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async save(state: ReviewSchedulerState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const serialized = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(serialized) > MAX_REVIEW_SCHEDULER_STATE_BYTES) {
			throw new Error(`review scheduler state size exceeds ${MAX_REVIEW_SCHEDULER_STATE_BYTES} bytes`);
		}
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
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
	readonly nonceSource?: () => string;
	readonly requestReceiptTimeoutMs?: number;
	readonly requestTimeout?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly dedupeArchive?: ReviewDedupeArchive;
}

function waitForTimeout(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
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

function queueOrder(left: ReviewIntent, right: ReviewIntent): number {
	return right.priority - left.priority || left.createdAt - right.createdAt || left.sequence - right.sequence;
}

function sortQueue(queue: ReviewIntent[]): void {
	queue.sort(queueOrder);
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function frozenClone<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function assertSafeInteger(name: string, value: unknown, minimum = 0): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
	}
}

function safeNow(clock: ReviewSchedulerClock): number {
	const now = clock.now();
	assertSafeInteger("clock", now);
	return now;
}

function safeAddTime(now: number, delay: number): number {
	assertSafeInteger("retry delay", delay);
	const result = now + delay;
	if (!Number.isSafeInteger(result)) throw new Error("retry time exceeds the safe integer range");
	return result;
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(descriptor) => !("get" in descriptor) && !("set" in descriptor),
	);
}

function isSafeArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
		return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) return false;
	const keys = Object.keys(descriptors).filter((key) => key !== "length");
	return (
		keys.length === value.length &&
		keys.every((key) => Number.isSafeInteger(Number(key)) && Number(key) >= 0 && String(Number(key)) === key)
	);
}

function reviewIdFor(dedupeKey: string, attempt: number): string {
	return `review:${dedupeKey.slice("sha256:".length)}:${attempt}`;
}

function validatedNonce(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > REVIEW_INTENT_MAX_STRING_LENGTH ||
		!/^[A-Za-z0-9._:-]+$/.test(value)
	) {
		throw new Error("nonce must be a bounded identifier");
	}
	return value;
}

function boundedArchiveString(name: string, value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > REVIEW_INTENT_MAX_STRING_LENGTH) {
		throw new Error(`${name} must be a bounded non-empty string`);
	}
	return value;
}

export class ReviewScheduler {
	readonly #clock: ReviewSchedulerClock;
	readonly #random: () => number;
	readonly #requester: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	readonly #store: ReviewSchedulerStore;
	readonly #maxQueueSize: number;
	readonly #nonceSource: () => string;
	readonly #requestReceiptTimeoutMs: number;
	readonly #requestTimeout: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly #dedupeArchive: ReviewDedupeArchive | undefined;
	#queued: ReviewIntent[] = [];
	#inFlight: ReviewIntent | undefined;
	#completed: ReviewIntent[] = [];
	#dedupeLedger = new Set<string>();
	#nextSequence = 0;
	#operationTail: Promise<void> = Promise.resolve();
	#pumping: Promise<void> | undefined;
	#lifecycleWaiters = new Map<string, () => void>();

	constructor(options: ReviewSchedulerOptions) {
		this.#clock = options.clock;
		this.#random = options.random;
		this.#requester = options.requester;
		this.#store = options.store;
		this.#nonceSource = options.nonceSource ?? randomUUID;
		this.#requestReceiptTimeoutMs = options.requestReceiptTimeoutMs ?? DEFAULT_REQUEST_RECEIPT_TIMEOUT_MS;
		this.#requestTimeout = options.requestTimeout ?? waitForTimeout;
		this.#dedupeArchive = options.dedupeArchive;
		this.#maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
		if (!Number.isInteger(this.#maxQueueSize) || this.#maxQueueSize < 1 || this.#maxQueueSize > 10_000) {
			throw new Error("maxQueueSize must be an integer between 1 and 10000");
		}
		if (!Number.isSafeInteger(this.#requestReceiptTimeoutMs) || this.#requestReceiptTimeoutMs < 1) {
			throw new Error("requestReceiptTimeoutMs must be a positive safe integer");
		}
	}

	restore(): Promise<void> {
		return this.#serialize(async () => {
			const raw = await this.#store.load();
			if (!raw) return;
			const restored = this.#validateState(raw);
			this.#queued = restored.queued;
			this.#completed = restored.completed;
			this.#dedupeLedger = restored.dedupeLedger;
			this.#nextSequence = restored.nextSequence;
			if (restored.inFlight) {
				const now = safeNow(this.#clock);
				this.#queued.push(Object.freeze({ ...restored.inFlight, status: "stalled", notBefore: now, updatedAt: now }));
			}
			this.#inFlight = undefined;
			sortQueue(this.#queued);
			await this.#persist();
		});
	}

	enqueue(raw: ReviewIntentInput): Promise<ReviewEnqueueResult> {
		return this.#serialize(async () => {
			const input = normalizeReviewIntentInput(raw);
			const baseDedupeKey = buildReviewDedupeKey(input);
			const forceNonce = input.force ? this.#validatedNonce() : undefined;
			const dedupeKey = forceNonce ? buildForcedReviewDedupeKey(baseDedupeKey, forceNonce) : baseDedupeKey;
			const existing = this.#findIntent(dedupeKey);
			if (existing || this.#dedupeLedger.has(dedupeKey) || (await this.#dedupeArchive?.has(dedupeKey))) {
				return frozenClone({
					kind: "deduplicated" as const,
					intent: existing ?? this.#historicalIntent(input, baseDedupeKey, forceNonce, dedupeKey),
				});
			}

			if (input.trigger === "file_change") {
				const impact = this.#queued.find((item) => item.trigger === "impact_analysis" && sameReviewScope(item, input));
				if (impact) return frozenClone({ kind: "absorbed" as const, intent: impact });
			}
			const nextQueue =
				input.trigger === "impact_analysis"
					? this.#queued.filter((item) => item.trigger !== "file_change" || !sameReviewScope(item, input))
					: this.#queued;
			if (nextQueue.length + (this.#inFlight ? 1 : 0) >= this.#maxQueueSize) {
				throw new Error("review queue capacity exceeded");
			}
			if (this.#dedupeLedger.size >= MAX_DEDUPE_LEDGER_SIZE) {
				throw new Error("review dedupe ledger capacity exceeded; explicit archival is required");
			}

			const now = safeNow(this.#clock);
			assertSafeInteger("nextSequence", this.#nextSequence);
			if (this.#nextSequence === Number.MAX_SAFE_INTEGER) throw new Error("review sequence capacity exceeded");
			const next: ReviewIntent = Object.freeze({
				...input,
				baseDedupeKey,
				forceNonce,
				dedupeKey,
				reviewId: reviewIdFor(dedupeKey, 0),
				status: "queued",
				attempt: 0,
				notBefore: now,
				createdAt: now,
				updatedAt: now,
				sequence: this.#nextSequence++,
			});
			this.#queued = nextQueue;
			this.#queued.push(next);
			this.#dedupeLedger.add(dedupeKey);
			sortQueue(this.#queued);
			await this.#persist();
			return frozenClone({ kind: "enqueued" as const, intent: next });
		});
	}

	archiveDedupeLedger(reason: string): Promise<ReviewDedupeArchiveReceipt> {
		return this.#serialize(async () => {
			if (!this.#dedupeArchive) throw new Error("review dedupe archive is not configured");
			const normalizedReason = boundedArchiveString("archive reason", reason);
			const retained = new Set(
				[...this.#queued, ...(this.#inFlight ? [this.#inFlight] : []), ...this.#completed].map(
					(intent) => intent.dedupeKey,
				),
			);
			const keys = [...this.#dedupeLedger].filter((key) => !retained.has(key));
			if (keys.length === 0) throw new Error("review dedupe ledger has no compacted keys to archive");
			const archivedAt = safeNow(this.#clock);
			const result = await this.#dedupeArchive.archive(
				frozenClone({ reason: normalizedReason, archivedAt, keys }),
			);
			const archiveId = boundedArchiveString("archiveId", result?.archiveId);
			const previousLedger = this.#dedupeLedger;
			this.#dedupeLedger = new Set([...previousLedger].filter((key) => retained.has(key)));
			try {
				await this.#persist();
			} catch (error) {
				this.#dedupeLedger = previousLedger;
				throw error;
			}
			return Object.freeze({ archiveId, archivedCount: keys.length, reason: normalizedReason, archivedAt });
		});
	}

	pump(): Promise<void> {
		if (this.#pumping) return this.#pumping;
		this.#pumping = this.#pumpUntilBlocked().finally(() => {
			this.#pumping = undefined;
		});
		return this.#pumping;
	}

	handleLifecycle(event: AdvisorReviewLifecycleEvent): Promise<void> {
		return this.#serialize(async () => {
			if (!isTerminal(event) || event.reviewId !== this.#inFlight?.reviewId) return;
			const active = this.#inFlight;
			if (event.type === "advisor_run_completed" && event.verdictSubmitted) {
				const completed = Object.freeze({ ...active, status: "completed" as const, updatedAt: safeNow(this.#clock) });
				this.#inFlight = undefined;
				this.#completed.push(completed);
				this.#completed = this.#completed.slice(-MAX_COMPLETED_HISTORY);
			} else {
				const stalled = this.#stall(active);
				this.#inFlight = undefined;
				this.#queued.push(stalled);
				sortQueue(this.#queued);
			}
			await this.#persist();
			this.#lifecycleWaiters.get(event.reviewId)?.();
		});
	}

	snapshot(): ReviewSchedulerState {
		return frozenClone(this.#state());
	}

	async #pumpUntilBlocked(): Promise<void> {
		while (await this.#pumpOnce()) {
			// A lifecycle terminal released a silent request; dispatch the next due item.
		}
	}

	async #pumpOnce(): Promise<boolean> {
		const candidate = await this.#serialize(async () => {
			if (this.#inFlight) return undefined;
			const now = safeNow(this.#clock);
			const due = this.#queued.filter((item) => item.notBefore <= now).sort(queueOrder);
			const queued = due[0];
			if (!queued) return undefined;
			const attempt = queued.attempt + 1;
			if (!Number.isSafeInteger(attempt) || attempt > REVIEW_RETRY_MAX_ATTEMPT) {
				throw new Error("review attempt capacity exceeded");
			}
			const index = this.#queued.findIndex((item) => item.dedupeKey === queued.dedupeKey);
			if (index < 0) return undefined;
			const previousQueue = this.#queued;
			const previousInFlight = this.#inFlight;
			this.#queued = this.#queued.filter((_, queuedIndex) => queuedIndex !== index);
			const active: ReviewIntent = Object.freeze({
				...queued,
				attempt,
				reviewId: reviewIdFor(queued.dedupeKey, attempt),
				status: "in_flight",
				updatedAt: now,
			});
			this.#inFlight = active;
			try {
				await this.#persist();
			} catch (error) {
				this.#queued = previousQueue;
				this.#inFlight = previousInFlight;
				throw error;
			}
			return active;
		});
		if (!candidate) return false;

		const abortTimeout = new AbortController();
		const lifecycle = new Promise<{ kind: "lifecycle" }>((resolve) => {
			this.#lifecycleWaiters.set(candidate.reviewId, () => resolve({ kind: "lifecycle" }));
		});
		const request = this.#requester(requestFor(candidate)).then(
			(receipt) => ({ kind: "receipt" as const, receipt }),
			() => ({ kind: "request_failed" as const }),
		);
		const timeout = this.#requestTimeout(this.#requestReceiptTimeoutMs, abortTimeout.signal).then(() => ({
			kind: "timeout" as const,
		}));
		const outcome = await Promise.race([request, lifecycle, timeout]);
		abortTimeout.abort();
		this.#lifecycleWaiters.delete(candidate.reviewId);
		if (outcome.kind === "lifecycle") return true;
		const receipt = outcome.kind === "receipt" ? outcome.receipt : undefined;
		await this.#serialize(async () => {
			if (this.#inFlight?.reviewId !== candidate.reviewId) return;
			if (receipt?.status === "accepted" && receipt.reviewId === candidate.reviewId) return;
			const stalled = this.#stall(candidate);
			this.#inFlight = undefined;
			this.#queued.push(stalled);
			sortQueue(this.#queued);
			await this.#persist();
		});
		return false;
	}

	#stall(intent: ReviewIntent): ReviewIntent {
		const now = safeNow(this.#clock);
		const notBefore = safeAddTime(now, reviewRetryDelayMs(intent.attempt, this.#random));
		return Object.freeze({ ...intent, status: "stalled", notBefore, updatedAt: now });
	}

	#validatedNonce(): string {
		return validatedNonce(this.#nonceSource());
	}

	#findIntent(dedupeKey: string): ReviewIntent | undefined {
		return [...this.#queued, ...(this.#inFlight ? [this.#inFlight] : []), ...this.#completed].find(
			(item) => item.dedupeKey === dedupeKey,
		);
	}

	#historicalIntent(
		input: ReviewIntentInput,
		baseDedupeKey: string,
		forceNonce: string | undefined,
		dedupeKey: string,
	): ReviewIntent {
		return Object.freeze({
			...input,
			baseDedupeKey,
			forceNonce,
			dedupeKey,
			reviewId: reviewIdFor(dedupeKey, 0),
			status: "completed",
			attempt: 0,
			notBefore: 0,
			createdAt: 0,
			updatedAt: 0,
			sequence: 0,
		});
	}

	#validateState(raw: ReviewSchedulerState): {
		queued: ReviewIntent[];
		inFlight?: ReviewIntent;
		completed: ReviewIntent[];
		dedupeLedger: Set<string>;
		nextSequence: number;
	} {
		if (!isPlainDataObject(raw) || raw.version !== STATE_VERSION) throw new Error("invalid review scheduler state");
		if (!isSafeArray(raw.queued) || !isSafeArray(raw.completed) || !isSafeArray(raw.dedupeLedger)) {
			throw new Error("invalid review scheduler state arrays");
		}
		if (raw.queued.length + (raw.inFlight ? 1 : 0) > this.#maxQueueSize) {
			throw new Error("persisted review queue exceeds capacity");
		}
		if (raw.completed.length > MAX_COMPLETED_HISTORY || raw.dedupeLedger.length > MAX_DEDUPE_LEDGER_SIZE) {
			throw new Error("persisted review history exceeds capacity");
		}
		assertSafeInteger("persisted nextSequence", raw.nextSequence);

		const queued = raw.queued.map((item) => this.#validatePersistedIntent(item, ["queued", "stalled"]));
		const completed = raw.completed.map((item) => this.#validatePersistedIntent(item, ["completed"]));
		const inFlight = raw.inFlight ? this.#validatePersistedIntent(raw.inFlight, ["in_flight"]) : undefined;
		const all = [...queued, ...(inFlight ? [inFlight] : []), ...completed];
		const intentKeys = new Set<string>();
		const sequences = new Set<number>();
		for (const item of all) {
			if (intentKeys.has(item.dedupeKey)) throw new Error("duplicate persisted review dedupeKey");
			intentKeys.add(item.dedupeKey);
			if (sequences.has(item.sequence)) throw new Error("duplicate persisted review sequence");
			sequences.add(item.sequence);
		}
		const ledger = new Set<string>();
		for (const key of raw.dedupeLedger) {
			if (typeof key !== "string" || !/^sha256:[a-f0-9]{64}$/.test(key)) {
				throw new Error("invalid persisted dedupe ledger key");
			}
			if (ledger.has(key)) throw new Error("duplicate persisted dedupe ledger key");
			ledger.add(key);
		}
		for (const key of intentKeys) {
			if (!ledger.has(key)) throw new Error("persisted intent is missing from dedupe ledger");
		}
		const maximumSequence = all.reduce((maximum, item) => Math.max(maximum, item.sequence), -1);
		if (raw.nextSequence !== maximumSequence + 1) throw new Error("persisted nextSequence is inconsistent");
		return { queued, inFlight, completed, dedupeLedger: ledger, nextSequence: raw.nextSequence };
	}

	#validatePersistedIntent(raw: unknown, allowedStatuses: readonly ReviewIntent["status"][]): ReviewIntent {
		if (!isPlainDataObject(raw)) throw new Error("invalid persisted review intent");
		const candidate = raw as unknown as ReviewIntent;
		const input = normalizeReviewIntentInput(candidate);
		if (
			!allowedStatuses.includes(candidate.status) ||
			!Number.isSafeInteger(candidate.attempt) ||
			candidate.attempt < 0 ||
			candidate.attempt > REVIEW_RETRY_MAX_ATTEMPT ||
			!Number.isSafeInteger(candidate.notBefore) ||
			candidate.notBefore < 0 ||
			!Number.isSafeInteger(candidate.createdAt) ||
			candidate.createdAt < 0 ||
			!Number.isSafeInteger(candidate.updatedAt) ||
			candidate.updatedAt < 0 ||
			!Number.isSafeInteger(candidate.sequence) ||
			candidate.sequence < 0
		) {
			throw new Error("invalid persisted review intent");
		}
		const baseDedupeKey = buildReviewDedupeKey(input);
		const forceNonce = candidate.forceNonce === undefined ? undefined : validatedNonce(candidate.forceNonce);
		if (
			candidate.baseDedupeKey !== baseDedupeKey ||
			(input.force ? typeof forceNonce !== "string" || forceNonce.length === 0 : forceNonce !== undefined)
		) {
			throw new Error("invalid persisted review dedupe identity");
		}
		const dedupeKey = forceNonce ? buildForcedReviewDedupeKey(baseDedupeKey, forceNonce) : baseDedupeKey;
		if (candidate.dedupeKey !== dedupeKey) throw new Error("invalid persisted review dedupeKey");
		if (candidate.reviewId !== reviewIdFor(dedupeKey, candidate.attempt)) {
			throw new Error("invalid persisted reviewId");
		}
		return deepFreeze({ ...candidate, ...input, baseDedupeKey, forceNonce, dedupeKey });
	}

	#state(): ReviewSchedulerState {
		return {
			version: STATE_VERSION,
			queued: this.#queued,
			inFlight: this.#inFlight,
			completed: this.#completed,
			dedupeLedger: [...this.#dedupeLedger],
			nextSequence: this.#nextSequence,
		};
	}

	async #persist(): Promise<void> {
		await this.#store.save(frozenClone(this.#state()));
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#operationTail.then(operation, operation);
		this.#operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
