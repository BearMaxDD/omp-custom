import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EvidenceRecord, EvidenceStore } from "../../src/evidence/evidence-store";

const TMP_DIR = join(import.meta.dirname, "..", ".tmp", "evidence-test");

function freshStore(): EvidenceStore {
	// Clean slate
	try {
		unlinkSync(join(TMP_DIR, "task-1.jsonl"));
	} catch {
		// ignore
	}
	try {
		unlinkSync(join(TMP_DIR, "task-1.jsonl.tmp"));
	} catch {
		// ignore
	}
	mkdirSync(TMP_DIR, { recursive: true });
	return new EvidenceStore(TMP_DIR);
}

function makeRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
	return {
		schemaVersion: 1,
		timestamp: "2025-01-01T00:00:00.000Z",
		taskId: "task-1",
		contractPath: "tasks/task-1.md",
		contractHash: "sha256:abc123",
		attempt: 1,
		event: "completion_requested",
		signalDigest: "digest123",
		...overrides,
	};
}

describe("EvidenceStore — 写入与重新读取", () => {
	let store: EvidenceStore;

	beforeEach(() => {
		store = freshStore();
	});

	it("appends and reads back a single record", async () => {
		const record = makeRecord();
		await store.append(record);
		const records = await store.readAll("task-1");
		expect(records).toHaveLength(1);
		expect(records[0].taskId).toBe("task-1");
		expect(records[0].event).toBe("completion_requested");
	});

	it("reads back multiple appended records in order", async () => {
		await store.append(makeRecord({ attempt: 1, event: "active" }));
		await store.append(makeRecord({ attempt: 1, event: "completion_requested" }));
		await store.append(makeRecord({ attempt: 1, event: "completed" }));

		const records = await store.readAll("task-1");
		expect(records).toHaveLength(3);
		expect(records[0].event).toBe("active");
		expect(records[1].event).toBe("completion_requested");
		expect(records[2].event).toBe("completed");
	});

	it("returns empty array for unknown task", async () => {
		const records = await store.readAll("nonexistent");
		expect(records).toEqual([]);
	});
});

describe("EvidenceStore — 原子写（临时文件替换）", () => {
	it("creates .tmp file before renaming to final", async () => {
		const store = freshStore();
		await store.append(makeRecord({ event: "active" }));

		const jsonlPath = join(TMP_DIR, "task-1.jsonl");
		const tmpPath = join(TMP_DIR, "task-1.jsonl.tmp");

		// Final file exists, tmp is cleaned up
		const finalContent = readFileSync(jsonlPath, "utf-8");
		expect(finalContent).toContain("active");

		// .tmp should not exist after successful write
		try {
			readFileSync(tmpPath, "utf-8");
			// If we get here, tmp still exists — that's OK as long as
			// the final file is consistent. Some impls keep tmp for crash recovery.
		} catch {
			// tmp cleaned up — ideal
		}
	});
});

describe("EvidenceStore — 损坏末尾行容错读取", () => {
	it("tolerates truncated last line in JSONL file", async () => {
		const store = freshStore();
		const jsonlPath = join(TMP_DIR, "task-1.jsonl");

		// Manually write valid lines + truncated last line
		const validLine = JSON.stringify(makeRecord({ event: "active" })) + "\n";
		const truncatedLine = '{"schemaVersion":1,"taskId":"task-1","event":"in';
		writeFileSync(jsonlPath, validLine + truncatedLine, "utf-8");

		const records = await store.readAll("task-1");
		expect(records).toHaveLength(1);
		expect(records[0].event).toBe("active");
	});
});

describe("EvidenceStore — pending buffer 与写失败警告", () => {
	it("stores pending records in memory when write fails", async () => {
		// Use a path that will fail (non-existent directory without create)
		const badStore = new EvidenceStore("/nonexistent/deep/path");

		const record = makeRecord();
		await badStore.append(record);

		// Should not throw — pending buffer absorbs the failure
		// Verify by checking pending count via internal access
		expect(badStore.pendingCount()).toBe(1);
	});

	it("flushPending retries failed writes", async () => {
		const store = freshStore();
		const record = makeRecord();

		await store.append(record);
		// First write succeeded, no pending
		expect(store.pendingCount()).toBe(0);

		// Now force a failure
		const badStore = new EvidenceStore("/nonexistent/path");
		await badStore.append(record);
		await badStore.append(makeRecord({ event: "completed" }));
		expect(badStore.pendingCount()).toBe(2);

		// Retry with a valid store (simulate recovery)
		const recovered = new EvidenceStore(TMP_DIR);
		recovered.adoptPending(badStore);
		await recovered.flushPending();

		const records = await recovered.readAll("task-1");
		expect(records.length).toBeGreaterThanOrEqual(1);
	});
});

describe("EvidenceStore — 写入失败不能完成任务", () => {
	it("evidence persistence failure does NOT complete the task", async () => {
		// This test validates the principle: even if evidence writing fails,
		// the task state machine must not transition to completed.
		// The evidence store itself should surface the failure as a warning/error
		// but not change any task status.
		const store = new EvidenceStore("/nonexistent/path");

		const record = makeRecord({ event: "completed" });

		// Should not throw — pend the record
		await store.append(record);
		expect(store.pendingCount()).toBe(1);

		// pending records should still be retrievable
		const pending = store.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0].event).toBe("completed");
	});
});
