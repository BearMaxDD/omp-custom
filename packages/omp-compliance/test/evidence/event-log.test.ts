import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, EvidencePersistenceError, deterministicEvidenceEventId } from "../../src/evidence/event-log";
import type { SecurePathScope } from "../../src/evidence/secure-fs";

interface TestEvent {
	eventId: string;
	type: string;
	value?: number;
}

const roots: string[] = [];
const eventLogModule = new URL("../../src/evidence/event-log.ts", import.meta.url).href;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-event-log-"));
	roots.push(root);
	return root;
}

function eventId(identity: string): string {
	return deterministicEvidenceEventId(`test\0${identity}`);
}

async function runConcurrentChildren(script: string, args: string[], count = 12): Promise<void> {
	const barrier = join(temporaryRoot(), "start");
	const children = Array.from({ length: count }, () =>
		Bun.spawn([process.execPath, "-e", script, ...args, barrier], { stderr: "pipe" }),
	);
	writeFileSync(barrier, "start", "utf8");

	for (const child of children) {
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("EventLog", () => {
	it.each([
		"event-1",
		"550e8400-e29b-11d4-a716-446655440000",
		"550e8400-e29b-41d4-7716-446655440000",
		"550e8400-e29b-61d4-a716-446655440000",
	])("拒绝不符合 UUID v4/v5/v7 与 RFC variant 的 eventId：%s", (eventId) => {
		const path = join(temporaryRoot(), "events.jsonl");
		expect(() => new EventLog<TestEvent>(path).append({ eventId, type: "completion" })).toThrow(
			EvidencePersistenceError,
		);
		expect(existsSync(path)).toBe(false);
	});

	it.each([
		"550e8400-e29b-41d4-a716-446655440000",
		"550e8400-e29b-51d4-b716-446655440000",
		"01890f9e-7b5a-7cc3-98f4-446655440000",
	])("接受标准 UUID eventId：%s", (eventId) => {
		const path = join(temporaryRoot(), "events.jsonl");
		new EventLog<TestEvent>(path).append({ eventId, type: "completion" });
		expect(new EventLog<TestEvent>(path).readAll()).toEqual([{ eventId, type: "completion" }]);
	});

	it("正常唯一事件追加不读取或解析既有日志", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const hotPathEventId = eventId("hot-path");
		let appendCalls = 0;
		const scope = {
			appendIdempotent(_name: string, eventId: string, content: Buffer) {
				appendCalls += 1;
				expect(eventId).toBe(hotPathEventId);
				expect(content.toString("utf8")).toContain(`"eventId":"${hotPathEventId}"`);
			},
			withLockedFile() {
				throw new Error("正常追加热路径不得读取全日志");
			},
		} as unknown as SecurePathScope;

		new EventLog<TestEvent>(path, scope).append({ eventId: hotPathEventId, type: "completion" });

		expect(appendCalls).toBe(1);
	});

	it("连续追加不读取或替换已有日志文件", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const log = new EventLog<TestEvent>(path);

		const firstEventId = eventId("event-1");
		const secondEventId = eventId("event-2");
		log.append({ eventId: firstEventId, type: "first" });
		const firstIdentity = statSync(path).ino;
		log.append({ eventId: secondEventId, type: "second" });

		expect(statSync(path).ino).toBe(firstIdentity);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
		expect(log.readAll().map((event) => event.eventId)).toEqual([firstEventId, secondEventId]);
	});

	it("相同 eventId 重试只产生一条可见及物理记录", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const log = new EventLog<TestEvent>(path);
		const event = { eventId: eventId("stable-event"), type: "completion" };

		log.append(event);
		log.append(event);

		expect(log.readAll()).toEqual([event]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("claim 文件名只使用 eventId 的 SHA-256 摘要", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		new EventLog<TestEvent>(path).append({ eventId: eventId("claim-name"), type: "completion" });

		const claims = readdirSync(join(root, ".events.jsonl.claims"));
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatch(/^[a-f0-9]{64}\.claim$/);
		expect(claims[0]).not.toContain("-");
	});

	it("读取时按 eventId 去重跨进程重试留下的重复行", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const event = { eventId: eventId("stable-disk-event"), type: "completion" };
		writeFileSync(path, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, "utf8");

		expect(new EventLog<TestEvent>(path).readAll()).toEqual([event]);
	});

	it("读取磁盘记录时保留合法 UUID 并将非法标识按完整原始行稳定规范化为 UUIDv5", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const lines = [
			JSON.stringify({ eventId: "550e8400-e29b-41d4-a716-446655440000", type: "valid-v4" }),
			JSON.stringify({ eventId: "550e8400-e29b-51d4-b716-446655440000", type: "valid-v5" }),
			JSON.stringify({ eventId: "01890f9e-7b5a-7cc3-98f4-446655440000", type: "valid-v7" }),
			JSON.stringify({ type: "missing", value: 1 }),
			JSON.stringify({ eventId: "not-a-uuid", type: "non-uuid", value: 2 }),
			JSON.stringify({ eventId: "550e8400-e29b-61d4-a716-446655440000", type: "wrong-version", value: 3 }),
			JSON.stringify({ eventId: "550e8400-e29b-41d4-7716-446655440000", type: "wrong-variant", value: 4 }),
			JSON.stringify({ eventId: "not-a-uuid", type: "different-line", value: 5 }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

		const log = new EventLog<TestEvent>(path);
		const firstRead = log.readAll();
		const secondRead = log.readAll();

		expect(firstRead.slice(0, 3).map((event) => event.eventId)).toEqual([
			"550e8400-e29b-41d4-a716-446655440000",
			"550e8400-e29b-51d4-b716-446655440000",
			"01890f9e-7b5a-7cc3-98f4-446655440000",
		]);
		const normalizedIds = firstRead.slice(3).map((event) => event.eventId);
		expect(normalizedIds).toEqual(lines.slice(3).map((line) => deterministicEvidenceEventId(`legacy_event\0${line}`)));
		expect(normalizedIds).toHaveLength(new Set(normalizedIds).size);
		for (const normalizedId of normalizedIds) {
			expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		}
		expect(secondRead).toEqual(firstRead);
	});

	it("忽略截断末行并只追加一次可审计 recovery 事件", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const valid = { eventId: eventId("valid-before-truncated-tail"), type: "first" };
		writeFileSync(path, `${JSON.stringify(valid)}\n{"eventId":"broken`, "utf8");
		const log = new EventLog<TestEvent>(path);

		const firstRead = log.readAll();
		const secondRead = log.readAll();

		expect(firstRead[0]).toEqual(valid);
		expect(firstRead[1]).toMatchObject({
			type: "recovery_truncated_tail",
		});
		expect(secondRead).toEqual(firstRead);
		expect(firstRead[1]?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(readFileSync(path, "utf8").match(/recovery_truncated_tail/g)).toHaveLength(1);
	});

	it("截断后不调用 readAll 直接追加时恢复尾部且保留新事件", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		writeFileSync(path, '{"eventId":"valid","type":"first"}\n{"eventId":"broken', "utf8");
		const log = new EventLog<TestEvent>(path);

		const goodEventId = eventId("good-event");
		log.append({ eventId: goodEventId, type: "completion" });

		const events = log.readAll();
		expect(events.map((event) => event.eventId)).toContain(goodEventId);
		expect(events.filter((event) => event.type === "recovery_truncated_tail")).toHaveLength(1);
		const physical = readFileSync(path, "utf8").split("\n");
		expect(physical.filter((line) => line.includes(`"eventId":"${goodEventId}"`))).toHaveLength(1);
		expect(physical.filter((line) => line.includes('"type":"recovery_truncated_tail"'))).toHaveLength(1);
	});

	it("完整 JSON 仅缺换行时补换行且不生成 recovery", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const validEventId = eventId("valid-no-newline");
		writeFileSync(path, JSON.stringify({ eventId: validEventId, type: "first" }), "utf8");
		const log = new EventLog<TestEvent>(path);

		const goodEventId = eventId("good-event");
		log.append({ eventId: goodEventId, type: "completion" });

		const events = log.readAll();
		expect(events.map((event) => event.eventId)).toEqual([validEventId, goodEventId]);
		expect(events.some((event) => event.type === "recovery_truncated_tail")).toBeFalse();
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

		expect(() =>
			new EventLog<TestEvent>(path).append({ eventId: eventId("write-failure"), type: "completion" }),
		).toThrow(EvidencePersistenceError);
	});

	it("多进程并发恢复截断日志只物理追加一条 recovery", async () => {
		const path = join(temporaryRoot(), "events.jsonl");
		writeFileSync(path, '{"eventId":"valid","type":"first"}\n{"eventId":"broken', "utf8");
		const script = `
			import { existsSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[2])) await Bun.sleep(2);
			new EventLog(process.argv[1]).readAll();
		`;

		await runConcurrentChildren(script, [path]);

		const physicalRecoveries = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes('"type":"recovery_truncated_tail"'));
		expect(physicalRecoveries).toHaveLength(1);
	});

	it("多进程并发追加相同 eventId 只产生一条物理记录", async () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const sharedEventId = eventId("shared-event");
		const script = `
			import { existsSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[2])) await Bun.sleep(2);
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(sharedEventId)}, type: "completion" });
		`;

		await runConcurrentChildren(script, [path]);

		const physicalEvents = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes(`"eventId":"${sharedEventId}"`));
		expect(physicalEvents).toHaveLength(1);
	});

	it("多进程同时向截断日志直接追加时 recovery 不重且所有新事件不丢", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const barrier = join(root, "start");
		const eventIds = Array.from({ length: 12 }, (_, index) => eventId(`good-${index}`));
		writeFileSync(path, '{"eventId":"valid","type":"first"}\n{"eventId":"broken', "utf8");
		const script = `
			import { existsSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[3])) await Bun.sleep(2);
			new EventLog(process.argv[1]).append({ eventId: process.argv[2], type: "completion" });
		`;
		const children = Array.from({ length: 12 }, (_, index) =>
			Bun.spawn([process.execPath, "-e", script, path, eventIds[index] as string, barrier], { stderr: "pipe" }),
		);
		writeFileSync(barrier, "start", "utf8");
		for (const child of children) {
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		}

		const physicalLines = readFileSync(path, "utf8").split("\n");
		expect(physicalLines.filter((line) => line.includes('"type":"recovery_truncated_tail"'))).toHaveLength(1);
		for (const currentEventId of eventIds) {
			expect(physicalLines.filter((line) => line.includes(`"eventId":"${currentEventId}"`))).toHaveLength(1);
		}
	});
});
