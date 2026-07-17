import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { join, resolve } from "node:path";
import { EvidencePersistenceError, deterministicEvidenceEventId } from "../../src/evidence/event-log";
import {
	EvidenceRepository,
	EvidenceTaskRepository,
	type EvidenceTaskState,
} from "../../src/evidence/evidence-repository";
import { setSecureFsTestHook } from "../../src/evidence/secure-fs";
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
	setSecureFsTestHook(undefined);
});

describe("EvidenceRepository", () => {
	it.each([".omp", "compliance", "repository"] as const)("构造前预置 %s symlink 时失败关闭且不写入外部", (target) => {
		const sandbox = temporaryRoot();
		const projectRoot = join(sandbox, "project");
		const outside = join(sandbox, "outside");
		mkdirSync(projectRoot);
		mkdirSync(outside);

		let repositoryRoot: string;
		if (target === ".omp") {
			symlinkSync(outside, join(projectRoot, ".omp"), "dir");
			repositoryRoot = join(projectRoot, ".omp", "compliance");
		} else if (target === "compliance") {
			mkdirSync(join(projectRoot, ".omp"));
			symlinkSync(outside, join(projectRoot, ".omp", "compliance"), "dir");
			repositoryRoot = join(projectRoot, ".omp", "compliance");
		} else {
			symlinkSync(outside, join(projectRoot, "repository"), "dir");
			repositoryRoot = join(projectRoot, "repository");
		}

		const repository = new EvidenceRepository(repositoryRoot);
		expect(() => repository.task("task-1").state.write({ status: "active", attempt: 1 })).toThrow(
			EvidencePersistenceError,
		);
		expect(readdirSync(outside)).toEqual([]);
	});

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
		});
		expect(existsSync(root)).toBe(false);

		task.state.write({ status: "active", attempt: 1 });
		expect(existsSync(task.paths.state)).toBe(true);
		expect(existsSync(task.paths.contract)).toBe(false);
		expect(existsSync(task.paths.reviews)).toBe(false);
	});

	it("兼容任意 basePath 时从最近已存在普通父目录锚定", () => {
		const root = join(temporaryRoot(), "missing-parent", "repository");
		const task = new EvidenceRepository(root).task("task-1");

		expect(existsSync(root)).toBe(false);
		task.state.write({ status: "active", attempt: 1 });
		expect(existsSync(task.paths.state)).toBe(true);
	});

	it.each(["../escape", "task/child", "/absolute", "", ".", "..", "task\\child"])("拒绝不安全 taskId：%s", (taskId) => {
		const repository = new EvidenceRepository(temporaryRoot());
		expect(() => repository.task(taskId)).toThrow("Invalid evidence taskId");
	});

	it.each(["../escape", "../../escape", "task/child", "task\\child", "/absolute"])(
		"公开任务仓库构造函数自身拒绝不安全 taskId：%s",
		(taskId) => {
			const root = join(temporaryRoot(), "repository");
			const candidate = taskId === "/absolute" ? resolve(root, "..", "absolute") : taskId;

			expect(() => new EvidenceTaskRepository(root, candidate)).toThrow("Invalid evidence taskId");
			expect(existsSync(root)).toBe(false);
		},
	);

	it.each(["state", "events", "reviews"] as const)("构造后 tasks 被替换为外部 symlink 时拒绝 %s 写入", (target) => {
		const sandbox = temporaryRoot();
		const root = join(sandbox, "repository");
		const outside = join(sandbox, "outside");
		const task = new EvidenceTaskRepository(root, "task-1");
		mkdirSync(root, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(root, "tasks"), "dir");

		const write = () => {
			if (target === "state") task.state.write({ status: "active", attempt: 1 });
			if (target === "events") {
				task.events.append({ eventId: deterministicEvidenceEventId("tasks-symlink"), type: "task_started" });
			}
			if (target === "reviews") task.ensureArtifactDirectory("reviews");
		};

		expect(write).toThrow(EvidencePersistenceError);
		expect(existsSync(join(outside, "task-1"))).toBe(false);
	});

	it.each(["state", "events", "reviews"] as const)("构造后 task 目录被替换为外部 symlink 时拒绝 %s 写入", (target) => {
		const sandbox = temporaryRoot();
		const root = join(sandbox, "repository");
		const outside = join(sandbox, "outside");
		const task = new EvidenceTaskRepository(root, "task-1");
		mkdirSync(join(root, "tasks"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(root, "tasks", "task-1"), "dir");

		const write = () => {
			if (target === "state") task.state.write({ status: "active", attempt: 1 });
			if (target === "events") {
				task.events.append({ eventId: deterministicEvidenceEventId("task-symlink"), type: "task_started" });
			}
			if (target === "reviews") task.ensureArtifactDirectory("reviews");
		};

		expect(write).toThrow(EvidencePersistenceError);
		expect(readdirSync(outside)).toEqual([]);
	});

	it("仅在请求制品目录时创建指定目录", () => {
		const task = new EvidenceRepository(temporaryRoot()).task("task-1");

		const reviews = task.ensureArtifactDirectory("reviews");

		expect(reviews).toBe(task.paths.reviews);
		expect(existsSync(task.paths.reviews)).toBe(true);
		expect(existsSync(task.paths.codebase)).toBe(false);
		expect(existsSync(task.paths.delegations)).toBe(false);
	});

	it("topic 与 overrides 使用 TRD 根级布局且构造无副作用", () => {
		const root = join(temporaryRoot(), "repository");
		const repository = new EvidenceRepository(root);
		const topic = repository.topic("topic-123");

		expect(topic.paths).toEqual({
			root: join(root, "topics", "topic-123"),
			state: join(root, "topics", "topic-123", "state.json"),
			events: join(root, "topics", "topic-123", "events.jsonl"),
			reviews: join(root, "topics", "topic-123", "reviews"),
		});
		expect(repository.overrides.path).toBe(join(root, "overrides.jsonl"));
		expect(existsSync(root)).toBe(false);
	});

	it.each(["../escape", "topic/child", "topic\\child", "/absolute", "", ".", ".."])(
		"拒绝不安全 topicId：%s",
		(topicId) => {
			expect(() => new EvidenceRepository(temporaryRoot()).topic(topicId)).toThrow("Invalid evidence topicId");
		},
	);

	it("recover 发现任务并清理合法崩溃临时快照且重复执行幂等", () => {
		const root = temporaryRoot();
		const firstTaskRoot = join(root, "tasks", "task-a");
		const secondTaskRoot = join(root, "tasks", "task-b");
		const topicRoot = join(root, "topics", "topic-a");
		mkdirSync(firstTaskRoot, { recursive: true });
		mkdirSync(secondTaskRoot, { recursive: true });
		mkdirSync(topicRoot, { recursive: true });
		const stateTemp = `.state.json.${randomUUID()}.tmp`;
		const contractTemp = `.contract.json.${randomUUID()}.tmp`;
		const topicStateTemp = `.state.json.${randomUUID()}.tmp`;
		const projectTemp = `.project.json.${randomUUID()}.tmp`;
		writeFileSync(join(firstTaskRoot, stateTemp), "partial", "utf8");
		writeFileSync(join(firstTaskRoot, contractTemp), "partial", "utf8");
		writeFileSync(join(topicRoot, topicStateTemp), "partial", "utf8");
		writeFileSync(join(root, projectTemp), "partial", "utf8");

		const repository = new EvidenceRepository(root);
		const first = repository.recover();
		const second = repository.recover();

		expect(first.taskIds).toEqual(["task-a", "task-b"]);
		expect(first.topicIds).toEqual(["topic-a"]);
		expect(first.cleanedTemporarySnapshots.sort()).toEqual(
			[
				join(firstTaskRoot, contractTemp),
				join(firstTaskRoot, stateTemp),
				join(root, projectTemp),
				join(topicRoot, topicStateTemp),
			].sort(),
		);
		expect(second).toEqual({ taskIds: ["task-a", "task-b"], topicIds: ["topic-a"], cleanedTemporarySnapshots: [] });
		expect(readdirSync(firstTaskRoot).sort()).toEqual([".contract.json.lock", ".state.json.lock"]);
	});

	it("仓库事件日志与快照可重新打开恢复", () => {
		const root = temporaryRoot();
		const first = new EvidenceRepository(root).task("task-1");
		const state: EvidenceTaskState = { status: "active", attempt: 2 };
		first.state.write(state);
		const eventId = deterministicEvidenceEventId("repository-reopen");
		first.events.append({ eventId, type: "task_started" });

		const reopened = new EvidenceRepository(root).task("task-1");
		expect(reopened.state.read<EvidenceTaskState>()).toEqual(state);
		expect(reopened.events.readAll()).toEqual([{ eventId, type: "task_started" }]);
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

	it("recover 只清理本快照合法 UUID 临时文件且不跟随 symlink", () => {
		const root = temporaryRoot();
		const outside = join(root, "outside.json");
		const path = join(root, "state.json");
		const validTemp = `.state.json.${randomUUID()}.tmp`;
		const symlinkTemp = `.state.json.${randomUUID()}.tmp`;
		writeFileSync(join(root, validTemp), "partial", "utf8");
		writeFileSync(join(root, ".state.json.not-a-uuid.tmp"), "unknown", "utf8");
		writeFileSync(join(root, ".contract.json.550e8400-e29b-41d4-a716-446655440000.tmp"), "other", "utf8");
		writeFileSync(outside, "outside", "utf8");
		symlinkSync(outside, join(root, symlinkTemp));

		const store = new SnapshotStore(path);
		expect(store.recover()).toEqual([join(root, validTemp)]);
		expect(store.recover()).toEqual([]);
		expect(readdirSync(root).sort()).toEqual(
			[
				".contract.json.550e8400-e29b-41d4-a716-446655440000.tmp",
				".state.json.lock",
				".state.json.not-a-uuid.tmp",
				symlinkTemp,
				"outside.json",
			].sort(),
		);
	});

	it("Repository recover 拒绝 tasks symlink 且不清理外部临时文件", () => {
		const sandbox = temporaryRoot();
		const root = join(sandbox, "repository");
		const outside = join(sandbox, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		const tempName = `.state.json.${randomUUID()}.tmp`;
		writeFileSync(join(outside, tempName), "outside", "utf8");
		symlinkSync(outside, join(root, "tasks"), "dir");

		expect(() => new EvidenceRepository(root).recover()).toThrow(EvidencePersistenceError);
		expect(readFileSync(join(outside, tempName), "utf8")).toBe("outside");
	});

	it("recover 名称发现后目录被替换时失败关闭且不删除外部文件", () => {
		const sandbox = temporaryRoot();
		const taskRoot = join(sandbox, "task");
		const movedTaskRoot = join(sandbox, "task-original");
		const outside = join(sandbox, "outside");
		mkdirSync(taskRoot);
		mkdirSync(outside);
		const tempName = `.state.json.${randomUUID()}.tmp`;
		writeFileSync(join(taskRoot, tempName), "inside", "utf8");
		writeFileSync(join(outside, tempName), "outside", "utf8");
		const store = new SnapshotStore(join(taskRoot, "state.json"));
		setSecureFsTestHook((event) => {
			if ((event as { stage: string }).stage !== "recovery_entries_listed") return;
			setSecureFsTestHook(undefined);
			renameSync(taskRoot, movedTaskRoot);
			symlinkSync(outside, taskRoot, "dir");
		});

		expect(() => store.recover()).toThrow(EvidencePersistenceError);
		expect(readFileSync(join(outside, tempName), "utf8")).toBe("outside");
		expect(readFileSync(join(movedTaskRoot, tempName), "utf8")).toBe("inside");
	});
});
