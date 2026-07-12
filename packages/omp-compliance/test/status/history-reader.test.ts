import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EvidenceRecord, EvidenceStore } from "../../src/evidence/evidence-store";
import { readHistory } from "../../src/status/history-reader";

// ─── Test Fixtures ─────────────────────────────────────────────────

let tmpDir: string;
let store: EvidenceStore;
let taskId: string;
let records: EvidenceRecord[];

beforeEach(() => {
	tmpDir = join(tmpdir(), `omp-history-test-${randomUUID()}`);
	mkdirSync(tmpDir, { recursive: true });
	store = new EvidenceStore(tmpDir);
	taskId = "test-task-001";
	records = [
		{
			schemaVersion: 1,
			timestamp: "2026-01-01T00:00:00.000Z",
			taskId,
			contractPath: "/path/to/tdd.md",
			contractHash: "abcdef1234567890",
			attempt: 1,
			event: "active",
			signalDigest: "task-started",
		},
		{
			schemaVersion: 1,
			timestamp: "2026-01-01T01:00:00.000Z",
			taskId,
			contractPath: "/path/to/tdd.md",
			contractHash: "abcdef1234567890",
			attempt: 2,
			event: "completion_requested",
			signalDigest: "fingerprint-diff-001",
		},
		{
			schemaVersion: 1,
			timestamp: "2026-01-01T02:00:00.000Z",
			taskId,
			contractPath: "/path/to/tdd.md",
			contractHash: "abcdef1234567890",
			attempt: 2,
			event: "completed",
			signalDigest: "advisor-pass",
			verdictSummary: "All criteria met",
		},
	];
});

// ─── Tests ─────────────────────────────────────────────────────────

describe("readHistory", () => {
	it("returns chronological events", async () => {
		// Write records in reverse order
		for (const r of records.toReversed()) {
			await store.append(r);
		}

		const events = await readHistory(store, taskId);
		expect(events).toHaveLength(3);

		// Verify chronological order
		expect(events[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
		expect(events[0].event).toBe("active");
		expect(events[1].event).toBe("completion_requested");
		expect(events[2].event).toBe("completed");
	});

	it("includes verdict summary in output", async () => {
		for (const r of records) {
			await store.append(r);
		}

		const events = await readHistory(store, taskId);
		const completed = events.find((e) => e.event === "completed");
		expect(completed?.verdictSummary).toBe("All criteria met");
	});

	it("includes attempt number", async () => {
		for (const r of records) {
			await store.append(r);
		}

		const events = await readHistory(store, taskId);
		expect(events[1].attempt).toBe(2);
	});

	it("builds readable summaries for known event types", async () => {
		for (const r of records) {
			await store.append(r);
		}

		const events = await readHistory(store, taskId);
		expect(events[0].summary).toMatch(/started/);
		expect(events[1].summary).toMatch(/completion/i);
		expect(events[2].summary).toMatch(/completed/);
	});

	it("returns empty array for unknown task", async () => {
		const events = await readHistory(store, "no-such-task");
		expect(events).toEqual([]);
	});

	it("handles stopped event records", async () => {
		await store.append({
			...records[0],
			timestamp: "2026-01-01T03:00:00.000Z",
			event: "stopped",
			signalDigest: "task-stopped-by-user",
		});

		const events = await readHistory(store, taskId);
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("stopped");
		expect(events[0].summary).toMatch(/stopped/);
	});

	it("includes worktree fingerprint short when available", async () => {
		await store.append({
			...records[0],
			worktreeFingerprint: "abcdef1234567890",
		});

		const events = await readHistory(store, taskId);
		expect(events[0].worktreeFingerprintShort).toBe("abcdef123456");
	});

	it("returns undefined worktree fingerprint for short strings", async () => {
		await store.append({
			...records[0],
			worktreeFingerprint: "abc",
		});

		const events = await readHistory(store, taskId);
		expect(events[0].worktreeFingerprintShort).toBe("abc");
	});

	it("redacts sensitive content in summaries", async () => {
		await store.append({
			...records[0],
			verdictSummary: "Token: sk-my-secret-key-is-here-1234567890",
		});

		const events = await readHistory(store, taskId);
		expect(events[0].verdictSummary).toContain("[REDACTED]");
		expect(events[0].verdictSummary).not.toContain("my-secret-key");
	});
});
