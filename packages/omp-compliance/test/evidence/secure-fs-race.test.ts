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
import { EventLog } from "../../src/evidence/event-log";
import { EvidenceTaskRepository } from "../../src/evidence/evidence-repository";
import { setSecureFsTestHook } from "../../src/evidence/secure-fs";

const roots: string[] = [];
const eventLogModule = new URL("../../src/evidence/event-log.ts", import.meta.url).href;
const secureFsModule = new URL("../../src/evidence/secure-fs.ts", import.meta.url).href;

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-secure-fs-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	setSecureFsTestHook(undefined);
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("Evidence secure filesystem", () => {
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
			task.events.append({ eventId: "event-1", type: "completion" });
		}

		expect(readdirSync(outside)).toEqual([]);
		expect(existsSync(join(parked, kind === "state" ? "state.json" : "events.jsonl"))).toBeTrue();
	});

	it("持锁进程崩溃后内核释放锁且后续追加可恢复", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== "lock_acquired") return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: "blocked", type: "test" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: "after-crash", type: "completion" });
		expect(log.readAll().map((event) => event.eventId)).toContain("after-crash");
	});

	it.each(["claim_created", "event_appended"] as const)("%s 后进程崩溃时相同事件恢复后不丢不重", async (stage) => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
		const script = `
			import { writeFileSync } from "node:fs";
			import { EventLog } from ${JSON.stringify(eventLogModule)};
			import { setSecureFsTestHook } from ${JSON.stringify(secureFsModule)};
			setSecureFsTestHook((event) => {
				if (event.stage !== ${JSON.stringify(stage)}) return;
				writeFileSync(process.argv[2], "ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			});
			new EventLog(process.argv[1]).append({ eventId: "crash-event", type: "completion" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: "crash-event", type: "completion" });
		const physicalEvents = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes('"eventId":"crash-event"'));
		expect(physicalEvents).toHaveLength(1);
		expect(log.readAll().filter((event) => event.eventId === "crash-event")).toHaveLength(1);
	});

	it("截断恢复落盘后进程崩溃时重试仍保留 recovery 和新事件各一次", async () => {
		const root = temporaryRoot();
		const path = join(root, "events.jsonl");
		const ready = join(root, "ready");
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
			new EventLog(process.argv[1]).append({ eventId: "good-after-tail", type: "completion" });
		`;
		const child = Bun.spawn([process.execPath, "-e", script, path, ready], { stderr: "pipe" });
		const deadline = Date.now() + 5_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(ready)).toBeTrue();
		child.kill("SIGKILL");
		await child.exited;

		const log = new EventLog(path);
		log.append({ eventId: "good-after-tail", type: "completion" });
		const physicalLines = readFileSync(path, "utf8").split("\n");
		expect(physicalLines.filter((line) => line.includes('"type":"recovery_truncated_tail"'))).toHaveLength(1);
		expect(physicalLines.filter((line) => line.includes('"eventId":"good-after-tail"'))).toHaveLength(1);
	});
});
