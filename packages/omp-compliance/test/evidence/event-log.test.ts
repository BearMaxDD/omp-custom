import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, EvidencePersistenceError } from "../../src/evidence/event-log";

interface TestEvent {
	eventId: string;
	type: string;
	value?: number;
}

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-event-log-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("EventLog", () => {
	it("连续追加不读取或替换已有日志文件", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const log = new EventLog<TestEvent>(path);

		log.append({ eventId: "event-1", type: "first" });
		const firstIdentity = statSync(path).ino;
		log.append({ eventId: "event-2", type: "second" });

		expect(statSync(path).ino).toBe(firstIdentity);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
		expect(log.readAll().map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
	});

	it("相同 eventId 重试只产生一条可见及物理记录", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const log = new EventLog<TestEvent>(path);
		const event = { eventId: "stable-event", type: "completion" };

		log.append(event);
		log.append(event);

		expect(log.readAll()).toEqual([event]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("读取时按 eventId 去重跨进程重试留下的重复行", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const event = { eventId: "stable-event", type: "completion" };
		writeFileSync(path, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, "utf8");

		expect(new EventLog<TestEvent>(path).readAll()).toEqual([event]);
	});

	it("忽略截断末行并只追加一次可审计 recovery 事件", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const valid = { eventId: "event-1", type: "first" };
		writeFileSync(path, `${JSON.stringify(valid)}\n{"eventId":"broken`, "utf8");
		const log = new EventLog<TestEvent>(path);

		const firstRead = log.readAll();
		const secondRead = log.readAll();

		expect(firstRead[0]).toEqual(valid);
		expect(firstRead[1]).toMatchObject({
			type: "evidence_log_recovered",
			reason: "truncated_tail",
		});
		expect(secondRead).toEqual(firstRead);
		expect(readFileSync(path, "utf8").match(/evidence_log_recovered/g)).toHaveLength(1);
	});

	it("读取失败抛出包含稳定诊断字段的 EvidencePersistenceError", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		mkdirSync(path);

		try {
			new EventLog<TestEvent>(path).readAll();
			expect.unreachable("readAll should throw");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			expect(error).toMatchObject({ operation: "read_event_log", path });
			expect((error as Error & { cause?: unknown }).cause).toBeDefined();
		}
	});

	it("关键追加失败抛出而不是静默降级到内存", () => {
		const root = temporaryRoot();
		const blockedParent = join(root, "blocked");
		writeFileSync(blockedParent, "not a directory", "utf8");
		const path = join(blockedParent, "events.jsonl");

		expect(() => new EventLog<TestEvent>(path).append({ eventId: "event-1", type: "completion" })).toThrow(
			EvidencePersistenceError,
		);
	});
});
