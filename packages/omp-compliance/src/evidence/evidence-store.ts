/**
 * JSONL Evidence Store for TDD Compliance Task Events.
 *
 * Persists compliance task activity as append-only JSONL records.
 * Supports atomic writes, crash recovery (tolerates truncated last line),
 * and in-memory pending buffer for graceful failure handling.
 *
 * Atomicity:
 *   Writes go to a .tmp file first, then rename to the final path.
 *   On crash during write, the .tmp is orphaned and the final file is intact.
 *
 * Crash recovery:
 *   readAll tolerates a truncated (incomplete JSON) last line so that
 *   a crash mid-write never loses the preceding records.
 *
 * Pending buffer:
 *   When disk write fails, records are held in memory for later retry.
 *   flushPending() retries the failed writes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EvidenceRecord {
	schemaVersion: number;
	timestamp: string;
	taskId: string;
	contractPath: string;
	contractHash: string;
	attempt: number;
	event: string;
	signalDigest: string;
	verdictSummary?: string;
	worktreeFingerprint?: string;
	outputTruncated?: string;
	commandTruncated?: string;
}

export class EvidenceStore {
	private pending: Map<string, EvidenceRecord[]> = new Map();
	private basePath: string;

	constructor(basePath: string) {
		this.basePath = basePath;
		try {
			mkdirSync(basePath, { recursive: true });
		} catch {
			// Path may be read-only or otherwise unwritable.
			// append() will catch the error and buffer in memory.
		}
	}

	/**
	 * Number of pending (unwritten) records for a task, or total.
	 */
	pendingCount(taskId?: string): number {
		if (taskId) {
			return this.pending.get(taskId)?.length ?? 0;
		}
		let total = 0;
		for (const records of this.pending.values()) {
			total += records.length;
		}
		return total;
	}

	/**
	 * Get all pending records (for inspection in tests).
	 */
	getPending(): EvidenceRecord[] {
		const result: EvidenceRecord[] = [];
		for (const records of this.pending.values()) {
			result.push(...records);
		}
		return result;
	}

	/**
	 * Adopt pending records from another store (for crash recovery testing).
	 */
	adoptPending(other: EvidenceStore): void {
		for (const [taskId, records] of other.pending) {
			const existing = this.pending.get(taskId) ?? [];
			this.pending.set(taskId, [...existing, ...records]);
		}
		other.pending.clear();
	}

	/**
	 * Append an evidence record to the JSONL file for a task.
	 * Uses atomic write (temp file + rename) for crash safety.
	 * Falls back to pending buffer on disk failure.
	 */
	async append(record: EvidenceRecord): Promise<void> {
		const line = JSON.stringify(record) + "\n";
		const filePath = join(this.basePath, `${record.taskId}.jsonl`);

		try {
			mkdirSync(dirname(filePath), { recursive: true });
			const existing = this.readFileSafe(filePath);
			const tmpPath = filePath + ".tmp";
			writeFileSync(tmpPath, existing + line, "utf-8");
			renameSync(tmpPath, filePath);
		} catch {
			const taskPending = this.pending.get(record.taskId) ?? [];
			taskPending.push(record);
			this.pending.set(record.taskId, taskPending);
		}
	}

	/**
	 * Retry writing all pending records.
	 */
	async flushPending(): Promise<void> {
		for (const [taskId, records] of this.pending) {
			const filePath = join(this.basePath, `${taskId}.jsonl`);
			try {
				mkdirSync(dirname(filePath), { recursive: true });
				let content = this.readFileSafe(filePath);
				for (const record of records) {
					content += JSON.stringify(record) + "\n";
				}
				const tmpPath = filePath + ".tmp";
				writeFileSync(tmpPath, content, "utf-8");
				renameSync(tmpPath, filePath);
				this.pending.delete(taskId);
			} catch {
				// Leave pending for next retry
			}
		}
	}

	/**
	 * Read all evidence records for a task.
	 * Tolerates a truncated (incomplete) last line.
	 * Returns empty array if file doesn't exist.
	 */
	async readAll(taskId: string): Promise<EvidenceRecord[]> {
		const filePath = join(this.basePath, `${taskId}.jsonl`);
		const content = this.readFileSafe(filePath);
		if (!content) return [];

		const lines = content.split("\n");
		const records: EvidenceRecord[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const parsed = JSON.parse(trimmed) as EvidenceRecord;
				records.push(parsed);
			} catch {
				break;
			}
		}

		return records;
	}

	private readFileSafe(filePath: string): string {
		try {
			return readFileSync(filePath, "utf-8");
		} catch {
			return "";
		}
	}
}
