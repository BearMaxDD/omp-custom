import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, deterministicEvidenceEventId } from "../../src/evidence/event-log";
import { EvidenceTaskRepository } from "../../src/evidence/evidence-repository";
import {
	getSecureFsEintrTestRemaining,
	setSecureFsEintrTestPlan,
	setSecureFsTestHook,
} from "../../src/evidence/secure-fs";
import { SnapshotStore } from "../../src/evidence/snapshot-store";

const roots: string[] = [];
const eventLogModule = new URL("../../src/evidence/event-log.ts", import.meta.url).href;
const secureFsModule = new URL("../../src/evidence/secure-fs.ts", import.meta.url).href;
const snapshotStoreModule = new URL("../../src/evidence/snapshot-store.ts", import.meta.url).href;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-secure-fs-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	setSecureFsTestHook(undefined);
	setSecureFsEintrTestPlan(undefined);
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("Evidence secure filesystem", () => {
	it("writer 与 recover 共享快照锁且不会删除活跃临时文件", async () => {
		const root = temporaryRoot();
		const path = join(root, "state.json");
		const ready = join(root, "writer-ready");
		const release = join(root, "writer-release");
		const writerResult = join(root, "writer-result.json");
		const recoverStarted = join(root, "recover-started");
		const recoverResult = join(root, "recover-result.json");
		const writerScript = `
			import { existsSync, writeFileSync } from "node:fs";
			import { SnapshotStore } from ${JSON.stringify(snapshotStoreModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "snapshot_temp_synced") return;
				writeFileSync(process.argv[2], "ready");
				while (!existsSync(process.argv[3])) {}
			});
			let writerFailures = 0;
			try { new SnapshotStore(process.argv[1]).write({ attempt: 1 }); } catch { writerFailures += 1; }
			writeFileSync(process.argv[4], JSON.stringify({ writerFailures }));
		`;
		const recoverScript = `
			import { writeFileSync } from "node:fs";
			import { SnapshotStore } from ${JSON.stringify(snapshotStoreModule)};
			writeFileSync(process.argv[2], "started");
			let recoverFailures = 0;
			try { new SnapshotStore(process.argv[1]).recover(); } catch { recoverFailures += 1; }
			writeFileSync(process.argv[3], JSON.stringify({ recoverFailures }));
		`;
		const writer = Bun.spawn([process.execPath, "-e", writerScript, path, ready, release, writerResult], {
			stderr: "pipe",
		});
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		const recoverer = Bun.spawn([process.execPath, "-e", recoverScript, path, recoverStarted, recoverResult], {
			stderr: "pipe",
		});
		while (!existsSync(recoverStarted) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(recoverStarted)).toBeTrue();
		await Bun.sleep(50);
		writeFileSync(release, "release");
		const [writerExit, recoverExit, writerError, recoverError] = await Promise.all([
			writer.exited,
			recoverer.exited,
			new Response(writer.stderr).text(),
			new Response(recoverer.stderr).text(),
		]);

		expect({ writerExit, recoverExit, writerError, recoverError }).toEqual({
			writerExit: 0,
			recoverExit: 0,
			writerError: "",
			recoverError: "",
		});
		expect(JSON.parse(readFileSync(writerResult, "utf8"))).toEqual({ writerFailures: 0 });
		expect(JSON.parse(readFileSync(recoverResult, "utf8"))).toEqual({ recoverFailures: 0 });
		expect(new SnapshotStore(path).read()).toEqual({ attempt: 1 });
		expect(readdirSync(root).filter((name) => /^\.state\.json\..+\.tmp$/.test(name))).toEqual([]);
	});

	it("多进程高循环 writer 与 recover 均无失败且最终快照合法", async () => {
		const root = temporaryRoot();
		const path = join(root, "state.json");
		const barrier = join(root, "start");
		const script = `
			import { existsSync, writeFileSync } from "node:fs";
			import { SnapshotStore } from ${JSON.stringify(snapshotStoreModule)};
			while (!existsSync(process.argv[3])) {}
			const store = new SnapshotStore(process.argv[1]);
			let failures = 0;
			const errors = [];
			for (let index = 0; index < 250; index += 1) {
				try {
					if (process.argv[2] === "writer") store.write({ pid: process.pid, index });
					else store.recover();
				} catch (error) {
					failures += 1;
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			writeFileSync(process.argv[4], JSON.stringify({ role: process.argv[2], failures, errors }));
		`;
		const processes = Array.from({ length: 8 }, (_, index) => {
			const role = index < 4 ? "writer" : "recover";
			return {
				role,
				result: join(root, `result-${index}.json`),
				child: Bun.spawn([process.execPath, "-e", script, path, role, barrier, join(root, `result-${index}.json`)], {
					stderr: "pipe",
				}),
			};
		});
		writeFileSync(barrier, "start");
		let writerFailures = 0;
		let recoverFailures = 0;
		for (const processInfo of processes) {
			const [exitCode, stderr] = await Promise.all([
				processInfo.child.exited,
				new Response(processInfo.child.stderr).text(),
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			const result = JSON.parse(readFileSync(processInfo.result, "utf8")) as {
				role: string;
				failures: number;
				errors: unknown[];
			};
			expect(result.errors).toEqual([]);
			if (result.role === "writer") writerFailures += result.failures;
			else recoverFailures += result.failures;
		}

		expect({ writerFailures, recoverFailures }).toEqual({ writerFailures: 0, recoverFailures: 0 });
		expect(new SnapshotStore(path).read()).toMatchObject({ pid: expect.any(Number), index: expect.any(Number) });
		expect(readdirSync(root).filter((name) => /^\.state\.json\..+\.tmp$/.test(name))).toEqual([]);
	}, 30_000);

	it("快照锁持有进程崩溃后由内核释放并允许继续写入恢复", async () => {
		const root = temporaryRoot();
		const path = join(root, "state.json");
		const ready = join(root, "ready");
		const script = `
			import { writeFileSync } from "node:fs";
			import { SnapshotStore } from ${JSON.stringify(snapshotStoreModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "snapshot_lock_acquired") return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new SnapshotStore(process.argv[1]).write({ blocked: true });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const store = new SnapshotStore(path);
		store.write({ recovered: true });
		store.recover();
		expect(store.read()).toEqual({ recovered: true });
	});

	it("所有可中断 POSIX 调用遇到一次或多次 EINTR 后无重复写及锁泄漏", () => {
		const root = temporaryRoot();
		const snapshotPath = join(root, "state.json");
		const logPath = join(root, "events.jsonl");
		const tempName = ".state.json.550e8400-e29b-41d4-a716-446655440000.tmp";
		writeFileSync(join(root, tempName), "partial");
		setSecureFsEintrTestPlan({
			open: 1,
			openat: 3,
			mkdirat: 1,
			renameat: 2,
			unlinkat: 1,
			fstat: 2,
			fsync: 3,
			fchmod: 1,
			close: 3,
			write: 3,
			read: 2,
			pread: 1,
			flock: 3,
			lseek: 2,
		});

		const snapshot = new SnapshotStore(snapshotPath);
		snapshot.write({ value: 1 });
		expect(snapshot.read()).toEqual({ value: 1 });
		snapshot.recover();
		const log = new EventLog(logPath);
		const firstId = deterministicEvidenceEventId("eintr-first");
		const secondId = deterministicEvidenceEventId("eintr-second");
		log.append({ eventId: firstId, type: "test" });
		log.append({ eventId: secondId, type: "test" });
		expect(log.readAll().map((event) => event.eventId)).toEqual([firstId, secondId]);
		expect(getSecureFsEintrTestRemaining()).toEqual({});

		setSecureFsEintrTestPlan(undefined);
		log.append({ eventId: firstId, type: "test" });
		expect(readFileSync(logPath, "utf8").match(new RegExp(firstId, "g"))).toHaveLength(1);
	});
	it.each(["state", "events"] as const)("父目录在锚定后被替换时 %s 不写入外部", (kind) => {
		const root = temporaryRoot();
		const outside = join(root, "outside");
		const parked = join(root, "parked-task");
		mkdirSync(outside);
		const task = new EvidenceTaskRepository(join(root, "evidence"), "task-race");
		let replaced = false;
		setSecureFsTestHook((event) => {
			if (event.stage !== "directory_opened" || replaced) return;
			replaced = true;
			renameSync(task.paths.root, parked);
			symlinkSync(outside, task.paths.root, "dir");
		});

		if (kind === "state") {
			task.state.write({ status: "running" });
		} else {
			task.events.append({ eventId: deterministicEvidenceEventId("directory-replaced"), type: "completion" });
		}

		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(parked, kind === "state" ? "state.json" : "events.jsonl"))).toBeTrue();
	});

	it("持锁进程崩溃后内核释放锁且后续追加可恢复", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
		const blockedEventId = deterministicEvidenceEventId("blocked");
		const afterCrashEventId = deterministicEvidenceEventId("after-crash");
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "lock_acquired") return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(blockedEventId)}, type: "test" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: afterCrashEventId, type: "completion" });
		expect(log.readAll().map((event) => event.eventId)).toContain(afterCrashEventId);
	});

	it.each(["claim_created", "event_appended"] as const)("%s 后进程崩溃时相同事件恢复后不丢不重", async (stage) => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
		const crashEventId = deterministicEvidenceEventId("crash-event");
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== ${JSON.stringify(stage)}) return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(crashEventId)}, type: "completion" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: crashEventId, type: "completion" });
		const physicalEvents = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes(`"eventId":"${crashEventId}"`));
		expect(physicalEvents).toHaveLength(1);
		expect(log.readAll().filter((event) => event.eventId === crashEventId)).toHaveLength(1);
	});

	it("截断恢复落盘后进程崩溃时重试仍保留 recovery 和新事件各一次", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
		const goodEventId = deterministicEvidenceEventId("good-after-tail");
		writeFileSync(path, '{"eventId":"valid","type":"first"}\n{"eventId":"broken', "utf8");
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "tail_recovered") return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: ${JSON.stringify(goodEventId)}, type: "completion" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: goodEventId, type: "completion" });
		const physicalLines = readFileSync(path, "utf8").split("\n");
		expect(physicalLines.filter((line) => line.includes('"type":"recovery_truncated_tail"'))).toHaveLength(1);
		expect(physicalLines.filter((line) => line.includes(`"eventId":"${goodEventId}"`))).toHaveLength(1);
	});
});
