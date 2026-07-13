import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackpressureQueue } from "../../src/triggers/backpressure-queue";
import type { BackpressureQueueConfig, TriggerEvent } from "../../src/triggers/types";

function makeEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
	return {
		trigger: "test-trigger",
		reviewKind: "manual",
		body: { key: "value" },
		meta: {
			source: "test",
			timestamp: new Date().toISOString(),
			fingerprint: randomUUID(),
			...(overrides.meta ?? {}),
		},
		...overrides,
	};
}

async function withQueue(
	config: Partial<BackpressureQueueConfig>,
	fn: (q: BackpressureQueue) => Promise<void>,
) {
	const storagePath = join(tmpdir(), `omp-bp-test-${randomUUID()}`);
	mkdirSync(storagePath, { recursive: true });
	const cfg: BackpressureQueueConfig = {
		maxSize: 10,
		storagePath,
		perProducerQuota: 5,
		restartRecovery: false,
		...config,
	};
	const q = new BackpressureQueue(cfg);
	try {
		await q.start();
		await fn(q);
	} finally {
		await q.stop();
		await rm(storagePath, { recursive: true, force: true });
	}
}

describe("BackpressureQueue", () => {
	it("rejects enqueue when maxSize exceeded", async () => {
		await withQueue({ maxSize: 3 }, async (q) => {
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());
			expect(q.size).toBe(3);
			await expect(q.enqueue("producer-a", makeEvent())).rejects.toThrow(/queue.*full|max.*size|limit/i);
		});
	});

	it("rejects enqueue when perProducerQuota exceeded", async () => {
		await withQueue({ perProducerQuota: 2 }, async (q) => {
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());
			expect(q.size).toBe(2);
			await expect(q.enqueue("producer-a", makeEvent())).rejects.toThrow(/quota|producer.*limit/i);
			await expect(q.enqueue("producer-b", makeEvent())).resolves.toBeUndefined();
			expect(q.size).toBe(3);
		});
	});

	it("returns events in FIFO order via reserveNext + ack", async () => {
		await withQueue({}, async (q) => {
			const e1 = makeEvent({ body: { seq: 1 } });
			const e2 = makeEvent({ body: { seq: 2 } });
			await q.enqueue("p", e1);
			await q.enqueue("p", e2);
			const r1 = await q.reserveNext();
			expect(r1?.event).toBe(e1);
			await q.ack(r1!.id);
			const r2 = await q.reserveNext();
			expect(r2?.event).toBe(e2);
			await q.ack(r2!.id);
		});
	});

	it("returns undefined when reserving from empty queue", async () => {
		await withQueue({}, async (q) => {
			expect(await q.reserveNext()).toBeUndefined();
		});
	});

	it("persists items to disk and recovers on restart", async () => {
		const storagePath = join(tmpdir(), `omp-bp-restart-${randomUUID()}`);
		mkdirSync(storagePath, { recursive: true });
		const cfg: BackpressureQueueConfig = {
			maxSize: 20,
			storagePath,
			perProducerQuota: 10,
			restartRecovery: true,
		};

		const q1 = new BackpressureQueue(cfg);
		await q1.start();
		await q1.enqueue("p", makeEvent({ body: { idx: 1 } }));
		await q1.enqueue("p", makeEvent({ body: { idx: 2 } }));
		// Stop WITHOUT acking — simulates crash
		await q1.stop();

		const files = readdirSync(storagePath).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);

		const q2 = new BackpressureQueue(cfg);
		await q2.start();
		try {
			expect(q2.size).toBe(2);
			const r1 = await q2.reserveNext();
			expect(r1?.event.body).toEqual({ idx: 1 });
			const r2 = await q2.reserveNext();
			expect(r2?.event.body).toEqual({ idx: 2 });
		} finally {
			await q2.stop();
			await rm(storagePath, { recursive: true, force: true });
		}
	});

	it("recovers reserved-but-unacked items as re-queued", async () => {
		const storagePath = join(tmpdir(), `omp-bp-reserved-${randomUUID()}`);
		mkdirSync(storagePath, { recursive: true });
		const cfg: BackpressureQueueConfig = {
			maxSize: 10,
			storagePath,
			perProducerQuota: 5,
			restartRecovery: true,
		};
		const q1 = new BackpressureQueue(cfg);
		await q1.start();
		await q1.enqueue("p", makeEvent({ body: { idx: 1 } }));
		await q1.reserveNext(); // reserved but not acked
		await q1.stop(); // crash before ack

		const q2 = new BackpressureQueue(cfg);
		await q2.start();
		try {
			expect(q2.size).toBe(1); // re-queued
			const r = await q2.reserveNext();
			expect(r?.event.body).toEqual({ idx: 1 });
		} finally {
			await q2.stop();
			await rm(storagePath, { recursive: true, force: true });
		}
	});

	it("tracks reserved count toward capacity", async () => {
		await withQueue({ maxSize: 2 }, async (q) => {
			await q.enqueue("p", makeEvent());
			await q.enqueue("p", makeEvent());
			expect(q.size).toBe(2);
			const r = await q.reserveNext();
			expect(r).toBeDefined();
			// reserved counts toward maxSize — 1 queued + 1 reserved = full
			await expect(q.enqueue("p", makeEvent())).rejects.toThrow(/full/i);
			await q.ack(r!.id);
			// now 1 queued + 0 reserved = 1 slot free
			await expect(q.enqueue("p", makeEvent())).resolves.toBeUndefined();
		});
	});

	it("starts empty when restartRecovery is false", async () => {
		await withQueue({ restartRecovery: false }, async (q) => {
			expect(q.size).toBe(0);
		});
	});

	it("writes WAL file to storagePath", async () => {
		const storagePath = join(tmpdir(), `omp-bp-dir-${randomUUID()}`);
		mkdirSync(storagePath, { recursive: true });
		const cfg: BackpressureQueueConfig = { maxSize: 10, storagePath, perProducerQuota: 5, restartRecovery: true };
		const q = new BackpressureQueue(cfg);
		await q.start();
		await q.enqueue("p", makeEvent());
		await q.stop();
		expect(existsSync(join(storagePath, "wal.jsonl"))).toBe(true);
		await rm(storagePath, { recursive: true, force: true });
	});
});
