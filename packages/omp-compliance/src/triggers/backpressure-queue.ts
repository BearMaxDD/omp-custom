/**
 * BackpressureQueue — bounded FIFO with WAL persistence and ack-based delivery.
 *
 * Crash safety via per-mutation WAL:
 *  - enqueue   → append {type:"event", id, status:"queued"}
 *  - reserve   → append {type:"event", id, status:"reserved"}, track producer
 *  - ack       → append {type:"ack", id}, decrement producer count
 *  - nack      → append {type:"event", id, status:"queued"}
 *
 * Recovery folds entries by id (latest wins):
 *   queued → reserved → ack = deleted
 *   queued → reserved (no ack) = re-queued
 *   queued alone = kept
 */
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackpressureQueueConfig, TriggerEvent } from "./types";

interface StoredItem {
	id: string;
	producer: string;
	event: TriggerEvent;
	status: "queued" | "reserved";
}

interface WalEntry {
	type: "event" | "ack";
	id: string;
	producer?: string;
	event?: TriggerEvent;
	status?: "queued" | "reserved";
}

function foldEntries(entries: WalEntry[]): StoredItem[] {
	const latest = new Map<string, WalEntry>();
	for (const entry of entries) {
		if (entry.type === "ack") {
			latest.set(entry.id, entry);
		} else if (entry.type === "event") {
			latest.set(entry.id, entry);
		}
	}
	const result: StoredItem[] = [];
	for (const entry of latest.values()) {
		if (entry.type === "ack") continue;
		if (entry.type === "event" && entry.id && entry.producer && entry.event) {
			result.push({ id: entry.id, producer: entry.producer, event: entry.event, status: "queued" });
		}
	}
	return result;
}

const WAL_FILE = "wal.jsonl";
const WAL_TMP = "wal.tmp.jsonl";

export class BackpressureQueue {
	private readonly _queue: StoredItem[] = [];
	private readonly _config: BackpressureQueueConfig;
	private readonly _producerCounts = new Map<string, number>();
	private readonly _reserved = new Map<string, { producer: string }>();
	private _reservedCount = 0;
	private _walPath: string;
	private _started = false;
	private _disposed = false;

	constructor(config: BackpressureQueueConfig) {
		this._config = config;
		this._walPath = join(config.storagePath, WAL_FILE);
		if (!existsSync(config.storagePath)) {
			mkdirSync(config.storagePath, { recursive: true });
		}
	}

	get size(): number { return this._queue.length; }

	async start(): Promise<void> {
		if (this._started) return;
		this._started = true;
		if (this._config.restartRecovery) await this._recover();
	}

	async stop(): Promise<void> {
		this._disposed = true;
	}

	async enqueue(producer: string, event: TriggerEvent): Promise<void> {
		this._assertRunning();
		if (this._queue.length + this._reservedCount >= this._config.maxSize) {
			throw new Error(`BackpressureQueue full: maxSize=${this._config.maxSize}`);
		}
		const current = this._producerCounts.get(producer) ?? 0;
		if (current >= this._config.perProducerQuota) {
			throw new Error(`Producer "${producer}" exceeded quota: ${this._config.perProducerQuota}`);
		}
		const item: StoredItem = { id: randomUUID(), producer, event, status: "queued" };
		this._queue.push(item);
		this._producerCounts.set(producer, current + 1);
		await this._walAppend([{ type: "event", id: item.id, producer, event, status: "queued" }]);
	}

	async reserveNext(): Promise<{ id: string; event: TriggerEvent; producer: string } | undefined> {
		this._assertRunning();
		const idx = this._queue.findIndex((i) => i.status === "queued");
		if (idx === -1) return undefined;
		const item = this._queue[idx];
		item.status = "reserved";
		this._queue.splice(idx, 1);
		this._reservedCount++;
		this._reserved.set(item.id, { producer: item.producer });
		await this._walAppend([{ type: "event", id: item.id, producer: item.producer, event: item.event, status: "reserved" }]);
		return { id: item.id, event: item.event, producer: item.producer };
	}

	async ack(id: string): Promise<void> {
		this._assertRunning();
		const reserved = this._reserved.get(id);
		if (!reserved) return;
		this._reserved.delete(id);
		this._reservedCount = Math.max(0, this._reservedCount - 1);
		const current = this._producerCounts.get(reserved.producer) ?? 1;
		if (current <= 1) {
			this._producerCounts.delete(reserved.producer);
		} else {
			this._producerCounts.set(reserved.producer, current - 1);
		}
		await this._walAppend([{ type: "ack", id }]);
		await this._walCheckpoint();
	}

	async nack(id: string, event: TriggerEvent, producer: string): Promise<void> {
		this._assertRunning();
		this._reserved.delete(id);
		this._reservedCount = Math.max(0, this._reservedCount - 1);
		const item: StoredItem = { id, producer, event, status: "queued" };
		this._queue.unshift(item);
		await this._walAppend([{ type: "event", id, producer, event, status: "queued" }]);
	}

	async _walAppend(entries: WalEntry[]): Promise<void> {
		const lines = entries.map((e) => JSON.stringify(e)).join("\n");
		await appendFile(this._walPath, lines + "\n", "utf-8");
	}

	async _walCheckpoint(): Promise<void> {
		const raw = await readFile(this._walPath, "utf-8").catch(() => "");
		if (!raw) return;
		const entries = raw.split("\n").filter(Boolean).map((l) => {
			try { return JSON.parse(l) as WalEntry; } catch { return null; }
		}).filter((e): e is WalEntry => e !== null);
		const folded = foldEntries(entries);
		const tmpPath = join(this._config.storagePath, WAL_TMP);
		await writeFile(tmpPath, folded.map((e) => JSON.stringify({ type: "event", ...e })).join("\n") + "\n", "utf-8");
		await rename(tmpPath, this._walPath);
	}

	async _recover(): Promise<void> {
		const raw = await readFile(this._walPath, "utf-8").catch(() => "");
		if (!raw) return;
		const entries = raw.split("\n").filter(Boolean).map((l) => {
			try { return JSON.parse(l) as WalEntry; } catch { return null; }
		}).filter((e): e is WalEntry => e !== null);
		const items = foldEntries(entries);
		this._queue.push(...items);
		for (const item of this._queue) {
			const c = this._producerCounts.get(item.producer) ?? 0;
			this._producerCounts.set(item.producer, c + 1);
		}
		await this._walCheckpoint();
	}

	private _assertRunning(): void {
		if (!this._started) throw new Error("BackpressureQueue not started");
		if (this._disposed) throw new Error("BackpressureQueue already stopped");
	}
}
