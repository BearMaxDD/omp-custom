import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EventLog,
	EvidencePersistenceError,
	deterministicEvidenceEventId,
	isEvidenceEventId,
} from "../../src/evidence/event-log";
import * as secureFsSource from "../../src/evidence/secure-fs";
import { type SecurePathScope, setSecureFsTestHook } from "../../src/evidence/secure-fs";

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

function indexedEventId(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function overwriteLineStart(path: string, position: "first" | "middle" | "last"): { line: number; offset: number } {
	const lines = readFileSync(path).toString("utf8").trimEnd().split("\n");
	const line = position === "first" ? 0 : position === "middle" ? Math.floor(lines.length / 2) : lines.length - 1;
	const offset = lines.slice(0, line).reduce((total, content) => total + Buffer.byteLength(content) + 1, 0);
	const before = statSync(path);
	const descriptor = openSync(path, "r+");
	try {
		writeSync(descriptor, Buffer.from("!"), 0, 1, offset);
	} finally {
		closeSync(descriptor);
	}
	utimesSync(path, before.atime, before.mtime);
	return { line: line + 1, offset };
}

async function countFileOccurrences(path: string, needle: string): Promise<number> {
	let carry = "";
	let count = 0;
	for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
		const content = carry + (chunk as Buffer).toString("utf8");
		const safeLength = Math.max(0, content.length - (needle.length - 1));
		let offset = 0;
		for (;;) {
			const found = content.indexOf(needle, offset);
			if (found < 0 || found >= safeLength) break;
			count += 1;
			offset = found + needle.length;
		}
		carry = content.slice(safeLength);
	}
	let offset = 0;
	for (;;) {
		const found = carry.indexOf(needle, offset);
		if (found < 0) break;
		count += 1;
		offset = found + needle.length;
	}
	return count;
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
	setSecureFsTestHook(undefined);
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("EventLog", () => {
	it("仅接受规范小写 RFC UUID v4/v5/v7", () => {
		const lowercase = "550e8400-e29b-41d4-a716-446655440000";
		expect(isEvidenceEventId(lowercase)).toBeTrue();
		expect(isEvidenceEventId(lowercase.toUpperCase())).toBeFalse();
	});

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

	it("大写 UUID append 以 validate_event_id 拒绝且不新增物理日志", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const lowercase = "550e8400-e29b-41d4-a716-446655440000";
		const uppercase = lowercase.toUpperCase();
		const log = new EventLog<TestEvent>(path);
		log.append({ eventId: lowercase, type: "lowercase" });
		const before = readFileSync(path);

		try {
			log.append({ eventId: uppercase, type: "uppercase" });
			expect.unreachable("大写 UUID 必须在持久化前被拒绝");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			expect(error).toMatchObject({ operation: "validate_event_id", path });
		}
		expect(readFileSync(path)).toEqual(before);
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

	it.each(["first", "middle"] as const)(
		"event_appended 后篡改旧前缀 %s 行时提交失败且缓存不接受损坏世代",
		(position) => {
			const path = join(temporaryRoot(), "events.jsonl");
			const log = new EventLog<TestEvent>(path);
			for (let index = 0; index < 4; index += 1) {
				log.append({ eventId: eventId(`commit-window-existing-${index}`), type: `existing-${index}` });
			}
			let corruption: { line: number; offset: number } | undefined;
			setSecureFsTestHook((event) => {
				if (event.stage !== "event_appended" || corruption !== undefined) return;
				corruption = overwriteLineStart(path, position);
			});
			const appended = { eventId: eventId(`commit-window-${position}`), type: "must-fail" };

			expect(() => log.append(appended)).toThrow(EvidencePersistenceError);
			setSecureFsTestHook(undefined);
			expect(() => log.append(appended)).toThrow(EvidencePersistenceError);
			expect(corruption).toBeDefined();
		},
	);

	it("event_appended 后旧前缀被等长改成另一条合法 JSON 时仍拒绝提交", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const log = new EventLog<TestEvent>(path);
		log.append({ eventId: eventId("valid-prefix-change"), type: "alpha" });
		let changed = false;
		setSecureFsTestHook((event) => {
			if (event.stage !== "event_appended" || changed) return;
			const content = readFileSync(path);
			const offset = content.indexOf(Buffer.from("alpha"));
			const descriptor = openSync(path, "r+");
			try {
				writeSync(descriptor, Buffer.from("omega"), 0, 5, offset);
			} finally {
				closeSync(descriptor);
			}
			changed = true;
		});

		try {
			log.append({ eventId: eventId("after-valid-prefix-change"), type: "must-fail" });
			expect.unreachable("合法 JSON 的旧前缀改写也必须 fail-closed");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
			expect(secureCause.cause).toMatchObject({ line: 1, offset: 0, reason: "event_prefix_changed" });
		}
	});

	it.each(["first", "middle", "last"] as const)("claim journal 暖缓存发现同 inode 等长破坏的 %s 行", (position) => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const log = new EventLog<TestEvent>(path);
		for (let index = 0; index < 4; index += 1) {
			log.append({ eventId: eventId(`journal-prefix-${index}`), type: "journal-prefix" });
		}
		const fixedTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
		utimesSync(journalPath, fixedTime, fixedTime);
		log.append({ eventId: eventId("journal-prefix-0"), type: "journal-prefix" });
		const corruption = overwriteLineStart(journalPath, position);

		try {
			log.append({ eventId: eventId(`journal-after-${position}`), type: "must-fail" });
			expect.unreachable("已验证 claim journal 前缀被改写后必须 fail-closed");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
			expect(secureCause.cause).toMatchObject({
				path: journalPath,
				line: corruption.line,
				offset: corruption.offset,
			});
		}
	});

	it("10 万事件日志冷启动和首尾 eventId 查询均使用有界流式扫描", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const count = 100_000;
		const eventIds = Array.from({ length: count }, (_, index) => indexedEventId(index));
		writeFileSync(
			path,
			eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, type: "stream" })}\n`).join(""),
		);
		writeFileSync(
			journalPath,
			eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, state: "done" })}\n`).join(""),
		);
		let maxReadChunkBytes = 0;
		let maxCarryBytes = 0;
		setSecureFsTestHook((event) => {
			if (event.stage !== "event_log_stream_stats") return;
			maxReadChunkBytes = Math.max(maxReadChunkBytes, event.maxReadChunkBytes ?? 0);
			maxCarryBytes = Math.max(maxCarryBytes, event.maxCarryBytes ?? 0);
		});

		new EventLog<TestEvent>(path).append({ eventId: eventIds[0] as string, type: "stream" });
		new EventLog<TestEvent>(path).append({ eventId: eventIds.at(-1) as string, type: "stream" });

		expect(maxReadChunkBytes).toBeGreaterThan(0);
		expect(maxReadChunkBytes).toBeLessThanOrEqual(64 * 1024);
		expect(maxCarryBytes).toBeLessThanOrEqual(64 * 1024);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(count);
	}, 30_000);

	it("事件日志超过 64 KiB 单行上限时返回稳定位置且不追加", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		writeFileSync(path, Buffer.concat([Buffer.alloc(64 * 1024 + 1, 0x78), Buffer.from("\n")]));

		try {
			new EventLog<TestEvent>(path).append({ eventId: eventId("after-long-event-line"), type: "must-fail" });
			expect.unreachable("超长事件行必须 fail-closed");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
			expect(secureCause.cause).toMatchObject({ line: 1, offset: 0, reason: "event_line_too_long" });
		}
	});

	it("恢复事件已由竞争者持久化时返回值逐字段采用规范磁盘记录", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const original = `${JSON.stringify({ eventId: eventId("before-nested-recovery"), type: "valid" })}\n{"broken"`;
		let persisted = original;
		const scope = {
			withLockedFile(_name: string, _options: unknown, operation: (file: { read(): Buffer }) => unknown) {
				return operation({ read: () => Buffer.from(persisted) });
			},
			appendIdempotent(_name: string, _eventId: string, content: Buffer) {
				const generated = JSON.parse(content.toString("utf8").trim()) as Record<string, unknown>;
				const winner = { ...generated, timestamp: "2000-01-01T00:00:00.000Z" };
				persisted = `${original}\n${JSON.stringify(winner)}\n`;
			},
		} as unknown as SecurePathScope;

		const result = new EventLog<TestEvent>(path, scope).readAll();
		const persistedRecovery = JSON.parse(persisted.trim().split("\n").at(-1) as string);
		expect(result.at(-1)).toEqual(persistedRecovery);
	});

	it("1000 个正常事件只使用单一追加式 claim journal 且不重写历史", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const log = new EventLog<TestEvent>(path);
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		let fullReads = 0;
		let deltaReads = 0;
		let journalAppends = 0;
		let eventScannedBytes = 0;
		setSecureFsTestHook((event) => {
			if (event.stage === "claim_journal_full_read") fullReads += 1;
			if (event.stage === "claim_journal_delta_read") deltaReads += 1;
			if (event.stage === "claim_journal_appended") journalAppends += 1;
			if (event.stage === "event_log_stream_stats") eventScannedBytes += event.scannedBytes ?? 0;
		});

		const eventIds = Array.from({ length: 1_000 }, (_, index) => eventId(`journal-${index}`));
		log.append({ eventId: eventIds[0] as string, type: "journal" });
		const journalInode = statSync(journalPath).ino;
		for (const currentEventId of eventIds.slice(1)) log.append({ eventId: currentEventId, type: "journal" });

		const journalLines = readFileSync(journalPath, "utf8").trim().split("\n");
		expect(statSync(journalPath).ino).toBe(journalInode);
		expect(journalLines).toHaveLength(2_000);
		expect(journalLines.filter((line) => JSON.parse(line).state === "pending")).toHaveLength(1_000);
		expect(journalLines.filter((line) => JSON.parse(line).state === "done")).toHaveLength(1_000);
		expect(readdirSync(root).filter((name) => name.includes("claims"))).toEqual([".events.jsonl.claims.jsonl"]);
		expect({ fullReads, deltaReads, journalAppends }).toEqual({ fullReads: 1, deltaReads: 0, journalAppends: 2_000 });
		expect(eventScannedBytes).toBeLessThanOrEqual(statSync(path).size * 2);
	});

	it.each([10_000, 100_000])(
		"%d 个历史事件只保留有界 hot cache、Bloom 与 pending",
		(count) => {
			const root = temporaryRoot();
			const path = join(root, "events.jsonl");
			const journalPath = join(root, ".events.jsonl.claims.jsonl");
			const eventIds = Array.from({ length: count }, (_, index) => indexedEventId(index));
			writeFileSync(
				path,
				eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, type: "history" })}\n`).join(""),
				"utf8",
			);
			writeFileSync(
				journalPath,
				eventIds
					.map(
						(currentEventId) =>
							`${JSON.stringify({ eventId: currentEventId, state: "pending" })}\n${JSON.stringify({ eventId: currentEventId, state: "done" })}\n`,
					)
					.join(""),
				"utf8",
			);
			let stats: { bloomBytes: number; hotSize: number; pendingSize: number; targetScans: number } | undefined;
			let targetScans = 0;
			setSecureFsTestHook((event) => {
				const detail = event as unknown as {
					stage: string;
					bloomBytes?: number;
					hotSize?: number;
					pendingSize?: number;
				};
				if (detail.stage === "claim_journal_target_scan") targetScans += 1;
				if (detail.stage === "claim_journal_cache_stats") {
					stats = {
						bloomBytes: detail.bloomBytes ?? -1,
						hotSize: detail.hotSize ?? -1,
						pendingSize: detail.pendingSize ?? -1,
						targetScans,
					};
				}
			});

			const log = new EventLog<TestEvent>(path);
			log.append({ eventId: eventIds[0] as string, type: "history" });
			log.append({ eventId: eventIds.at(-1) as string, type: "history" });
			const newEventId = indexedEventId(count + 1);
			log.append({ eventId: newEventId, type: "new" });

			expect(stats).toEqual({ bloomBytes: 1024 * 1024, hotSize: 4_096, pendingSize: 0, targetScans: 1 });
			expect(readFileSync(path, "utf8").match(/\n/g)).toHaveLength(count + 1);
			expect(log.readAll().filter((event) => event.eventId === eventIds[0])).toHaveLength(1);
			expect(log.readAll().filter((event) => event.eventId === eventIds.at(-1))).toHaveLength(1);
		},
		30_000,
	);

	it.each([20_000, 100_000])(
		"%d 个孤立 pending 仅保留有界索引且首尾均可精确恢复",
		(count) => {
			const root = temporaryRoot();
			const path = join(root, "events.jsonl");
			const journalPath = join(root, ".events.jsonl.claims.jsonl");
			const eventIds = Array.from({ length: count }, (_, index) => indexedEventId(index));
			writeFileSync(path, "", "utf8");
			writeFileSync(
				journalPath,
				eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, state: "pending" })}\n`).join(""),
				"utf8",
			);
			let stats: { bloomBytes: number; pendingBloomBytes: number; hotSize: number; pendingSize: number } | undefined;
			setSecureFsTestHook((event) => {
				const detail = event as unknown as {
					stage: string;
					bloomBytes?: number;
					pendingBloomBytes?: number;
					hotSize?: number;
					pendingSize?: number;
				};
				if (detail.stage !== "claim_journal_cache_stats") return;
				stats = {
					bloomBytes: detail.bloomBytes ?? -1,
					pendingBloomBytes: detail.pendingBloomBytes ?? -1,
					hotSize: detail.hotSize ?? -1,
					pendingSize: detail.pendingSize ?? -1,
				};
			});

			const log = new EventLog<TestEvent>(path);
			log.append({ eventId: eventIds[0] as string, type: "pending-history" });
			log.append({ eventId: eventIds.at(-1) as string, type: "pending-history" });
			expect(stats).toEqual({
				bloomBytes: 1024 * 1024,
				pendingBloomBytes: 1024 * 1024,
				hotSize: 2,
				pendingSize: 4_094,
			});

			const reopened = new EventLog<TestEvent>(path);
			reopened.append({ eventId: eventIds[0] as string, type: "pending-history" });
			reopened.append({ eventId: eventIds.at(-1) as string, type: "pending-history" });
			const physical = readFileSync(path, "utf8").trim().split("\n");
			expect(physical.filter((line) => line.includes(eventIds[0] as string))).toHaveLength(1);
			expect(physical.filter((line) => line.includes(eventIds.at(-1) as string))).toHaveLength(1);
		},
		30_000,
	);

	it("Bloom 对不同哈希分布的历史 eventId 不产生假阴性", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const eventIds = Array.from({ length: 10_000 }, (_, index) => indexedEventId(index));
		writeFileSync(
			path,
			eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, type: "history" })}\n`).join(""),
		);
		writeFileSync(
			journalPath,
			eventIds
				.map(
					(currentEventId) =>
						`${JSON.stringify({ eventId: currentEventId, state: "pending" })}\n${JSON.stringify({ eventId: currentEventId, state: "done" })}\n`,
				)
				.join(""),
		);
		const log = new EventLog<TestEvent>(path);

		for (const historicalId of eventIds.slice(0, 64)) {
			log.append({ eventId: historicalId, type: "history" });
		}

		expect(readFileSync(path, "utf8").match(/\n/g)).toHaveLength(10_000);
	});

	it.each([200, 1_000])(
		"%d 次 pending 中断恢复后 claim inode 保持常数且事件不丢不重",
		(count) => {
			const root = temporaryRoot();
			const path = join(root, "events.jsonl");
			const log = new EventLog<TestEvent>(path);
			const eventIds = Array.from({ length: count }, (_, index) => eventId(`pending-recovery-${count}-${index}`));

			for (const currentEventId of eventIds) {
				setSecureFsTestHook((event) => {
					if (event.stage === "claim_created") throw new Error("simulated crash after pending");
				});
				expect(() => log.append({ eventId: currentEventId, type: "pending-recovery" })).toThrow();
				setSecureFsTestHook(undefined);
				log.append({ eventId: currentEventId, type: "pending-recovery" });
			}

			const physicalLines = readFileSync(path, "utf8").trim().split("\n");
			expect(physicalLines).toHaveLength(count);
			expect(new Set(physicalLines.map((line) => JSON.parse(line).eventId)).size).toBe(count);
			expect(readdirSync(root).filter((name) => name.includes("claims"))).toEqual([".events.jsonl.claims.jsonl"]);
		},
		30_000,
	);

	it("重开进程重复首尾 eventId 时物理日志不重复", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const eventIds = Array.from({ length: 1_000 }, (_, index) => eventId(`reopen-${index}`));
		const first = new EventLog<TestEvent>(path);
		for (const currentEventId of eventIds) first.append({ eventId: currentEventId, type: "reopen" });

		const reopened = new EventLog<TestEvent>(path);
		reopened.append({ eventId: eventIds[0] as string, type: "reopen" });
		reopened.append({ eventId: eventIds.at(-1) as string, type: "reopen" });

		const physicalLines = readFileSync(path, "utf8").trim().split("\n");
		expect(physicalLines).toHaveLength(1_000);
		expect(physicalLines.filter((line) => line.includes(eventIds[0] as string))).toHaveLength(1);
		expect(physicalLines.filter((line) => line.includes(eventIds.at(-1) as string))).toHaveLength(1);
	});

	it("其他进程追加后仅 pread journal 增量尾部而不重读历史", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const barrier = join(root, "child-start");
		const firstEventId = eventId("delta-first");
		const childEventId = eventId("delta-child");
		const finalEventId = eventId("delta-final");
		const log = new EventLog<TestEvent>(path);
		let fullReads = 0;
		let deltaReads = 0;
		setSecureFsTestHook((event) => {
			if (event.stage === "claim_journal_full_read") fullReads += 1;
			if (event.stage === "claim_journal_delta_read") deltaReads += 1;
		});
		log.append({ eventId: firstEventId, type: "delta" });
		const script = `
			import { existsSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[2])) await Bun.sleep(2);
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(childEventId)}, type: "delta" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, barrier], { stderr: "pipe" });
		writeFileSync(barrier, "start", "utf8");
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

		log.append({ eventId: finalEventId, type: "delta" });

		expect({ fullReads, deltaReads }).toEqual({ fullReads: 1, deltaReads: 1 });
		expect(log.readAll().map((event) => event.eventId)).toEqual([firstEventId, childEventId, finalEventId]);
	});

	it("claim journal 被原子替换后全量重建有界索引并保持历史幂等", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const replacementPath = join(root, "replacement.jsonl");
		const firstEventId = eventId("replace-first");
		const externalEventId = eventId("replace-external");
		const log = new EventLog<TestEvent>(path);
		let fullReads = 0;
		setSecureFsTestHook((event) => {
			if (event.stage === "claim_journal_full_read") fullReads += 1;
		});
		log.append({ eventId: firstEventId, type: "replace" });
		writeFileSync(
			path,
			`${readFileSync(path, "utf8")}${JSON.stringify({ eventId: externalEventId, type: "replace" })}\n`,
		);
		writeFileSync(
			replacementPath,
			`${JSON.stringify({ eventId: firstEventId, state: "pending" })}\n${JSON.stringify({ eventId: firstEventId, state: "done" })}\n${JSON.stringify({ eventId: externalEventId, state: "pending" })}\n${JSON.stringify({ eventId: externalEventId, state: "done" })}\n`,
		);
		renameSync(replacementPath, journalPath);

		log.append({ eventId: externalEventId, type: "replace" });

		expect(fullReads).toBe(2);
		expect(log.readAll().filter((event) => event.eventId === externalEventId)).toHaveLength(1);
	});

	it("claim journal 截断尾部在锁内回退到完整换行后继续追加", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const log = new EventLog<TestEvent>(path);
		const firstEventId = eventId("journal-truncated-first");
		const secondEventId = eventId("journal-truncated-second");
		log.append({ eventId: firstEventId, type: "journal" });
		writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")}{"eventId":"broken`, "utf8");

		log.append({ eventId: secondEventId, type: "journal" });

		const journalLines = readFileSync(journalPath, "utf8").trim().split("\n");
		expect(() => journalLines.map((line) => JSON.parse(line))).not.toThrow();
		expect(journalLines.filter((line) => line.includes(secondEventId))).toHaveLength(2);
		expect(log.readAll().map((event) => event.eventId)).toEqual([firstEventId, secondEventId]);
	});

	it("claim journal 完整损坏行返回 journal 路径和稳定字节位置", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const valid = `${JSON.stringify({ eventId: eventId("valid-claim"), state: "pending" })}\n`;
		writeFileSync(path, "", "utf8");
		writeFileSync(journalPath, `${valid}{"eventId":\n`, "utf8");

		try {
			new EventLog<TestEvent>(path).append({ eventId: eventId("after-broken-claim"), type: "blocked" });
			expect.unreachable("完整损坏 claim 必须 fail-closed");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			expect(error).toMatchObject({ path: journalPath });
			const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
			expect(secureCause.cause).toMatchObject({
				path: journalPath,
				line: 2,
				offset: Buffer.byteLength(valid),
				reason: "malformed_claim_json",
			});
		}
	});

	it("claim journal 超过单行上限时返回稳定损坏诊断且不按总长度分配", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		writeFileSync(path, "", "utf8");
		writeFileSync(journalPath, Buffer.concat([Buffer.alloc(64 * 1024 + 1, 0x78), Buffer.from("\n")]));

		try {
			new EventLog<TestEvent>(path).append({ eventId: eventId("after-oversized-claim"), type: "blocked" });
			expect.unreachable("超长 claim 行必须 fail-closed");
		} catch (error) {
			expect(error).toBeInstanceOf(EvidencePersistenceError);
			const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
			expect(secureCause.cause).toMatchObject({
				path: journalPath,
				line: 1,
				offset: 0,
				reason: "claim_line_too_long",
			});
		}
	});

	it("10 万事件 claim journal 保持单文件线性审计并满足宽松冷启动预算", () => {
		const policy = (
			secureFsSource as typeof secureFsSource & {
				CLAIM_JOURNAL_CAPACITY_POLICY?: {
					baselineEvents: number;
					maxBaselineBytes: number;
					maxColdStartMs: number;
					readChunkBytes: number;
					maxLineBytes: number;
					persistence: string;
				};
			}
		).CLAIM_JOURNAL_CAPACITY_POLICY;
		expect(policy).toBeDefined();
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const journalPath = join(root, ".events.jsonl.claims.jsonl");
		const count = policy?.baselineEvents ?? 100_000;
		const eventIds = Array.from({ length: count }, (_, index) => indexedEventId(index));
		writeFileSync(
			path,
			eventIds.map((currentEventId) => `${JSON.stringify({ eventId: currentEventId, type: "capacity" })}\n`).join(""),
		);
		writeFileSync(
			journalPath,
			eventIds
				.map(
					(currentEventId) =>
						`${JSON.stringify({ eventId: currentEventId, state: "pending" })}\n${JSON.stringify({ eventId: currentEventId, state: "done" })}\n`,
				)
				.join(""),
		);
		let maxReadChunkBytes = 0;
		let maxCarryBytes = 0;
		setSecureFsTestHook((event) => {
			const detail = event as unknown as {
				stage: string;
				maxReadChunkBytes?: number;
				maxCarryBytes?: number;
			};
			if (detail.stage !== "claim_journal_stream_stats") return;
			maxReadChunkBytes = Math.max(maxReadChunkBytes, detail.maxReadChunkBytes ?? 0);
			maxCarryBytes = Math.max(maxCarryBytes, detail.maxCarryBytes ?? 0);
		});
		const startedAt = performance.now();
		new EventLog<TestEvent>(path).append({ eventId: eventIds[0] as string, type: "capacity" });
		const coldStartMs = performance.now() - startedAt;

		expect(policy?.persistence).toBe("append_only_linear_audit");
		expect(statSync(journalPath).size).toBeLessThanOrEqual(policy?.maxBaselineBytes ?? 0);
		expect(coldStartMs).toBeLessThanOrEqual(policy?.maxColdStartMs ?? 0);
		expect(maxReadChunkBytes).toBeGreaterThan(0);
		expect(maxReadChunkBytes).toBeLessThanOrEqual(policy?.readChunkBytes ?? 0);
		expect(maxCarryBytes).toBeLessThanOrEqual(policy?.maxLineBytes ?? 0);
		expect(readdirSync(root).filter((name) => name.includes("claims"))).toEqual([".events.jsonl.claims.jsonl"]);
	}, 30_000);

	it("旧 claim/checkpoint 在日志锁内迁移到 journal 后删除旧目录且保持幂等", () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const oldDirectory = join(root, ".events.jsonl.claims");
		mkdirSync(oldDirectory);
		const doneEventId = eventId("legacy-done");
		const pendingEventId = eventId("legacy-pending");
		writeFileSync(path, `${JSON.stringify({ eventId: doneEventId, type: "legacy" })}\n`, "utf8");
		writeFileSync(
			join(oldDirectory, ".checkpoint.json"),
			`${JSON.stringify({ version: 1, eventIds: [doneEventId] })}\n`,
		);
		writeFileSync(
			join(oldDirectory, `${createHash("sha256").update(pendingEventId).digest("hex")}.claim`),
			`pending ${pendingEventId}\n`,
		);

		const log = new EventLog<TestEvent>(path);
		log.append({ eventId: doneEventId, type: "legacy" });
		log.append({ eventId: pendingEventId, type: "legacy" });

		expect(existsSync(oldDirectory)).toBeFalse();
		expect(existsSync(join(root, ".events.jsonl.claims.jsonl"))).toBeTrue();
		const physicalLines = readFileSync(path, "utf8").trim().split("\n");
		expect(physicalLines).toHaveLength(2);
		expect(physicalLines.filter((line) => line.includes(doneEventId))).toHaveLength(1);
		expect(physicalLines.filter((line) => line.includes(pendingEventId))).toHaveLength(1);
	});

	it("旧状态写入 journal 后迁移进程崩溃，重启只完成旧目录清理", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const oldDirectory = join(root, ".events.jsonl.claims");
		const ready = join(root, "migration-ready");
		const migratedEventId = eventId("legacy-migration-crash");
		mkdirSync(oldDirectory);
		writeFileSync(path, `${JSON.stringify({ eventId: migratedEventId, type: "legacy" })}\n`, "utf8");
		writeFileSync(
			join(oldDirectory, ".checkpoint.json"),
			`${JSON.stringify({ version: 1, eventIds: [migratedEventId] })}\n`,
		);
		const secureFsModule = new URL("../../src/evidence/secure-fs.ts", import.meta.url).href;
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "legacy_claims_persisted") return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(migratedEventId)}, type: "legacy" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;
		expect(existsSync(oldDirectory)).toBeTrue();

		new EventLog<TestEvent>(path).append({ eventId: migratedEventId, type: "legacy" });

		expect(existsSync(oldDirectory)).toBeFalse();
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		const journalLines = readFileSync(join(root, ".events.jsonl.claims.jsonl"), "utf8").trim().split("\n");
		expect(journalLines.filter((line) => line.includes(migratedEventId))).toHaveLength(1);
	}, 10_000);

	it.each(["claim_created", "event_appended"] as const)(
		"journal %s 崩溃窗口恢复后事件不丢不重",
		async (crashStage) => {
			const root = temporaryRoot();
			const path = join(root, "events.jsonl");
			const ready = join(root, "ready");
			const crashEventId = eventId(`journal-${crashStage}`);
			const secureFsModule = new URL("../../src/evidence/secure-fs.ts", import.meta.url).href;
			const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== ${JSON.stringify(crashStage)}) return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(crashEventId)}, type: "journal" });
		`;
			const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
			const deadline = Date.now() + 10_000;
			while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
			expect(existsSync(ready)).toBeTrue();
			child.kill("SIGKILL");
			await child.exited;

			const reopened = new EventLog<TestEvent>(path);
			reopened.append({ eventId: crashEventId, type: "journal" });
			const physicalLines = readFileSync(path, "utf8").trim().split("\n");
			expect(physicalLines).toHaveLength(1);
			expect(physicalLines.filter((line) => line.includes(crashEventId))).toHaveLength(1);
		},
		20_000,
	);

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

	it("读取同一 UUID 的大小写记录时仅小写作为直接幂等键，大写按完整原始行稳定规范化", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const lowercase = "550e8400-e29b-41d4-a716-446655440000";
		const uppercase = lowercase.toUpperCase();
		const lowercaseLine = JSON.stringify({ eventId: lowercase, type: "lowercase" });
		const uppercaseLine = JSON.stringify({ eventId: uppercase, type: "legacy-uppercase" });
		writeFileSync(path, `${lowercaseLine}\n${uppercaseLine}\n${uppercaseLine}\n`, "utf8");
		const expectedLegacyId = deterministicEvidenceEventId(`legacy_event\0${uppercaseLine}`);

		const first = new EventLog<TestEvent>(path).readAll();
		const second = new EventLog<TestEvent>(path).readAll();

		expect(first.map((event) => event.eventId)).toEqual([lowercase, expectedLegacyId]);
		expect(first.some((event) => event.eventId === uppercase)).toBeFalse();
		expect(expectedLegacyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(second).toEqual(first);
	});

	it("完整损坏行不会吞掉其后的合法事件，并返回可审计位置", () => {
		const path = join(temporaryRoot(), "events.jsonl");
		const first = JSON.stringify({ eventId: eventId("before-malformed"), type: "valid" });
		const malformed = '{"eventId":"broken"';
		const last = JSON.stringify({ eventId: eventId("after-malformed"), type: "valid" });
		const original = `${first}\n${malformed}\n${last}\n`;
		writeFileSync(path, original, "utf8");
		const log = new EventLog<TestEvent>(path);

		for (const operation of [
			() => log.readAll(),
			() => log.append({ eventId: eventId("must-not-append"), type: "blocked" }),
		]) {
			try {
				operation();
				expect.unreachable("完整损坏行必须 fail-closed");
			} catch (error) {
				expect(error).toBeInstanceOf(EvidencePersistenceError);
				const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
				expect(secureCause.cause).toMatchObject({
					line: 2,
					offset: Buffer.byteLength(`${first}\n`),
					reason: "malformed_json",
				});
			}
		}
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it.each(
		[
			{
				name: "伪 eventId",
				mutate: (record: Record<string, unknown>) => ({
					...record,
					eventId: deterministicEvidenceEventId("forged-recovery-id"),
				}),
			},
			{
				name: "伪 truncatedBytes",
				mutate: (record: Record<string, unknown>) => ({
					...record,
					truncatedBytes: (record.truncatedBytes as number) + 1,
				}),
			},
			{
				name: "缺少 timestamp",
				mutate: (record: Record<string, unknown>) => {
					const { timestamp: _timestamp, ...missingTimestamp } = record;
					return missingTimestamp;
				},
			},
			{
				name: "非法 timestamp",
				mutate: (record: Record<string, unknown>) => ({ ...record, timestamp: "not-an-iso-timestamp" }),
			},
			{
				name: "关联到其他损坏内容",
				mutate: (record: Record<string, unknown>) => ({
					...record,
					eventId: deterministicEvidenceEventId("recovery_truncated_tail\0different-corrupt-content"),
				}),
			},
		].map(({ name, mutate }) => [name, mutate] as const),
	)("伪造 recovery（%s）不能掩盖完整损坏行", (_name, mutate) => {
		const path = join(temporaryRoot(), "events.jsonl");
		const valid = JSON.stringify({ eventId: eventId("before-forged-recovery"), type: "valid" });
		const malformed = '{"eventId":"broken"';
		const recoverySource = `${valid}\n${malformed}`;
		const genuineRecovery: Record<string, unknown> = {
			eventId: deterministicEvidenceEventId(`recovery_truncated_tail\0${recoverySource}`),
			type: "recovery_truncated_tail",
			timestamp: "2026-07-18T00:00:00.000Z",
			truncatedBytes: Buffer.byteLength(malformed),
		};
		const forged = mutate(genuineRecovery);
		const original = `${recoverySource}\n${JSON.stringify(forged)}\n`;
		writeFileSync(path, original, "utf8");
		const log = new EventLog<TestEvent>(path);

		for (const operation of [
			() => log.readAll(),
			() => log.append({ eventId: eventId("must-not-follow-forged-recovery"), type: "blocked" }),
		]) {
			try {
				operation();
				expect.unreachable("伪造 recovery 必须 fail-closed");
			} catch (error) {
				expect(error).toBeInstanceOf(EvidencePersistenceError);
				const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
				expect(secureCause.cause).toMatchObject({
					line: 2,
					offset: Buffer.byteLength(`${valid}\n`),
					reason: "malformed_json",
				});
			}
		}
		expect(readFileSync(path, "utf8")).toBe(original);
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

	it.each([
		["单字节 0xE2", Buffer.from([0xe2])],
		["截断中文多字节", Buffer.from("中").subarray(0, 2)],
	] as const)("原始字节尾部（%s）在 readAll 与 append 路径均可恢复", (_name, tail) => {
		const valid = Buffer.from(
			`${JSON.stringify({ eventId: eventId(`raw-prefix-${tail.toString("hex")}`), type: "valid" })}\n`,
		);
		const readPath = join(temporaryRoot(), "read-events.jsonl");
		writeFileSync(readPath, Buffer.concat([valid, tail]));
		const readLog = new EventLog<TestEvent>(readPath);
		const firstRead = readLog.readAll();
		const secondRead = readLog.readAll();
		const readRecovery = firstRead.find((event) => event.type === "recovery_truncated_tail");
		expect(readRecovery).toMatchObject({ truncatedBytes: tail.byteLength });
		expect(secondRead).toEqual(firstRead);
		expect(
			readFileSync(readPath)
				.toString("utf8")
				.match(/recovery_truncated_tail/g),
		).toHaveLength(1);

		const appendPath = join(temporaryRoot(), "append-events.jsonl");
		writeFileSync(appendPath, Buffer.concat([valid, tail]));
		const appendLog = new EventLog<TestEvent>(appendPath);
		const appendedId = eventId(`raw-appended-${tail.toString("hex")}`);
		appendLog.append({ eventId: appendedId, type: "appended" });
		const appendEvents = appendLog.readAll();
		expect(appendEvents.find((event) => event.type === "recovery_truncated_tail")).toMatchObject({
			truncatedBytes: tail.byteLength,
		});
		expect(appendEvents.filter((event) => event.eventId === appendedId)).toHaveLength(1);
		expect(
			readFileSync(appendPath)
				.toString("utf8")
				.match(/recovery_truncated_tail/g),
		).toHaveLength(1);
	});

	it("约 60 MiB 事件日志的单字节和多字节截断尾部均以有界流式读取恢复", async () => {
		const root = temporaryRoot();
		const basePath = join(root, "large-base.jsonl");
		const repeated = Buffer.from(
			`${JSON.stringify({ eventId: eventId("large-prefix"), type: "large", payload: "x".repeat(60 * 1024) })}\n`,
		);
		const descriptor = openSync(basePath, "w");
		try {
			const repeats = Math.ceil((60 * 1024 * 1024) / repeated.byteLength);
			for (let index = 0; index < repeats; index += 1) writeSync(descriptor, repeated);
		} finally {
			closeSync(descriptor);
		}

		for (const [name, tail] of [
			["single-byte", Buffer.from([0xe2])],
			["multi-byte", Buffer.from("中").subarray(0, 2)],
		] as const) {
			const path = join(root, `${name}.jsonl`);
			copyFileSync(basePath, path);
			appendFileSync(path, tail);
			let maxReadChunkBytes = 0;
			let maxCarryBytes = 0;
			setSecureFsTestHook((event) => {
				const detail = event as unknown as {
					stage: string;
					maxReadChunkBytes?: number;
					maxCarryBytes?: number;
				};
				if (detail.stage !== "tail_recovery_stream_stats") return;
				maxReadChunkBytes = Math.max(maxReadChunkBytes, detail.maxReadChunkBytes ?? 0);
				maxCarryBytes = Math.max(maxCarryBytes, detail.maxCarryBytes ?? 0);
			});
			const appendedId = eventId(`large-${name}`);
			const log = new EventLog<TestEvent>(path);

			log.append({ eventId: appendedId, type: "appended" });
			const events = log.readAll();

			expect(maxReadChunkBytes).toBeGreaterThan(0);
			expect(maxReadChunkBytes).toBeLessThanOrEqual(64 * 1024);
			expect(maxCarryBytes).toBeLessThanOrEqual(64 * 1024);
			expect(events.filter((event) => event.type === "recovery_truncated_tail")).toHaveLength(1);
			expect(events.some((event) => event.eventId === appendedId)).toBeTrue();
			expect(await countFileOccurrences(path, '"type":"recovery_truncated_tail"')).toBe(1);
		}
	}, 30_000);

	it("不同非法尾字节生成不同的确定性 recovery eventId", () => {
		const ids = [0xe2, 0xe3].map((byte) => {
			const path = join(temporaryRoot(), `events-${byte}.jsonl`);
			writeFileSync(path, Buffer.concat([Buffer.from('{"eventId":"valid","type":"first"}\n'), Buffer.from([byte])]));
			return new EventLog<TestEvent>(path).readAll().find((event) => event.type === "recovery_truncated_tail")?.eventId;
		});
		expect(ids[0]).toBeDefined();
		expect(ids[1]).toBeDefined();
		expect(ids[0]).not.toBe(ids[1]);
	});

	it.each(["first", "middle", "last"] as const)(
		"已验证 %s 行同 inode 等长损坏即使恢复 mtime 仍 fail-closed",
		(position) => {
			const path = join(temporaryRoot(), "events.jsonl");
			const log = new EventLog<TestEvent>(path);
			const events = [0, 1, 2].map((index) => ({ eventId: eventId(`in-place-${index}`), type: `line-${index}` }));
			for (const event of events) log.append(event);
			log.readAll();
			const lines = readFileSync(path).toString("utf8").trimEnd().split("\n");
			const lineIndex = position === "first" ? 0 : position === "middle" ? 1 : 2;
			const offset = lines.slice(0, lineIndex).reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
			const before = statSync(path);
			const descriptor = openSync(path, "r+");
			try {
				writeSync(descriptor, Buffer.from("!"), 0, 1, offset);
			} finally {
				closeSync(descriptor);
			}
			utimesSync(path, before.atime, before.mtime);

			try {
				log.append({ eventId: eventId(`after-in-place-${position}`), type: "blocked" });
				expect.unreachable("已验证前缀原位损坏必须 fail-closed");
			} catch (error) {
				expect(error).toBeInstanceOf(EvidencePersistenceError);
				const secureCause = (error as Error & { cause?: unknown }).cause as Error & { cause?: unknown };
				expect(secureCause.cause).toMatchObject({ line: lineIndex + 1, offset, reason: "malformed_json" });
			}
		},
	);

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

	it("多进程并发恢复返回对象逐字段等于规范磁盘 recovery", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const barrier = join(root, "start");
		writeFileSync(path, '{"eventId":"valid","type":"first"}\n{"eventId":"broken', "utf8");
		const script = `
			import { existsSync, writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			while (!existsSync(process.argv[3])) await Bun.sleep(2);
			const recovery = new EventLog(process.argv[1]).readAll().find((event) => event.type === "recovery_truncated_tail");
			writeFileSync(process.argv[2], JSON.stringify(recovery));
		`;
		const children = Array.from({ length: 12 }, (_, index) => {
			const output = join(root, `recovery-${index}.json`);
			return {
				output,
				child: Bun.spawn([process.execPath, "-e", script, path, output, barrier], { stderr: "pipe" }),
			};
		});
		writeFileSync(barrier, "start", "utf8");
		for (const { child } of children) {
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		}
		const canonical = new EventLog<TestEvent>(path).readAll().find((event) => event.type === "recovery_truncated_tail");
		for (const { output } of children) {
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(canonical);
		}
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
