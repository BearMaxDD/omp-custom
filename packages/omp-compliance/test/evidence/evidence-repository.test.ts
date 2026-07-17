import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidencePersistenceError } from "../../src/evidence/event-log";
import { EvidenceRepository, type EvidenceTaskState } from "../../src/evidence/evidence-repository";
import { SnapshotStore } from "../../src/evidence/snapshot-store";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-evidence-repository-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("EvidenceRepository", () => {
	it("使用固定任务布局并在实际写入前不创建目录", () => {
		const root = join(temporaryRoot(), "repository");
		const repository = new EvidenceRepository(root);
		const task = repository.task("task-123");

		expect(task.paths).toEqual({
			root: join(root, "tasks", "task-123"),
			state: join(root, "tasks", "task-123", "state.json"),
			contract: join(root, "tasks", "task-123", "contract.json"),
			events: join(root, "tasks", "task-123", "events.jsonl"),
			reviews: join(root, "tasks", "task-123", "reviews"),
			codebase: join(root, "tasks", "task-123", "codebase"),
			delegations: join(root, "tasks", "task-123", "delegations"),
			topics: join(root, "tasks", "task-123", "topics"),
			overrides: join(root, "tasks", "task-123", "overrides.jsonl"),
		});
		expect(existsSync(root)).toBe(false);

		task.state.write({ status: "active", attempt: 1 });
		expect(existsSync(task.paths.state)).toBe(true);
		expect(existsSync(task.paths.contract)).toBe(false);
		expect(existsSync(task.paths.reviews)).toBe(false);
	});

	it.each(["../escape", "task/child", "/absolute", "", ".", "..", "task\\child"])("拒绝不安全 taskId：%s", (taskId) => {
		const repository = new EvidenceRepository(temporaryRoot());
		expect(() => repository.task(taskId)).toThrow("Invalid evidence taskId");
	});

	it("仅在请求制品目录时创建指定目录", () => {
		const task = new EvidenceRepository(temporaryRoot()).task("task-1");

		const reviews = task.ensureArtifactDirectory("reviews");

		expect(reviews).toBe(task.paths.reviews);
		expect(existsSync(task.paths.reviews)).toBe(true);
		expect(existsSync(task.paths.codebase)).toBe(false);
		expect(existsSync(task.paths.delegations)).toBe(false);
		expect(existsSync(task.paths.topics)).toBe(false);
	});

	it("仓库事件日志与快照可重新打开恢复", () => {
		const root = temporaryRoot();
		const first = new EvidenceRepository(root).task("task-1");
		const state: EvidenceTaskState = { status: "active", attempt: 2 };
		first.state.write(state);
		first.events.append({ eventId: "event-1", type: "task_started" });

		const reopened = new EvidenceRepository(root).task("task-1");
		expect(reopened.state.read<EvidenceTaskState>()).toEqual(state);
		expect(reopened.events.readAll()).toEqual([{ eventId: "event-1", type: "task_started" }]);
	});

	it("底层关键持久化失败保持 EvidencePersistenceError", () => {
		const root = temporaryRoot();
		const tasksPath = join(root, "tasks");
		writeFileSync(tasksPath, "blocked", "utf8");
		const task = new EvidenceRepository(root).task("task-1");

		expect(() => task.state.write({ status: "active", attempt: 1 })).toThrow(EvidencePersistenceError);
	});
});

describe("SnapshotStore", () => {
	it("使用唯一临时文件原子替换并清理自身临时文件", async () => {
		const root = temporaryRoot();
		const path = join(root, "state.json");
		const store = new SnapshotStore(path);

		await Promise.all(
			Array.from({ length: 16 }, (_, attempt) =>
				Promise.resolve().then(() => store.write({ status: "active", attempt })),
			),
		);

		const value = store.read<EvidenceTaskState>();
		expect(value?.status).toBe("active");
		expect(value?.attempt).toBeGreaterThanOrEqual(0);
		expect(value?.attempt).toBeLessThan(16);
		expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("快照读取失败不会伪装成不存在", () => {
		const root = temporaryRoot();
		const path = join(root, "state.json");
		mkdirSync(path);

		expect(() => new SnapshotStore(path).read()).toThrow(EvidencePersistenceError);
	});
});
