import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import { buildReviewDedupeKey } from "../../src/scheduler/dedupe-key";
import type { ReviewIntentInput } from "../../src/scheduler/review-intent";
import {
	JsonFileReviewSchedulerStore,
	type ReviewDedupeArchive,
	ReviewScheduler,
	type ReviewSchedulerState,
	type ReviewSchedulerStore,
} from "../../src/scheduler/review-scheduler";

class FakeClock {
	nowMs = Date.parse("2026-07-18T00:00:00.000Z");
	now = (): number => this.nowMs;
	advance(ms: number): void {
		this.nowMs += ms;
	}
}

class MemoryStore implements ReviewSchedulerStore {
	state: ReviewSchedulerState | undefined;
	async load(): Promise<ReviewSchedulerState | undefined> {
		return structuredClone(this.state);
	}
	async save(state: ReviewSchedulerState): Promise<void> {
		this.state = structuredClone(state);
	}
}

function intent(overrides: Partial<ReviewIntentInput> = {}): ReviewIntentInput {
	return {
		trigger: "file_change",
		priority: 40,
		projectId: "project-a",
		taskId: "task-a",
		contractHash: "sha256:contract-a",
		evidenceRevision: "evidence-7",
		gitHead: "abc123",
		diffHash: "sha256:diff-a",
		metadata: { source: "test" },
		...overrides,
	};
}

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected test value to be defined");
	return value;
}

function terminal(
	reviewId: string,
	type: "advisor_run_completed" | "advisor_run_failed" | "advisor_run_cancelled",
	verdictSubmitted = true,
): AdvisorReviewLifecycleEvent {
	const base = {
		reviewId,
		trigger: "compliance_review",
		priority: 100,
		primarySessionId: "primary",
		advisorSessionId: "advisor",
		timestamp: "2026-07-18T00:00:01.000Z",
	};
	if (type === "advisor_run_completed") return { ...base, type, verdictSubmitted };
	if (type === "advisor_run_failed") {
		return { ...base, type, failureClass: "provider", errorSummary: "provider unavailable" };
	}
	return { ...base, type, reason: "runtime reset" };
}

function harness(
	options: {
		receipts?: AdvisorReviewReceipt[];
		store?: ReviewSchedulerStore;
		random?: () => number;
		maxQueueSize?: number;
		nonceSource?: () => string;
		requester?: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
		clock?: FakeClock;
		requestTimeout?: (delayMs: number, signal: AbortSignal) => Promise<void>;
		dedupeArchive?: ReviewDedupeArchive;
	} = {},
) {
	const clock = options.clock ?? new FakeClock();
	const requests: AdvisorReviewRequest[] = [];
	const receipts = [...(options.receipts ?? [])];
	const store = options.store ?? new MemoryStore();
	const scheduler = new ReviewScheduler({
		clock,
		random: options.random ?? (() => 0.5),
		store,
		maxQueueSize: options.maxQueueSize,
		nonceSource: options.nonceSource,
		requestTimeout: options.requestTimeout,
		dedupeArchive: options.dedupeArchive,
		requester:
			options.requester ??
			(async (request) => {
				requests.push(structuredClone(request));
				return receipts.shift() ?? { reviewId: request.reviewId, status: "accepted" };
			}),
	});
	return { clock, requests, scheduler, store };
}

describe("ReviewScheduler", () => {
	it("dispatches priority 100 before 80 and never preempts the accepted in-flight review", async () => {
		const { scheduler, requests } = harness();
		await scheduler.enqueue(
			intent({ trigger: "brainstorm_review", priority: 80, topicId: "topic-a", taskId: undefined }),
		);
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));

		await scheduler.pump();
		expect(requests.map((request) => request.priority)).toEqual([100]);
		const active = scheduler.snapshot().inFlight;
		expect(active?.status).toBe("in_flight");

		await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		await scheduler.pump();
		expect(requests).toHaveLength(1);

		await scheduler.handleLifecycle(terminal(defined(active).reviewId, "advisor_run_completed"));
		await scheduler.pump();
		expect(requests[1]?.priority).toBe(80);
	});

	it("uses a stable SHA-256 key over every review identity field", () => {
		const base = intent({ trigger: "brainstorm_review", taskId: undefined, topicId: "topic-a" });
		const key = buildReviewDedupeKey(base);
		expect(key).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(buildReviewDedupeKey({ ...base, metadata: { ignored: true } })).toBe(key);

		for (const changed of [
			{ trigger: "manual_review" },
			{ projectId: "project-b" },
			{ topicId: "topic-b" },
			{ contractHash: "sha256:contract-b" },
			{ evidenceRevision: "evidence-8" },
			{ gitHead: "def456" },
			{ diffHash: "sha256:diff-b" },
			{ taskAttempt: 2 },
		]) {
			expect(buildReviewDedupeKey({ ...base, ...changed })).not.toBe(key);
		}
	});

	it("keeps task attempt separate from scheduler review attempt", async () => {
		const { requests, scheduler } = harness();
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100, taskAttempt: 7 }));
		await scheduler.pump();
		expect(requests[0]?.metadata?.attempt).toBe(7);
		expect(requests[0]?.metadata?.reviewAttempt).toBe(1);
	});

	it("deduplicates stable intents, lets impact absorb file change, and force nonce creates a new manual request", async () => {
		const { scheduler } = harness();
		const first = await scheduler.enqueue(intent());
		const duplicate = await scheduler.enqueue(intent({ metadata: { changed: "but not identity" } }));
		expect(first.kind).toBe("enqueued");
		expect(duplicate.kind).toBe("deduplicated");

		const impact = await scheduler.enqueue(intent({ trigger: "impact_analysis", priority: 60 }));
		expect(impact.kind).toBe("enqueued");
		expect(scheduler.snapshot().queued.map((item) => item.trigger)).toEqual(["impact_analysis"]);
		const absorbed = await scheduler.enqueue(intent({ trigger: "file_change", priority: 40 }));
		expect(absorbed.kind).toBe("deduplicated");
		const fresh = harness().scheduler;
		await fresh.enqueue(intent({ trigger: "impact_analysis", priority: 60 }));
		expect((await fresh.enqueue(intent({ trigger: "file_change", priority: 40 }))).kind).toBe("absorbed");

		const nonceValues = ["one", "two"];
		const forced = harness({ nonceSource: () => defined(nonceValues.shift()) }).scheduler;
		const manualOne = await forced.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		const manualTwo = await forced.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		expect(manualOne.intent.dedupeKey).not.toBe(manualTwo.intent.dedupeKey);
		expect(manualOne.intent.baseDedupeKey).toBe(manualTwo.intent.baseDedupeKey);
	});

	it("allows impact analysis to replace an absorbed file change at queue capacity", async () => {
		const { scheduler } = harness({ maxQueueSize: 1 });
		await scheduler.enqueue(intent({ trigger: "file_change", priority: 40 }));
		await expect(scheduler.enqueue(intent({ trigger: "impact_analysis", priority: 60 }))).resolves.toMatchObject({
			kind: "enqueued",
		});
		expect(scheduler.snapshot().queued.map((item) => item.trigger)).toEqual(["impact_analysis"]);
	});

	it("keeps accepted in flight until a lifecycle terminal and retries failures at 5s, 10s, and 20s", async () => {
		const { clock, requests, scheduler } = harness({ random: () => 0 });
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await scheduler.pump();
		const reviewId = defined(requests[0]).reviewId;
		expect(scheduler.snapshot().inFlight?.reviewId).toBe(reviewId);

		clock.advance(60_000);
		await scheduler.pump();
		expect(requests).toHaveLength(1);

		await scheduler.handleLifecycle(terminal(reviewId, "advisor_run_failed"));
		let stalled = defined(scheduler.snapshot().queued[0]);
		expect(stalled.status).toBe("stalled");
		expect(stalled.notBefore).toBe(clock.now() + 5_000);
		await scheduler.pump();
		expect(requests).toHaveLength(1);

		clock.advance(5_000);
		await scheduler.pump();
		await scheduler.handleLifecycle(terminal(defined(requests[1]).reviewId, "advisor_run_cancelled"));
		stalled = defined(scheduler.snapshot().queued[0]);
		expect(stalled.notBefore).toBe(clock.now() + 10_000);

		clock.advance(10_000);
		await scheduler.pump();
		await scheduler.handleLifecycle(terminal(defined(requests[2]).reviewId, "advisor_run_failed"));
		stalled = defined(scheduler.snapshot().queued[0]);
		expect(stalled.notBefore).toBe(clock.now() + 20_000);
		expect(stalled.status).not.toBe("failed");
	});

	it("requeues rejected receipts with controllable jitter and caps exponential delay at five minutes", async () => {
		const receipts = Array.from({ length: 8 }, (_, index) => ({
			reviewId: `ignored-${index}`,
			status: "rejected" as const,
			reason: "busy",
		}));
		const { clock, scheduler } = harness({ receipts, random: () => 1 });
		await scheduler.enqueue(intent());

		for (let attempt = 1; attempt <= 8; attempt++) {
			const before = clock.now();
			await scheduler.pump();
			const queued = defined(scheduler.snapshot().queued[0]);
			const base = Math.min(5_000 * 2 ** (attempt - 1), 300_000);
			expect(queued.notBefore).toBe(before + Math.round(base * 1.2));
			expect(queued.status).toBe("stalled");
			clock.advance(queued.notBefore - clock.now());
		}
	});

	it("falls back to deterministic retry timing when the random source is non-finite", async () => {
		const { clock, scheduler } = harness({
			receipts: [{ reviewId: "ignored", status: "rejected" }],
			random: () => Number.NaN,
		});
		await scheduler.enqueue(intent());
		await scheduler.pump();
		expect(scheduler.snapshot().queued[0]?.notBefore).toBe(clock.now() + 5_000);
	});

	it("persists due work and recovers a previous in-flight request without sleeping", async () => {
		const store = new MemoryStore();
		const first = harness({ store });
		await first.scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await first.scheduler.pump();
		expect(store.state?.inFlight).toBeDefined();

		const restored = harness({ store });
		await restored.scheduler.restore();
		expect(restored.scheduler.snapshot().inFlight).toBeUndefined();
		expect(restored.scheduler.snapshot().queued[0]).toMatchObject({
			status: "stalled",
			notBefore: restored.clock.now(),
		});
		await restored.scheduler.pump();
		expect(restored.requests).toHaveLength(1);
	});

	it("persists completed work with a terminal status and rejects forged persisted statuses", async () => {
		const completedStore = new MemoryStore();
		const completed = harness({ store: completedStore });
		await completed.scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await completed.scheduler.pump();
		const reviewId = defined(completed.scheduler.snapshot().inFlight).reviewId;
		await completed.scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"));
		expect(completedStore.state?.completed[0]?.status).toBe("completed");

		const forgedStore = new MemoryStore();
		forgedStore.state = structuredClone(completedStore.state);
		(defined(forgedStore.state).completed[0] as { status: string }).status = "forged";
		const restored = harness({ store: forgedStore });
		await expect(restored.scheduler.restore()).rejects.toThrow("invalid persisted review intent");
	});

	it("rejects resource exhaustion, oversized strings, and oversized metadata", async () => {
		const { scheduler } = harness({ maxQueueSize: 2 });
		await scheduler.enqueue(intent({ taskId: "one" }));
		await scheduler.enqueue(intent({ taskId: "two" }));
		await expect(scheduler.enqueue(intent({ taskId: "three" }))).rejects.toThrow("capacity");
		await expect(scheduler.enqueue(intent({ projectId: "x".repeat(257) }))).rejects.toThrow("projectId");
		const available = harness().scheduler;
		await expect(
			available.enqueue(intent({ trigger: "manual_review", priority: 80, force: false })),
		).resolves.toBeDefined();
		await expect(scheduler.enqueue(intent({ metadata: { payload: "x".repeat(33_000) } }))).rejects.toThrow("metadata");
	});

	it("does not let an in-flight impact analysis absorb a later file change", async () => {
		const { scheduler } = harness();
		await scheduler.enqueue(intent({ trigger: "impact_analysis", priority: 60 }));
		await scheduler.pump();
		const result = await scheduler.enqueue(intent({ trigger: "file_change", priority: 40 }));
		expect(result.kind).toBe("enqueued");
		expect(scheduler.snapshot().queued).toHaveLength(1);
	});

	it("stalls completed runs without a verdict and retries without a business limit", async () => {
		const { clock, scheduler } = harness({ random: () => 0 });
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await scheduler.pump();
		const active = defined(scheduler.snapshot().inFlight);
		await scheduler.handleLifecycle(terminal(active.reviewId, "advisor_run_completed", false));
		expect(scheduler.snapshot().completed).toHaveLength(0);
		expect(scheduler.snapshot().queued[0]).toMatchObject({ status: "stalled", notBefore: clock.now() + 5_000 });
	});

	it("validates trigger priorities and generates manual force nonces internally", async () => {
		const nonces = ["nonce-a", "nonce-b"];
		const { scheduler } = harness({ nonceSource: () => defined(nonces.shift()) });
		await expect(scheduler.enqueue(intent({ trigger: "unknown", priority: 40 }))).rejects.toThrow("trigger");
		await expect(scheduler.enqueue(intent({ trigger: "compliance_review", priority: 80 }))).rejects.toThrow("priority");
		await expect(scheduler.enqueue(intent({ trigger: "file_change", priority: 40, force: true }))).rejects.toThrow(
			"force",
		);
		const first = await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		const second = await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		expect(first.intent.forceNonce).toBe("nonce-a");
		expect(second.intent.forceNonce).toBe("nonce-b");
	});

	it("dispatches equal-priority due work by creation order, not notBefore order", async () => {
		const clock = new FakeClock();
		const { scheduler, requests } = harness({ clock });
		await scheduler.enqueue(intent({ taskId: "older" }));
		clock.advance(1);
		await scheduler.enqueue(intent({ taskId: "newer" }));
		const state = scheduler.snapshot();
		const older = defined(state.queued.find((item) => item.taskId === "older"));
		const newer = defined(state.queued.find((item) => item.taskId === "newer"));
		const store = new MemoryStore();
		store.state = {
			...state,
			queued: [
				{ ...older, notBefore: clock.now() },
				{ ...newer, notBefore: clock.now() - 1 },
			],
		};
		const restored = harness({ store, clock });
		await restored.scheduler.restore();
		await restored.scheduler.pump();
		expect(restored.requests[0]?.metadata?.taskId).toBe("older");
		expect(requests).toHaveLength(0);
	});

	it("does not resurrect a terminal review when requester rejection races lifecycle completion", async () => {
		let rejectRequest: ((reason: Error) => void) | undefined;
		const requester = () =>
			new Promise<AdvisorReviewReceipt>((_resolve, reject) => {
				rejectRequest = reject;
			});
		const { scheduler } = harness({ requester });
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		const pumping = scheduler.pump();
		while (!scheduler.snapshot().inFlight) await Promise.resolve();
		const reviewId = defined(scheduler.snapshot().inFlight).reviewId;
		await scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"));
		defined(rejectRequest)(new Error("late rejection"));
		await pumping;
		expect(scheduler.snapshot()).toMatchObject({ queued: [], inFlight: undefined });
		expect(scheduler.snapshot().completed).toHaveLength(1);
	});

	it("serializes persistence so an older snapshot cannot overwrite a newer enqueue", async () => {
		let releaseFirst: (() => void) | undefined;
		let saves = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		const store: ReviewSchedulerStore & { state?: ReviewSchedulerState } = {
			async load() {
				return structuredClone(this.state);
			},
			async save(state) {
				saves++;
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				if (saves === 1) {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				this.state = structuredClone(state);
				concurrent--;
			},
		};
		const { scheduler } = harness({ store });
		const one = scheduler.enqueue(intent({ taskId: "one" }));
		while (!releaseFirst) await Promise.resolve();
		const two = scheduler.enqueue(intent({ taskId: "two" }));
		defined(releaseFirst)();
		await Promise.all([one, two]);
		expect(maxConcurrent).toBe(1);
		expect(store.state?.queued).toHaveLength(2);
	});

	it("keeps a permanent dedupe ledger after completed history compaction", async () => {
		const { scheduler } = harness();
		const firstInput = intent({ taskId: "task-0" });
		for (let index = 0; index < 257; index++) {
			await scheduler.enqueue(intent({ taskId: `task-${index}` }));
			await scheduler.pump();
			const reviewId = defined(scheduler.snapshot().inFlight).reviewId;
			await scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"));
		}
		expect(scheduler.snapshot().completed).toHaveLength(256);
		expect((await scheduler.enqueue(firstInput)).kind).toBe("deduplicated");
	});

	it("rejects accessor, proxy, toJSON and mutable nested metadata", async () => {
		const { scheduler } = harness();
		const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "x" });
		await expect(scheduler.enqueue(intent({ metadata: accessor }))).rejects.toThrow("metadata");
		await expect(scheduler.enqueue(intent({ metadata: new Proxy({}, {}) }))).rejects.toThrow("metadata");
		await expect(scheduler.enqueue(intent({ metadata: { toJSON: () => "forged" } }))).rejects.toThrow("metadata");
		const result = await scheduler.enqueue(intent({ metadata: { nested: { value: "original" } } }));
		const nested = result.intent.metadata?.nested as { value: string };
		expect(() => {
			nested.value = "changed";
		}).toThrow();
		expect((scheduler.snapshot().queued[0]?.metadata?.nested as { value: string }).value).toBe("original");
		expect(() => (scheduler.snapshot().queued as ReviewIntentInput[]).push(intent())).toThrow();
	});

	it("restores atomically and rejects duplicate keys or forged derived review IDs", async () => {
		const store = new MemoryStore();
		const { scheduler } = harness({ store });
		await scheduler.enqueue(intent({ taskId: "valid" }));
		const before = scheduler.snapshot();
		const duplicate = defined(store.state?.queued[0]);
		store.state = { ...defined(store.state), queued: [duplicate, duplicate] };
		await expect(scheduler.restore()).rejects.toThrow("duplicate");
		expect(scheduler.snapshot()).toEqual(before);
		store.state = { ...defined(store.state), queued: [{ ...duplicate, reviewId: "review:forged:0" }] };
		await expect(scheduler.restore()).rejects.toThrow("reviewId");
		expect(scheduler.snapshot()).toEqual(before);
	});

	it("rejects non-finite clocks and oversized persisted state files", async () => {
		const invalidClock = new FakeClock();
		invalidClock.nowMs = Number.NaN;
		const { scheduler } = harness({ clock: invalidClock });
		await expect(scheduler.enqueue(intent())).rejects.toThrow("clock");

		const directory = await mkdtemp(join(tmpdir(), "omp-review-store-"));
		try {
			const path = join(directory, "state.json");
			await writeFile(path, "x".repeat(8 * 1024 * 1024 + 1));
			await expect(new JsonFileReviewSchedulerStore(path).load()).rejects.toThrow("size");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed without losing work when retry time arithmetic overflows", async () => {
		const nearLimit = new FakeClock();
		nearLimit.nowMs = Number.MAX_SAFE_INTEGER;
		const overflow = harness({
			clock: nearLimit,
			receipts: [{ reviewId: "rejected", status: "rejected" }],
			random: () => 0,
		});
		await overflow.scheduler.enqueue(intent());
		await expect(overflow.scheduler.pump()).rejects.toThrow("retry time");
		expect(overflow.scheduler.snapshot().inFlight).toBeDefined();
	});

	it("releases a never-settling requester on lifecycle completion and dispatches the next item", async () => {
		const requests: AdvisorReviewRequest[] = [];
		let timeout: (() => void) | undefined;
		const { scheduler } = harness({
			requester: (request) => {
				requests.push(request);
				if (request.metadata?.taskId === "second") {
					return Promise.resolve({ reviewId: request.reviewId, status: "accepted" });
				}
				return new Promise<AdvisorReviewReceipt>(() => undefined);
			},
			requestTimeout: () =>
				new Promise<void>((resolve) => {
					timeout = resolve;
				}),
		});
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100, taskId: "first" }));
		await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, taskId: "second" }));
		const pumping = scheduler.pump();
		while (!requests[0]) await Promise.resolve();
		await scheduler.handleLifecycle(terminal(defined(requests[0]).reviewId, "advisor_run_completed"));
		await pumping;
		expect(requests.map((request) => request.metadata?.taskId)).toEqual(["first", "second"]);
		defined(timeout)();
	});

	it("times out a silent requester without sleeping and ignores its late receipt", async () => {
		let resolveRequest: ((receipt: AdvisorReviewReceipt) => void) | undefined;
		let expire: (() => void) | undefined;
		const { scheduler } = harness({
			requester: (_request) =>
				new Promise<AdvisorReviewReceipt>((resolve) => {
					resolveRequest = resolve;
				}),
			requestTimeout: () =>
				new Promise<void>((resolve) => {
					expire = resolve;
				}),
		});
		await scheduler.enqueue(intent());
		const pumping = scheduler.pump();
		while (!expire) await Promise.resolve();
		defined(expire)();
		await pumping;
		expect(scheduler.snapshot().queued[0]?.status).toBe("stalled");
		const timedOut = defined(scheduler.snapshot().queued[0]);
		defined(resolveRequest)({ reviewId: timedOut.reviewId, status: "accepted" });
		await Promise.resolve();
		expect(scheduler.snapshot().queued[0]?.status).toBe("stalled");
	});

	it("rejects duplicate sequences, allows cancellation gaps, and requires nextSequence above every live sequence", async () => {
		const store = new MemoryStore();
		const seeded = harness({ store });
		await seeded.scheduler.enqueue(intent({ taskId: "one" }));
		await seeded.scheduler.enqueue(intent({ taskId: "two" }));
		const state = defined(store.state);
		const [one, two] = state.queued;
		store.state = { ...state, queued: [defined(one), { ...defined(two), sequence: defined(one).sequence }] };
		await expect(harness({ store }).scheduler.restore()).rejects.toThrow("sequence");
		store.state = { ...state, nextSequence: state.nextSequence + 1 };
		await expect(harness({ store }).scheduler.restore()).resolves.toBeUndefined();
		store.state = { ...state, nextSequence: defined(two).sequence };
		await expect(harness({ store }).scheduler.restore()).rejects.toThrow("nextSequence");
	});

	it("rejects root intent accessors, proxies, arrays, and non-plain prototypes without invoking getters", async () => {
		const { scheduler } = harness();
		let reads = 0;
		const accessor = Object.defineProperty(intent(), "trigger", {
			enumerable: true,
			get: () => {
				reads++;
				return "file_change";
			},
		});
		await expect(scheduler.enqueue(accessor)).rejects.toThrow("plain object");
		expect(reads).toBe(0);
		await expect(scheduler.enqueue(new Proxy(intent(), {}) as ReviewIntentInput)).rejects.toThrow("plain object");
		await expect(scheduler.enqueue([] as unknown as ReviewIntentInput)).rejects.toThrow("plain object");
		await expect(
			scheduler.enqueue(Object.assign(Object.create({ inherited: true }), intent()) as ReviewIntentInput),
		).rejects.toThrow("plain object");
	});

	it("applies runtime nonce bounds while restoring forced review intents", async () => {
		const store = new MemoryStore();
		const seeded = harness({ store, nonceSource: () => "valid-nonce" });
		await seeded.scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, force: true }));
		const state = defined(store.state);
		const queued = defined(state.queued[0]);
		store.state = { ...state, queued: [{ ...queued, forceNonce: "x".repeat(257) }] };
		await expect(harness({ store }).scheduler.restore()).rejects.toThrow("nonce");
	});

	it("archives compacted dedupe keys without losing permanent duplicate detection", async () => {
		const keys = new Set<string>();
		const batches: Array<{ reason: string; keys: readonly string[] }> = [];
		const archive: ReviewDedupeArchive = {
			async has(key) {
				return keys.has(key);
			},
			async archive(batch) {
				batches.push(batch);
				for (const key of batch.keys) keys.add(key);
				return { archiveId: `archive-${batches.length}` };
			},
		};
		const { scheduler } = harness({ dedupeArchive: archive });
		const firstInput = intent({ taskId: "archived-first" });
		for (let index = 0; index < 257; index++) {
			await scheduler.enqueue(intent({ taskId: index === 0 ? "archived-first" : `archive-${index}` }));
			await scheduler.pump();
			await scheduler.handleLifecycle(
				terminal(defined(scheduler.snapshot().inFlight).reviewId, "advisor_run_completed"),
			);
		}
		const receipt = await scheduler.archiveDedupeLedger("季度去重账本归档");
		expect(receipt).toMatchObject({ archiveId: "archive-1", archivedCount: 1, reason: "季度去重账本归档" });
		expect((await scheduler.enqueue(firstInput)).kind).toBe("deduplicated");
	});

	it("rolls an in-flight transition back to queued when persistence fails", async () => {
		let saves = 0;
		let requests = 0;
		const store: ReviewSchedulerStore = {
			load: async () => undefined,
			async save() {
				saves++;
				if (saves === 2) throw new Error("disk down");
			},
		};
		const { scheduler } = harness({
			store,
			requester: async (request) => {
				requests++;
				return { reviewId: request.reviewId, status: "accepted" };
			},
		});
		await scheduler.enqueue(intent());
		await expect(scheduler.pump()).rejects.toThrow("disk down");
		expect(requests).toBe(0);
		expect(scheduler.snapshot()).toMatchObject({ inFlight: undefined });
		expect(scheduler.snapshot().queued).toHaveLength(1);
	});

	it("rolls an enqueue completely back when persistence fails and allows a clean retry", async () => {
		let rejectNextSave = true;
		const store = new MemoryStore();
		const originalSave = store.save.bind(store);
		store.save = async (state) => {
			if (rejectNextSave) {
				rejectNextSave = false;
				throw new Error("disk down");
			}
			await originalSave(state);
		};
		const { scheduler } = harness({ store });
		await expect(scheduler.enqueue(intent())).rejects.toThrow("disk down");
		expect(scheduler.snapshot()).toEqual({
			version: 2,
			queued: [],
			completed: [],
			dedupeLedger: [],
			nextSequence: 0,
		});

		const retried = await scheduler.enqueue(intent());
		expect(retried).toMatchObject({ kind: "enqueued", intent: { sequence: 0 } });
		expect(store.state).toEqual(scheduler.snapshot());
	});

	it("rolls lifecycle state and its waiter back when persistence fails, then restarts consistently", async () => {
		let saves = 0;
		let failLifecycleSave = true;
		const store = new MemoryStore();
		const originalSave = store.save.bind(store);
		store.save = async (state) => {
			saves++;
			if (saves === 3 && failLifecycleSave) throw new Error("disk down");
			await originalSave(state);
		};
		const { scheduler } = harness({
			store,
			requester: () => new Promise<AdvisorReviewReceipt>(() => undefined),
			requestTimeout: () => new Promise<void>(() => undefined),
		});
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		const pumping = scheduler.pump();
		while (!store.state?.inFlight) await Promise.resolve();
		const reviewId = defined(scheduler.snapshot().inFlight).reviewId;
		const persistedBeforeFailure = structuredClone(store.state);

		await expect(scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"))).rejects.toThrow("disk down");
		expect(scheduler.snapshot()).toEqual(persistedBeforeFailure);
		expect(store.state).toEqual(persistedBeforeFailure);

		const restored = harness({ store });
		await restored.scheduler.restore();
		expect(restored.scheduler.snapshot()).toMatchObject({ inFlight: undefined });
		expect(restored.scheduler.snapshot().queued).toHaveLength(1);
		expect(restored.scheduler.snapshot().queued[0]?.status).toBe("stalled");

		failLifecycleSave = false;
		await scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"));
		await pumping;
		expect(scheduler.snapshot().completed).toHaveLength(1);
	});

	it("automatically dispatches the next due review after a persisted lifecycle terminal", async () => {
		const { requests, scheduler } = harness();
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100, taskId: "first" }));
		await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, taskId: "second" }));
		await scheduler.pump();
		expect(requests.map((request) => request.metadata?.taskId)).toEqual(["first"]);

		await scheduler.handleLifecycle(terminal(defined(requests[0]).reviewId, "advisor_run_completed"));
		expect(requests.map((request) => request.metadata?.taskId)).toEqual(["first", "second"]);
	});

	it("restores a completed review to in-flight for a downstream commit compensation", async () => {
		const { scheduler } = harness();
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await scheduler.pump();
		const reviewId = defined(scheduler.snapshot().inFlight).reviewId;

		await scheduler.handleLifecycle(terminal(reviewId, "advisor_run_completed"), false);
		expect(scheduler.snapshot().completed.map((item) => item.reviewId)).toContain(reviewId);

		await scheduler.restoreCompleted(reviewId);
		expect(scheduler.snapshot().completed.map((item) => item.reviewId)).not.toContain(reviewId);
		expect(scheduler.snapshot().inFlight?.reviewId).toBe(reviewId);
	});

	it("abandons an interrupted review and releases its dedupe identity for recovery", async () => {
		const { scheduler } = harness();
		const input = intent({ trigger: "compliance_review", priority: 100, taskAttempt: 1 });
		await scheduler.enqueue(input);
		await scheduler.pump();
		const reviewId = defined(scheduler.snapshot().inFlight).reviewId;

		expect(await scheduler.abandonReview(reviewId)).toBe(true);
		expect(scheduler.snapshot().inFlight).toBeUndefined();
		expect((await scheduler.enqueue(input)).kind).toBe("enqueued");
	});

	it("restores a scheduler snapshot after an in-flight review is abandoned", async () => {
		const store = new MemoryStore();
		const seeded = harness({ store });
		await seeded.scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100 }));
		await seeded.scheduler.pump();
		const reviewId = defined(seeded.scheduler.snapshot().inFlight).reviewId;

		await seeded.scheduler.abandonReview(reviewId);
		const restored = harness({ store });
		await expect(restored.scheduler.restore()).resolves.toBeUndefined();
		expect(restored.scheduler.snapshot().inFlight).toBeUndefined();
	});

	it("cancels every queued or in-flight compliance review for one task while preserving completed history", async () => {
		const { scheduler } = harness();
		await scheduler.enqueue(intent({ trigger: "compliance_review", priority: 100, taskId: "target", taskAttempt: 1 }));
		await scheduler.pump();
		await scheduler.enqueue(
			intent({
				trigger: "compliance_review",
				priority: 100,
				taskId: "target",
				taskAttempt: 2,
				evidenceRevision: "evidence-8",
			}),
		);
		await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, taskId: "other" }));

		expect(await scheduler.cancelTask("target", "compliance_review")).toBe(2);
		expect(scheduler.snapshot().inFlight).toBeUndefined();
		expect(scheduler.snapshot().queued.map((item) => item.taskId)).toEqual(["other"]);
	});

	it("saturates the retry counter without ever stopping retries", async () => {
		const store = new MemoryStore();
		const seeded = harness({ store });
		await seeded.scheduler.enqueue(intent());
		const state = defined(store.state);
		const queued = defined(state.queued[0]);
		store.state = {
			...state,
			queued: [
				{
					...queued,
					status: "stalled",
					attempt: Number.MAX_SAFE_INTEGER,
					reviewId: `review:${queued.dedupeKey.slice("sha256:".length)}:${Number.MAX_SAFE_INTEGER}`,
				},
			],
		};
		const { clock, scheduler } = harness({
			store,
			random: () => 0,
			receipts: [{ reviewId: "ignored", status: "rejected" }],
		});
		await scheduler.restore();
		await scheduler.pump();
		expect(scheduler.snapshot().queued[0]).toMatchObject({
			attempt: Number.MAX_SAFE_INTEGER,
			status: "stalled",
			notBefore: clock.now() + 300_000,
		});
	});
});
