/**
 * BackpressureQueue — a bounded FIFO queue with per-producer quotas and
 * optional disk persistence for restart recovery.
 */

import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackpressureQueueConfig, TriggerEvent } from "./types";

// ─── Internal types ─────────────────────────────────────────────────

interface StoredItem {
	id: string;
	producer: string;
	event: TriggerEvent;
}

const QUEUE_FILE = "queue.jsonl";

// ─── BackpressureQueue ──────────────────────────────────────────────

export class BackpressureQueue {
	private readonly _queue: StoredItem[] = [];
	private readonly _producerCounts = new Map<string, number>();
	private _started = false;
	private _disposed = false;

	constructor(private readonly _config: BackpressureQueueConfig) {}

	// ─── Public API ──────────────────────────────────────────────────

	/** Number of items currently queued. */
	get size(): number {
		return this._queue.length;
	}

	/**
	 * Start the queue. If restartRecovery is enabled, load any previously
	 * persisted items from disk.
	 */
	async start(): Promise<void> {
		if (this._started) return;
		this._started = true;

		if (this._config.restartRecovery) {
			await this._loadFromDisk();
		}
	}

	/**
	 * Stop the queue. Persist all queued items to disk for later recovery.
	 */
	async stop(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		await this._persistToDisk();
	}

	/**
	 * Enqueue a trigger event from the given producer.
	 *
	 * Rejects with an error if:
	 * - the queue is at maxSize capacity,
	 * - the producer has exceeded perProducerQuota items.
	 */
	async enqueue(producer: string, event: TriggerEvent): Promise<void> {
		this._assertRunning();

		if (this._queue.length >= this._config.maxSize) {
			throw new Error(
				`BackpressureQueue full: maxSize=${this._config.maxSize}`,
			);
		}

		const current = this._producerCounts.get(producer) ?? 0;
		if (current >= this._config.perProducerQuota) {
			throw new Error(
				`Producer "${producer}" exceeded quota: ${this._config.perProducerQuota}`,
			);
		}

		const item: StoredItem = {
			id: crypto.randomUUID(),
			producer,
			event,
		};

		this._queue.push(item);
		this._producerCounts.set(producer, current + 1);
	}

	/**
	 * Dequeue the oldest event. Returns undefined if the queue is empty.
	 */
	async dequeue(): Promise<TriggerEvent | undefined> {
		this._assertRunning();
		const item = this._queue.shift();
		if (!item) return undefined;

		const current = this._producerCounts.get(item.producer) ?? 1;
		if (current <= 1) {
			this._producerCounts.delete(item.producer);
		} else {
			this._producerCounts.set(item.producer, current - 1);
		}

		return item.event;
	}

	// ─── Private helpers ─────────────────────────────────────────────

	private _assertRunning(): void {
		if (!this._started) {
			throw new Error("BackpressureQueue not started");
		}
		if (this._disposed) {
			throw new Error("BackpressureQueue already stopped");
		}
	}

	private async _persistToDisk(): Promise<void> {
		const dir = this._config.storagePath;
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const filePath = join(dir, QUEUE_FILE);

		// Write all items as newline-delimited JSON
		const lines = this._queue.map((item) => JSON.stringify(item)).join("\n");
		await writeFile(filePath, lines + "\n", "utf-8");
	}

	private async _loadFromDisk(): Promise<void> {
		const filePath = join(this._config.storagePath, QUEUE_FILE);
		if (!existsSync(filePath)) return;

		const raw = await readFile(filePath, "utf-8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);

		for (const line of lines) {
			try {
				const item = JSON.parse(line) as StoredItem;
				this._queue.push(item);
				const current = this._producerCounts.get(item.producer) ?? 0;
				this._producerCounts.set(item.producer, current + 1);
			} catch {
				// Skip malformed lines
			}
		}

		// Remove the file once loaded to avoid double-load
		await unlink(filePath).catch(() => {});
	}
}
