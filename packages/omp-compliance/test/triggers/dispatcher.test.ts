import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher } from "../../src/triggers/dispatcher";
import { BackpressureQueue } from "../../src/triggers/backpressure-queue";
import { createContextInjector } from "../../src/triggers/context-injector";
import type { TriggerEvent } from "../../src/triggers/types";

function makeEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
	return {
		trigger: "manual",
		reviewKind: "compliance",
		body: {},
		meta: {
			source: "test",
			fingerprint: "fp-default",
			timestamp: new Date().toISOString(),
			...(overrides.meta ?? {}),
		},
		...overrides,
	};
}

describe("Dispatcher", () => {
	it("deduplicates same fingerprint within window", async () => {
		const dir = join(tmpdir(), `d-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const q = new BackpressureQueue({ maxSize: 10, storagePath: dir, perProducerQuota: 5, restartRecovery: false });
		await q.start();
		let calls = 0;
		const d = new Dispatcher({
			queue: q,
			contextInjector: createContextInjector(),
			requestReview: async () => { calls++; return { status: "accepted", reviewId: "r" }; },
		});
		const e1 = makeEvent({ trigger: "scheduled", meta: { source: "cron", fingerprint: "fp1", timestamp: new Date().toISOString() } });
		const e2 = makeEvent({ trigger: "scheduled", meta: { source: "cron", fingerprint: "fp1", timestamp: new Date().toISOString() } });

		const r1 = await d.dispatch(e1);
		expect(r1.accepted).toBe(true);

		const r2 = await d.dispatch(e2);
		expect(r2.accepted).toBe(true); // deduped — still returns accepted
		expect(r2.reason).toBe("deduped");
		expect(calls).toBe(1); // only first triggered a review
		rmSync(dir, { recursive: true, force: true });
	});

	it("routes different fingerprints in FIFO order", async () => {
		const dir = join(tmpdir(), `d2-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const q = new BackpressureQueue({ maxSize: 10, storagePath: dir, perProducerQuota: 5, restartRecovery: false });
		await q.start();
		const reviews: string[] = [];
		const d = new Dispatcher({
			queue: q,
			contextInjector: createContextInjector(),
			requestReview: async (req) => { reviews.push(req.trigger); return { status: "accepted", reviewId: req.reviewId }; },
		});
		const e1 = makeEvent({ trigger: "scheduled", meta: { source: "cron", fingerprint: "s1", timestamp: new Date().toISOString() } });
		const e2 = makeEvent({ trigger: "file_change", meta: { source: "watcher", fingerprint: "f1", timestamp: new Date().toISOString() } });
		await d.dispatch(e1);
		await d.dispatch(e2);
		expect(reviews).toEqual(["scheduled", "file_change"]);
		rmSync(dir, { recursive: true, force: true });
	});
});
