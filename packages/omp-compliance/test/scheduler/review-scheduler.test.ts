import { describe, expect, it } from "bun:test";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import { buildReviewDedupeKey } from "../../src/scheduler/dedupe-key";
import type { ReviewIntentInput } from "../../src/scheduler/review-intent";
import {
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
		priority: 20,
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
): AdvisorReviewLifecycleEvent {
	const base = {
		reviewId,
		trigger: "compliance_review",
		priority: 100,
		primarySessionId: "primary",
		advisorSessionId: "advisor",
		timestamp: "2026-07-18T00:00:01.000Z",
	};
	if (type === "advisor_run_completed") return { ...base, type, verdictSubmitted: true };
	if (type === "advisor_run_failed") {
		return { ...base, type, failureClass: "provider", errorSummary: "provider unavailable" };
	}
	return { ...base, type, reason: "runtime reset" };
}

function harness(
	options: {
		receipts?: AdvisorReviewReceipt[];
		store?: MemoryStore;
		random?: () => number;
		maxQueueSize?: number;
	} = {},
) {
	const clock = new FakeClock();
	const requests: AdvisorReviewRequest[] = [];
	const receipts = [...(options.receipts ?? [])];
	const store = options.store ?? new MemoryStore();
	const scheduler = new ReviewScheduler({
		clock,
		random: options.random ?? (() => 0.5),
		store,
		maxQueueSize: options.maxQueueSize,
		requester: async (request) => {
			requests.push(structuredClone(request));
			return receipts.shift() ?? { reviewId: request.reviewId, status: "accepted" };
		},
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

		await scheduler.enqueue(intent({ trigger: "manual_review", priority: 120, forceNonce: "manual-1" }));
		await scheduler.pump();
		expect(requests).toHaveLength(1);

		await scheduler.handleLifecycle(terminal(defined(active).reviewId, "advisor_run_completed"));
		await scheduler.pump();
		expect(requests[1]?.priority).toBe(120);
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
		]) {
			expect(buildReviewDedupeKey({ ...base, ...changed })).not.toBe(key);
		}
	});

	it("deduplicates stable intents, lets impact absorb file change, and force nonce creates a new manual request", async () => {
		const { scheduler } = harness();
		const first = await scheduler.enqueue(intent());
		const duplicate = await scheduler.enqueue(intent({ metadata: { changed: "but not identity" } }));
		expect(first.kind).toBe("enqueued");
		expect(duplicate.kind).toBe("deduplicated");

		const impact = await scheduler.enqueue(intent({ trigger: "impact_analysis", priority: 40 }));
		expect(impact.kind).toBe("enqueued");
		expect(scheduler.snapshot().queued.map((item) => item.trigger)).toEqual(["impact_analysis"]);
		const absorbed = await scheduler.enqueue(intent({ trigger: "file_change", priority: 20 }));
		expect(absorbed.kind).toBe("absorbed");

		const manualOne = await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, forceNonce: "one" }));
		const manualTwo = await scheduler.enqueue(intent({ trigger: "manual_review", priority: 80, forceNonce: "two" }));
		expect(manualOne.intent.dedupeKey).not.toBe(manualTwo.intent.dedupeKey);
	});

	it("allows impact analysis to replace an absorbed file change at queue capacity", async () => {
		const { scheduler } = harness({ maxQueueSize: 1 });
		await scheduler.enqueue(intent({ trigger: "file_change", priority: 20 }));
		await expect(scheduler.enqueue(intent({ trigger: "impact_analysis", priority: 40 }))).resolves.toMatchObject({
			kind: "enqueued",
		});
		expect(scheduler.snapshot().queued.map((item) => item.trigger)).toEqual(["impact_analysis"]);
	});

	it("keeps accepted in flight until a lifecycle terminal and retries failures at 5s, 10s, and 20s", async () => {
		const { clock, requests, scheduler } = harness({ random: () => 0.5 });
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
			expect(queued.notBefore).toBe(before + Math.min(Math.round(base * 1.2), 300_000));
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
		await expect(scheduler.enqueue(intent({ trigger: "manual_review", forceNonce: "" }))).rejects.toThrow("forceNonce");
		await expect(scheduler.enqueue(intent({ metadata: { payload: "x".repeat(33_000) } }))).rejects.toThrow("metadata");
	});
});
