import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EvidencePersistenceError } from "../../src/evidence/event-log";
import { type EvidenceRecord, EvidenceStore } from "../../src/evidence/evidence-store";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-evidence-store-"));
	roots.push(root);
	return root;
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
		store = new EvidenceStore(temporaryRoot());
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

describe("EvidenceStore — 损坏末尾行容错读取", () => {
	it("tolerates truncated last line in JSONL file", async () => {
		const root = temporaryRoot();
		const store = new EvidenceStore(root);
		const jsonlPath = join(root, "tasks", "task-1", "events.jsonl");
		mkdirSync(dirname(jsonlPath), { recursive: true });

		// Manually write valid lines + truncated last line
		const validLine = `${JSON.stringify(makeRecord({ event: "active" }))}\n`;
		const truncatedLine = '{"schemaVersion":1,"taskId":"task-1","event":"in';
		writeFileSync(jsonlPath, validLine + truncatedLine, "utf-8");

		const records = await store.readAll("task-1");
		expect(records).toHaveLength(2);
		expect(records[0].event).toBe("active");
		expect(records[1]).toMatchObject({
			type: "recovery_truncated_tail",
		});
	});
});

describe("EvidenceStore — 关键写失败", () => {
	it("抛出可辨识错误且不再静默 pending", async () => {
		const parent = temporaryRoot();
		const root = join(parent, "blocked-parent");
		writeFileSync(root, "blocked", "utf8");
		const store = new EvidenceStore(root);

		expect(store.append(makeRecord({ event: "completed" }))).rejects.toBeInstanceOf(EvidencePersistenceError);
		expect(store.pendingCount()).toBe(0);
		expect(store.getPending()).toEqual([]);
	});
});

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});
