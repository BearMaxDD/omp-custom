/**
 * Brainstorm TopicStore — atomic JSONL persistence for topic state and history.
 *
 * File layout:
 *   <basePath>/state.json          — current topic state (atomic replace)
 *   <basePath>/topics/<id>.jsonl   — append-only event log per topic
 *
 * Atomicity:
 *   state.json writes go to a .tmp file first, then rename to the final path.
 *   On crash during write, the .tmp is orphaned and the final file is intact.
 *
 * Crash recovery:
 *   readEvents tolerates a truncated (incomplete JSON) last line so that
 *   a crash mid-write never loses the preceding records.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrainstormTopicState } from "./types";

// ─── Event Types ─────────────────────────────────────────────────────

export type TopicEvent =
	| "topic_created"
	| "review_requested"
	| "review_received"
	| "review_unavailable"
	| "decision_recorded"
	| "topic_reopened"
	| "topic_parked";

/** A single event record stored in the JSONL log. */
export interface TopicEventRecord {
	schemaVersion: 1;
	event: TopicEvent;
	topicId: string;
	ts: string;
	[key: string]: unknown;
}

// ─── TopicStore ──────────────────────────────────────────────────────

export class TopicStore {
	private basePath: string;
	private cachedState: BrainstormTopicState | null = null;

	/**
	 * @param basePath — root directory for brainstorm state
	 *   (typically `.omp/compliance/brainstorm` within the repo).
	 */
	constructor(basePath: string) {
		this.basePath = basePath;
		mkdirSync(this.topicsDir(), { recursive: true });
	}

	// ── Paths ───────────────────────────────────────────────────────

	private statePath(): string {
		return join(this.basePath, "state.json");
	}

	private topicsDir(): string {
		return join(this.basePath, "topics");
	}

	private eventLogPath(topicId: string): string {
		return join(this.topicsDir(), `${topicId}.jsonl`);
	}

	// ── State Read / Write ──────────────────────────────────────────

	/**
	 * Load the current state from the in-memory cache or disk.
	 */
	load(): BrainstormTopicState | null {
		if (this.cachedState) return this.cachedState;
		const content = this.readFileSafe(this.statePath());
		if (!content) return null;
		try {
			this.cachedState = JSON.parse(content) as BrainstormTopicState;
			return this.cachedState;
		} catch {
			return null;
		}
	}

	/** Async variant of load(). */
	async loadState(): Promise<BrainstormTopicState | null> {
		return this.load();
	}

	/**
	 * Atomically persist the current topic state.
	 * Writes to a .tmp file, then renames to state.json.
	 * Updates the in-memory cache on success.
	 */
	async saveState(state: BrainstormTopicState): Promise<void> {
		const filePath = this.statePath();
		const tmpPath = `${filePath}.tmp`;
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(tmpPath, JSON.stringify(state), "utf-8");
		renameSync(tmpPath, filePath);
		this.cachedState = state;
	}

	/**
	 * Reset the store — clears cached state and removes state.json
	 * and all JSONL event files.
	 */
	reset(): void {
		this.cachedState = null;
		const statePath = this.statePath();
		if (existsSync(statePath)) {
			try {
				rmSync(statePath);
			} catch {
				/* best-effort */
			}
		}
		try {
			const dir = this.topicsDir();
			for (const entry of readdirSync(dir)) {
				if (entry.endsWith(".jsonl")) {
					try {
						rmSync(join(dir, entry));
					} catch {
						/* best-effort */
					}
				}
			}
		} catch {
			/* best-effort */
		}
	}

	// ── Event Log ───────────────────────────────────────────────────

	/**
	 * Append an event record to the JSONL log for a topic.
	 * Uses atomic write (read → append → tmp → rename) for crash safety.
	 */
	async appendEvent(topicId: string, event: TopicEvent, extra: Record<string, unknown> = {}): Promise<void> {
		const filePath = this.eventLogPath(topicId);
		const tmpPath = `${filePath}.tmp`;
		mkdirSync(dirname(filePath), { recursive: true });

		const record: TopicEventRecord = {
			schemaVersion: 1,
			event,
			topicId,
			ts: new Date().toISOString(),
			...extra,
		};

		const existing = this.readFileSafe(filePath);
		const line = `${JSON.stringify(record)}\n`;
		writeFileSync(tmpPath, existing + line, "utf-8");
		renameSync(tmpPath, filePath);
	}

	/**
	 * Read all event records for a topic.
	 * Tolerates a truncated (incomplete JSON) last line.
	 * Returns empty array if file doesn't exist.
	 */
	async readEvents(topicId: string): Promise<TopicEventRecord[]> {
		const filePath = this.eventLogPath(topicId);
		const content = this.readFileSafe(filePath);
		if (!content) return [];

		const lines = content.split("\n");
		const records: TopicEventRecord[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as TopicEventRecord);
			} catch {
				break;
			}
		}

		return records;
	}

	// ── Private Helpers ─────────────────────────────────────────────

	private readFileSafe(filePath: string): string {
		try {
			return readFileSync(filePath, "utf-8");
		} catch {
			return "";
		}
	}
}
