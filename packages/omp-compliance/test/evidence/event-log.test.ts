import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, EvidencePersistenceError } from "../../src/evidence/event-log";
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
	it("正常唯一事件追加不读取或解析既有日志", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		let appendCalls = 0;
		const scope = {
			appendIdempotent(_name: string, eventId: string, content: Buffer) {
				appendCalls += 1;
				expect(eventId).toBe("event-hot-path");
				expect(content.toString("utf8")).toContain('"eventId":"event-hot-path"');
			},
			withLockedFile() {
				throw new Error("正常追加热路径不得读取全日志");
			},
		} as unknown as SecurePathScope;

		new EventLog<TestEvent>(path, scope).append({ eventId: "event-hot-path", type: "completion" });

		expect(appendCalls).toBe(1);
	});

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

	it("claim 文件名只使用 eventId 的 SHA-256 摘要", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		new EventLog<TestEvent>(path).append({ eventId: "../../untrusted/event", type: "completion" });

		const claims = readdirSync(join(root, ".events.jsonl.claims"));
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatch(/^[a-f0-9]{64}\.claim$/);
		expect(claims[0]).not.toContain("untrusted");
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
			type: "recovery_truncated_tail",
		});
		expect(secondRead).toEqual(firstRead);
		expect(readFileSync(path, "utf8").match(/recovery_truncated_tail/g)).toHaveLength(1);
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
		const script = `
			import { existsSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[2])) await Bun.sleep(2);
			new EventLog(process.argv[1]).append({ eventId: "shared-event", type: "completion" });
		`;

		await runConcurrentChildren(script, [path]);

		const physicalEvents = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes('"eventId":"shared-event"'));
		expect(physicalEvents).toHaveLength(1);
	});
});
