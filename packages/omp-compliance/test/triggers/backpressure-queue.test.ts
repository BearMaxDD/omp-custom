import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackpressureQueue } from "../../src/triggers/backpressure-queue";
import type { BackpressureQueueConfig, TriggerEvent } from "../../src/triggers/types";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
	return {
		trigger: "test-trigger",
		reviewKind: "manual",
		body: { key: "value" },
		meta: {
			source: "test",
			timestamp: new Date().toISOString(),
			fingerprint: randomUUID(),
			...overrides.meta,
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

// ─── Tests ───────────────────────────────────────────────────────────

describe("BackpressureQueue", () => {
	it("rejects enqueue when maxSize exceeded", async () => {
		await withQueue({ maxSize: 3 }, async (q) => {
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());

			expect(q.size).toBe(3);
			await expect(q.enqueue("producer-a", makeEvent())).rejects.toThrow(
				/queue.*full|max.*size|limit/i,
			);
		});
	});

	it("rejects enqueue when perProducerQuota exceeded", async () => {
		await withQueue({ perProducerQuota: 2 }, async (q) => {
			await q.enqueue("producer-a", makeEvent());
			await q.enqueue("producer-a", makeEvent());

			expect(q.size).toBe(2);
			await expect(q.enqueue("producer-a", makeEvent())).rejects.toThrow(
				/quota|producer.*limit/i,
			);

			// A different producer can still enqueue
			await expect(q.enqueue("producer-b", makeEvent())).resolves.toBeUndefined();
			expect(q.size).toBe(3);
		});
	});

	it("returns events in FIFO order", async () => {
		await withQueue({}, async (q) => {
			const e1 = makeEvent({ body: { seq: 1 } });
			const e2 = makeEvent({ body: { seq: 2 } });
			const e3 = makeEvent({ body: { seq: 3 } });

			await q.enqueue("producer-a", e1);
			await q.enqueue("producer-b", e2);
			await q.enqueue("producer-a", e3);

			expect(await q.dequeue()).toBe(e1);
			expect(await q.dequeue()).toBe(e2);
			expect(await q.dequeue()).toBe(e3);
		});
	});

	it("returns undefined when dequeuing from empty queue", async () => {
		await withQueue({}, async (q) => {
			expect(await q.dequeue()).toBeUndefined();
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
		const e1 = makeEvent({ body: { idx: 1 } });
		const e2 = makeEvent({ body: { idx: 2 } });
		await q1.enqueue("producer-a", e1);
		await q1.enqueue("producer-b", e2);
		await q1.stop();

		// Verify files were written
		const files = readdirSync(storagePath).filter(
			(f) => f.endsWith(".jsonl") || f.endsWith(".json"),
		);
		expect(files.length).toBeGreaterThan(0);

		// Recover
		const q2 = new BackpressureQueue(cfg);
		await q2.start();
		try {
			expect(q2.size).toBe(2);
			const d1 = await q2.dequeue();
			const d2 = await q2.dequeue();
			expect(d1?.body).toEqual({ idx: 1 });
			expect(d2?.body).toEqual({ idx: 2 });
		} finally {
			await q2.stop();
			await rm(storagePath, { recursive: true, force: true });
		}
	});

	it("starts empty when restartRecovery is false", async () => {
		await withQueue({ restartRecovery: false }, async (q) => {
			expect(q.size).toBe(0);
		});
	});

	it("tracks size correctly across enqueue and dequeue", async () => {
		await withQueue({}, async (q) => {
			expect(q.size).toBe(0);
			await q.enqueue("p", makeEvent());
			expect(q.size).toBe(1);
			await q.enqueue("p", makeEvent());
			expect(q.size).toBe(2);
			await q.dequeue();
			expect(q.size).toBe(1);
			await q.dequeue();
			expect(q.size).toBe(0);
		});
	});

	it("writes persistence files to the storagePath directory", async () => {
		const storagePath = join(tmpdir(), `omp-bp-dir-${randomUUID()}`);
		mkdirSync(storagePath, { recursive: true });
		const cfg: BackpressureQueueConfig = {
			maxSize: 10,
			storagePath,
			perProducerQuota: 5,
			restartRecovery: true,
		};
		const q = new BackpressureQueue(cfg);
		await q.start();
		await q.enqueue("p", makeEvent());
		await q.stop();

		expect(existsSync(join(storagePath, "queue.jsonl"))).toBe(true);
		await rm(storagePath, { recursive: true, force: true });
	});
});
