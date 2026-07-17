import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createProjectContext } from "../../src/project/project-context";
import {
	PROJECT_IDENTITY_INVALID_ERROR,
	type ProjectBinding,
	ProjectIdentityStore,
	normalizeRemoteIdentity,
	readProjectBindingIfPresent,
} from "../../src/project/project-identity";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { force: true, recursive: true });
});

function tempProject(): string {
	const path = join(tmpdir(), `omp-project-${randomUUID()}`);
	mkdirSync(path, { recursive: true });
	cleanup.push(path);
	return path;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initGit(remote?: string): string {
	const root = tempProject();
	git(root, "init", "--quiet");
	if (remote) git(root, "remote", "add", "origin", remote);
	return root;
}

function bindingPath(root: string): string {
	return join(root, ".omp", "compliance", "project.json");
}

function lockWaitScript(root: string, readyPath: string, operation: string): string {
	const modulePath = join(import.meta.dir, "../../src/project/project-identity.ts");
	return `import { writeFileSync } from "node:fs"; import { ProjectIdentityStore, setProjectIdentityLockWaitObserverForTests } from ${JSON.stringify(modulePath)}; const root = ${JSON.stringify(root)}; let ready = false; setProjectIdentityLockWaitObserverForTests(() => { if (!ready) { ready = true; writeFileSync(${JSON.stringify(readyPath)}, "ready"); } }); ${operation}`;
}

async function waitForLockWait(readyPath: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!existsSync(readyPath)) {
		if (Date.now() >= deadline) throw new Error(`Child did not enter the lock wait path: ${readyPath}`);
		await Bun.sleep(5);
	}
}

function readBinding(root: string): ProjectBinding {
	return JSON.parse(readFileSync(bindingPath(root), "utf8")) as ProjectBinding;
}

describe("ProjectIdentityStore", () => {
	it("wraps a missing cwd in the stable project identity error", () => {
		const cwd = join(tempProject(), "missing");
		let thrown: unknown;
		try {
			ProjectIdentityStore.open(cwd);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(PROJECT_IDENTITY_INVALID_ERROR);
		expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
		expect((thrown as Error & { cause?: { code?: string } }).cause?.code).toBe("ENOENT");
	});

	it("wraps a non-string cwd in the stable project identity error", () => {
		let thrown: unknown;
		try {
			ProjectIdentityStore.open(undefined as never);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(PROJECT_IDENTITY_INVALID_ERROR);
		expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError);
	});

	it("creates one credential-free UUID binding atomically and reuses it", () => {
		const root = initGit("https://github.com/acme/platform/widget.git");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		const first = ProjectIdentityStore.open(nested);
		const second = ProjectIdentityStore.open(root);

		expect(first.status).toBe("bound");
		expect(first.binding.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(second.binding.projectId).toBe(first.binding.projectId);
		expect(first.binding.gitRemoteIdentity).toBe("git-remote:v1://github.com/acme/platform/widget");
		expect(existsSync(`${bindingPath(root)}.tmp`)).toBe(false);
	});

	it("returns rebind_required when a moved root has the same normalized remote", () => {
		const original = initGit("git@github.com:acme/widget.git");
		const initial = ProjectIdentityStore.open(original);
		const moved = `${original}-moved`;
		renameSync(original, moved);
		cleanup.splice(cleanup.indexOf(original), 1, moved);

		const reopened = ProjectIdentityStore.open(moved);

		expect(reopened.status).toBe("rebind_required");
		expect(reopened.binding.projectId).toBe(initial.binding.projectId);
		expect(reopened.binding.canonicalRoot).toBe(initial.binding.canonicalRoot);
		expect(readBinding(moved)).toEqual(initial.binding);
	});

	it("returns project_mismatch when the remote identity changes", () => {
		const root = initGit("https://github.com/acme/widget.git");
		const initial = ProjectIdentityStore.open(root);
		git(root, "remote", "set-url", "origin", "https://github.com/acme/other.git");

		const reopened = ProjectIdentityStore.open(root);

		expect(reopened.status).toBe("project_mismatch");
		expect(reopened.binding).toEqual(initial.binding);
		expect(readBinding(root)).toEqual(initial.binding);
	});

	it("returns project_mismatch when a non-git SSH user changes", () => {
		const root = initGit("alice@git.example.com:repos/widget.git");
		const initial = ProjectIdentityStore.open(root);
		git(root, "remote", "set-url", "origin", "bob@git.example.com:repos/widget.git");

		const reopened = ProjectIdentityStore.open(root);

		expect(initial.binding.gitRemoteIdentity).toBe("git-remote:v1://alice@git.example.com/repos/widget");
		expect(reopened.status).toBe("project_mismatch");
		expect(reopened.observedRemote).toBe("git-remote:v1://bob@git.example.com/repos/widget");
		expect(reopened.binding.projectId).toBe(initial.binding.projectId);
	});

	it("returns project_mismatch when an SSH URL port changes to an SCP numeric path", () => {
		const root = initGit("ssh://git@git.example.com:2222/team/repo.git");
		const initial = ProjectIdentityStore.open(root);
		git(root, "remote", "set-url", "origin", "git@git.example.com:2222/team/repo.git");

		const reopened = ProjectIdentityStore.open(root);

		expect(initial.binding.gitRemoteIdentity).toBe("git-remote:v1://git.example.com!2222/team/repo");
		expect(reopened.observedRemote).toBe("git-remote:v1://git.example.com/2222/team/repo");
		expect(reopened.status).toBe("project_mismatch");
	});

	it("uses a non-Git cwd as the stable root and supports a missing remote", () => {
		const root = tempProject();
		const nested = join(root, "nested");
		mkdirSync(nested);

		const first = ProjectIdentityStore.open(nested);
		const second = ProjectIdentityStore.open(nested);

		expect(first.status).toBe("bound");
		expect(first.binding.canonicalRoot).toBe(realpathSync(nested));
		expect(first.binding.gitRemoteIdentity).toBeUndefined();
		expect(second.binding.projectId).toBe(first.binding.projectId);
	});

	it("fails closed in a non-Git directory when the Git CLI is unavailable", () => {
		const root = tempProject();
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = root;
			expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		} finally {
			if (originalPath === undefined) Reflect.deleteProperty(process.env, "PATH");
			else process.env.PATH = originalPath;
		}

		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("fails closed below a repository with a corrupted .git marker", () => {
		const root = initGit();
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });
		rmSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, ".git"), "gitdir: /definitely/missing\n");

		expect(() => ProjectIdentityStore.open(nested)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		expect(existsSync(bindingPath(nested))).toBe(false);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("ignores Git environment variables that redirect repository A to repository B", () => {
		const rootA = initGit("https://git.example.com/team/a.git");
		const rootB = initGit("https://git.example.com/team/b.git");
		const originalGitDir = process.env.GIT_DIR;
		const originalGitWorkTree = process.env.GIT_WORK_TREE;
		try {
			process.env.GIT_DIR = join(rootB, ".git");
			process.env.GIT_WORK_TREE = rootB;
			const result = ProjectIdentityStore.open(rootA);
			expect(result.binding.canonicalRoot).toBe(realpathSync(rootA));
			expect(result.binding.gitRemoteIdentity).toBe("git-remote:v1://git.example.com/team/a");
		} finally {
			if (originalGitDir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
			else process.env.GIT_DIR = originalGitDir;
			if (originalGitWorkTree === undefined) Reflect.deleteProperty(process.env, "GIT_WORK_TREE");
			else process.env.GIT_WORK_TREE = originalGitWorkTree;
		}

		expect(existsSync(bindingPath(rootA))).toBe(true);
		expect(existsSync(bindingPath(rootB))).toBe(false);
	});

	it("does not redirect a non-Git project A into Git repository B", () => {
		const rootA = tempProject();
		const rootB = initGit("https://git.example.com/team/b.git");
		const originalGitDir = process.env.GIT_DIR;
		const originalGitWorkTree = process.env.GIT_WORK_TREE;
		try {
			process.env.GIT_DIR = join(rootB, ".git");
			process.env.GIT_WORK_TREE = rootB;
			const result = ProjectIdentityStore.open(rootA);
			expect(result.binding.canonicalRoot).toBe(realpathSync(rootA));
			expect(result.binding.gitRemoteIdentity).toBeUndefined();
		} finally {
			if (originalGitDir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
			else process.env.GIT_DIR = originalGitDir;
			if (originalGitWorkTree === undefined) Reflect.deleteProperty(process.env, "GIT_WORK_TREE");
			else process.env.GIT_WORK_TREE = originalGitWorkTree;
		}

		expect(existsSync(bindingPath(rootA))).toBe(true);
		expect(existsSync(bindingPath(rootB))).toBe(false);
	});

	it("ignores global insteadOf rewrites and persists the local remote URL identity", () => {
		const root = initGit("https://local.example/team/widget.git");
		const globalConfig = join(tempProject(), "global.gitconfig");
		execFileSync(
			"git",
			["config", "--file", globalConfig, "url.https://polluted.example/mirror/.insteadOf", "https://local.example/"],
			{ encoding: "utf8" },
		);
		const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
		try {
			process.env.GIT_CONFIG_GLOBAL = globalConfig;
			const first = ProjectIdentityStore.open(root);
			expect(first.status).toBe("bound");
			expect(first.binding.gitRemoteIdentity).toBe("git-remote:v1://local.example/team/widget");
		} finally {
			if (originalGlobalConfig === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
			else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
		}

		const reopened = ProjectIdentityStore.open(root);
		expect(reopened.status).toBe("bound");
		expect(reopened.observedRemote).toBe("git-remote:v1://local.example/team/widget");
	});

	it("prefers origin and otherwise sorts local remote names", () => {
		const withOrigin = initGit("https://git.example.com/team/origin.git");
		git(withOrigin, "remote", "add", "aaa", "https://git.example.com/team/aaa.git");
		expect(ProjectIdentityStore.open(withOrigin).observedRemote).toBe("git-remote:v1://git.example.com/team/origin");

		const withoutOrigin = initGit();
		git(withoutOrigin, "remote", "add", "zeta", "https://git.example.com/team/zeta.git");
		git(withoutOrigin, "remote", "add", "alpha", "https://git.example.com/team/alpha.git");
		expect(ProjectIdentityStore.open(withoutOrigin).observedRemote).toBe("git-remote:v1://git.example.com/team/alpha");
	});

	it("does not infer identity after moving a project without a remote", () => {
		const original = initGit();
		const initial = ProjectIdentityStore.open(original);
		const moved = `${original}-moved`;
		renameSync(original, moved);
		cleanup.splice(cleanup.indexOf(original), 1, moved);

		const reopened = ProjectIdentityStore.open(moved);

		expect(reopened.status).toBe("project_mismatch");
		expect(reopened.binding.projectId).toBe(initial.binding.projectId);
	});

	it.each([
		"not-a-remote",
		"foo/team/repo",
		"../team/repo",
		"./team/repo",
		"/srv/git/team/repo.git",
		"file:///srv/git/team/repo.git",
		"git-remote:v1://git.example.com/team/repo",
		"https://host.example/org/%ZZrepo.git",
		"https://host.example/org/%252Frepo.git",
	])("refuses a configured remote that cannot form a canonical identity: %s", (remote) => {
		const root = initGit(remote);

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("creates exactly one identity in 20 concurrent first-open rounds", async () => {
		const modulePath = join(import.meta.dir, "../../src/project/project-identity.ts");
		for (let round = 0; round < 20; round += 1) {
			const root = initGit("https://github.com/acme/widget.git");
			const script = `import { ProjectIdentityStore } from ${JSON.stringify(modulePath)}; console.log(ProjectIdentityStore.open(${JSON.stringify(root)}).binding.projectId);`;
			const processes = Array.from({ length: 8 }, () =>
				Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" }),
			);
			const results = await Promise.all(
				processes.map(async (process) => {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(process.stdout).text(),
						new Response(process.stderr).text(),
						process.exited,
					]);
					return { exitCode, stderr, stdout: stdout.trim() };
				}),
			);
			const ids = new Set(results.map((result) => result.stdout));
			const leftovers = readdirSync(join(root, ".omp", "compliance")).map((name) =>
				join(root, ".omp", "compliance", name),
			);

			expect(results.map(({ exitCode, stderr }) => ({ exitCode, stderr }))).toEqual(
				Array.from({ length: 8 }, () => ({ exitCode: 0, stderr: "" })),
			);
			expect(ids.size).toBe(1);
			expect(leftovers).toEqual([bindingPath(root)]);
			expect(ids.has(readBinding(root).projectId)).toBe(true);
		}
	});

	it("fails closed for corrupted identity JSON", () => {
		const root = initGit();
		mkdirSync(join(root, ".omp", "compliance"), { recursive: true });
		writeFileSync(bindingPath(root), '{"schemaVersion":1,"projectId":', "utf8");

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		expect(readFileSync(bindingPath(root), "utf8")).toBe('{"schemaVersion":1,"projectId":');
	});

	it("fails closed for structurally invalid identity JSON", () => {
		const root = initGit();
		mkdirSync(join(root, ".omp", "compliance"), { recursive: true });
		writeFileSync(bindingPath(root), JSON.stringify({ schemaVersion: 1, projectId: "not-a-uuid" }), "utf8");

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
	});

	it("rejects a spoofed codebase project before persistence", () => {
		const root = initGit();

		expect(() => ProjectIdentityStore.open(root, { codebaseProjectId: {} } as never)).toThrow(
			PROJECT_IDENTITY_INVALID_ERROR,
		);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it.each([
		["unknown field", { extra: true }],
		["non-exact schema version", { schemaVersion: "1" }],
		["non-ISO createdAt", { createdAt: "2026-01-01" }],
		["relative canonical root", { canonicalRoot: "repo" }],
		["empty remote", { gitRemoteIdentity: "" }],
		["legacy unprefixed remote", { gitRemoteIdentity: "git.example.com/team/repo" }],
		["empty codebase project", { codebaseProjectId: "" }],
		["invalid rebound time", { reboundAt: "yesterday" }],
	])("rejects identity JSON with %s", (_case, override) => {
		const root = initGit();
		mkdirSync(join(root, ".omp", "compliance"), { recursive: true });
		writeFileSync(
			bindingPath(root),
			JSON.stringify({
				schemaVersion: 1,
				projectId: randomUUID(),
				canonicalRoot: realpathSync(root),
				createdAt: new Date().toISOString(),
				...override,
			}),
		);

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
	});

	it.each([".omp", join(".omp", "compliance")])("rejects a %s symlink before writing outside root", (component) => {
		const root = initGit();
		const outside = tempProject();
		if (component.includes("compliance")) mkdirSync(join(root, ".omp"));
		symlinkSync(outside, join(root, component), process.platform === "win32" ? "junction" : "dir");

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		expect(readdirSync(outside)).toEqual([]);
	});

	it("recovers a valid stale lock owned by a dead process", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		mkdirSync(directory, { recursive: true });
		const exitedOwner = Bun.spawn([process.execPath, "-e", ""], { stderr: "ignore", stdout: "ignore" });
		const deadPid = exitedOwner.pid;
		await exitedOwner.exited;
		writeFileSync(
			join(directory, ".project.lock"),
			JSON.stringify({ token: randomUUID(), pid: deadPid, createdAt: new Date(0).toISOString() }),
		);

		const result = ProjectIdentityStore.open(root);

		expect(result.status).toBe("bound");
		expect(existsSync(join(directory, ".project.lock"))).toBe(false);
	});

	it.each(["", '{"token":'])("recovers a stale malformed lock: %j", (content) => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		writeFileSync(lockPath, content);
		const staleTime = new Date(Date.now() - 60_000);
		utimesSync(lockPath, staleTime, staleTime);

		const result = ProjectIdentityStore.open(root);

		expect(result.status).toBe("bound");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not remove a recent malformed lock while its creator may still be writing", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		writeFileSync(lockPath, '{"token":');
		const before = statSync(lockPath);
		const readyPath = join(root, ".malformed-lock-wait-ready");
		const script = lockWaitScript(root, readyPath, "ProjectIdentityStore.open(root);");
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		const after = statSync(lockPath);
		child.kill();
		await child.exited;

		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(readFileSync(lockPath, "utf8")).toBe('{"token":');
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("recovers a stale lock whose PID belongs to a newer process instance", () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date(0).toISOString() }),
		);
		const staleTime = new Date(0);
		utimesSync(lockPath, staleTime, staleTime);

		const result = ProjectIdentityStore.open(root);

		expect(result.status).toBe("bound");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers a stale lock with an out-of-range owner PID", () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		const staleTime = new Date(Date.now() - 60_000);
		writeFileSync(
			lockPath,
			JSON.stringify({ token: randomUUID(), pid: Number.MAX_SAFE_INTEGER, createdAt: staleTime.toISOString() }),
		);
		utimesSync(lockPath, staleTime, staleTime);

		const result = ProjectIdentityStore.open(root);

		expect(result.status).toBe("bound");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("recovers an expired lock when the owner process probe is unknown", () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		const unknownPid = 123_456;
		const staleTime = new Date(Date.now() - 60_000);
		writeFileSync(
			lockPath,
			JSON.stringify({ token: randomUUID(), pid: unknownPid, createdAt: staleTime.toISOString() }),
		);
		utimesSync(lockPath, staleTime, staleTime);
		const originalKill = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid === unknownPid && signal === 0)
				throw Object.assign(new Error("unknown process state"), { code: "EINVAL" });
			return originalKill(pid, signal as never);
		}) as typeof process.kill;

		try {
			const result = ProjectIdentityStore.open(root);
			expect(result.status).toBe("bound");
		} finally {
			process.kill = originalKill;
		}
		expect(existsSync(lockPath)).toBe(false);
	});

	it("does not remove a recent lock with an unverified owner PID", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ token: randomUUID(), pid: Number.MAX_SAFE_INTEGER, createdAt: new Date().toISOString() }),
		);
		const before = statSync(lockPath);
		const readyPath = join(root, ".unknown-owner-lock-wait-ready");
		const script = lockWaitScript(root, readyPath, "ProjectIdentityStore.open(root);");
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		const after = statSync(lockPath);
		child.kill();
		await child.exited;

		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("does not recover a lock owned by a live process", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		mkdirSync(directory, { recursive: true });
		const lockPath = join(directory, ".project.lock");
		const token = randomUUID();
		writeFileSync(lockPath, JSON.stringify({ token, pid: process.pid, createdAt: new Date(0).toISOString() }));
		const readyPath = join(root, ".live-owner-lock-wait-ready");
		const script = lockWaitScript(root, readyPath, "ProjectIdentityStore.open(root);");
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		child.kill();
		await child.exited;

		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(token);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("fails closed if the storage directories are replaced while waiting for the lock", async () => {
		const root = initGit();
		const ompDirectory = join(root, ".omp");
		const directory = join(ompDirectory, "compliance");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, ".project.lock"),
			JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }),
		);
		const readyPath = join(root, ".replace-storage-lock-wait-ready");
		const script = lockWaitScript(root, readyPath, "ProjectIdentityStore.open(root);");
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		renameSync(ompDirectory, join(root, ".omp-replaced"));
		mkdirSync(directory, { recursive: true });
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain(PROJECT_IDENTITY_INVALID_ERROR);
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("uses the stable error when storage disappears while waiting for the lock", async () => {
		const root = initGit();
		const ompDirectory = join(root, ".omp");
		const directory = join(ompDirectory, "compliance");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, ".project.lock"),
			JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }),
		);
		const readyPath = join(root, ".remove-storage-lock-wait-ready");
		const script = lockWaitScript(
			root,
			readyPath,
			"try { ProjectIdentityStore.open(root); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }",
		);
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		renameSync(ompDirectory, join(root, ".omp-disappeared"));
		const stderr = await new Response(child.stderr).text();

		expect(await child.exited).toBe(2);
		expect(stderr).toContain(PROJECT_IDENTITY_INVALID_ERROR);
		expect(stderr).not.toContain("ENOENT:");
		expect(existsSync(bindingPath(root))).toBe(false);
	});

	it("does not clobber a binding that appears while another opener waits", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		const lockPath = join(directory, ".project.lock");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }),
		);
		const expected = {
			schemaVersion: 1,
			projectId: randomUUID(),
			canonicalRoot: realpathSync(root),
			createdAt: new Date().toISOString(),
		} as const;
		const readyPath = join(root, ".publish-binding-lock-wait-ready");
		const script = lockWaitScript(root, readyPath, "console.log(ProjectIdentityStore.open(root).binding.projectId);");
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await waitForLockWait(readyPath);
		writeFileSync(bindingPath(root), `${JSON.stringify(expected)}\n`);
		unlinkSync(lockPath);
		const stdout = await new Response(child.stdout).text();

		expect(await child.exited).toBe(0);
		expect(stdout.trim()).toBe(expected.projectId);
		expect(readBinding(root)).toEqual(expected);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("fails closed when project.json is replaced after its fd is opened", () => {
		const root = initGit();
		const initial = ProjectIdentityStore.open(root);
		const filePath = bindingPath(root);
		const replacementPath = `${filePath}.replacement`;
		writeFileSync(
			replacementPath,
			`${JSON.stringify({ ...initial.binding, projectId: randomUUID(), createdAt: new Date().toISOString() })}\n`,
		);

		expect(() =>
			readProjectBindingIfPresent(filePath, (path, flags) => {
				const fd = openSync(path, flags);
				renameSync(replacementPath, filePath);
				return fd;
			}),
		).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
	});

	it("fails closed after an equal-length in-place write restores the original mtime", () => {
		const root = initGit();
		const initial = ProjectIdentityStore.open(root);
		const filePath = bindingPath(root);
		const originalContent = readFileSync(filePath, "utf8");
		const replacementContent = originalContent.replace(initial.binding.projectId, randomUUID());
		const originalStats = statSync(filePath);
		expect(replacementContent.length).toBe(originalContent.length);

		expect(() =>
			readProjectBindingIfPresent(filePath, (path, flags) => {
				const fd = openSync(path, flags);
				writeFileSync(path, replacementContent);
				utimesSync(path, originalStats.atimeMs / 1_000, originalStats.mtimeMs / 1_000);
				return fd;
			}),
		).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
	});

	it("fails closed when the opened project.json fd is not a regular file", () => {
		const root = initGit();
		ProjectIdentityStore.open(root);
		const filePath = bindingPath(root);
		const directory = join(root, ".omp", "compliance");

		expect(() => readProjectBindingIfPresent(filePath, (_path, flags) => openSync(directory, flags))).toThrow(
			PROJECT_IDENTITY_INVALID_ERROR,
		);
	});

	it("fails closed when storage directories are replaced during binding read", () => {
		const root = initGit();
		ProjectIdentityStore.open(root);
		const filePath = bindingPath(root);
		const ompDirectory = join(root, ".omp");

		expect(() =>
			readProjectBindingIfPresent(filePath, (path, flags) => {
				const fd = openSync(path, flags);
				renameSync(ompDirectory, join(root, ".omp-during-read"));
				mkdirSync(join(ompDirectory, "compliance"), { recursive: true });
				return fd;
			}),
		).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
	});
});

describe("normalizeRemoteIdentity", () => {
	it.each([
		["https://github.com/acme/platform/widget.git", "git-remote:v1://github.com/acme/platform/widget"],
		["ssh://git@github.com/acme/platform/widget.git", "git-remote:v1://github.com/acme/platform/widget"],
		["ssh://git@github.com:22/acme/platform/widget.git", "git-remote:v1://github.com/acme/platform/widget"],
		["git@github.com:acme/platform/widget.git", "git-remote:v1://github.com/acme/platform/widget"],
		["https://github.com:443/acme/platform/widget.git", "git-remote:v1://github.com/acme/platform/widget"],
		["ssh://git@[2001:db8::1]:2222/acme/widget.git", "git-remote:v1://[2001:db8::1]!2222/acme/widget"],
		["https://GitHub.COM/acme/%77idget.git", "git-remote:v1://github.com/acme/widget"],
	])("normalizes %s", (remote, expected) => {
		const canonical = normalizeRemoteIdentity(remote);

		expect(canonical).toBe(expected);
		expect(normalizeRemoteIdentity(canonical as string)).toBe(canonical);
	});

	it("keeps host, port, and the full namespace collision-resistant", () => {
		const urlPort = normalizeRemoteIdentity("ssh://git@git.example.com:2222/team/repo.git");
		const scpPath = normalizeRemoteIdentity("git@git.example.com:2222/team/repo.git");
		expect(urlPort).toBe("git-remote:v1://git.example.com!2222/team/repo");
		expect(scpPath).toBe("git-remote:v1://git.example.com/2222/team/repo");
		expect(urlPort).not.toBe(scpPath);
		expect(normalizeRemoteIdentity(urlPort as string)).toBe(urlPort);
		expect(normalizeRemoteIdentity(scpPath as string)).toBe(scpPath);
		expect(normalizeRemoteIdentity("https://git.example.com:8443/team/platform/widget.git")).not.toBe(
			normalizeRemoteIdentity("https://git.example.com/team/platform/widget.git"),
		);
		expect(normalizeRemoteIdentity("https://git.example.com/team-a/platform/widget.git")).not.toBe(
			normalizeRemoteIdentity("https://git.example.com/team-b/platform/widget.git"),
		);
		expect(normalizeRemoteIdentity("https://one.example.com/team/widget.git")).not.toBe(
			normalizeRemoteIdentity("https://two.example.com/team/widget.git"),
		);
	});

	it("preserves non-git SSH users without breaking git and HTTPS compatibility", () => {
		const alice = normalizeRemoteIdentity("alice@git.example.com:repos/widget.git");
		const bob = normalizeRemoteIdentity("ssh://bob@git.example.com/repos/widget.git");
		const git = normalizeRemoteIdentity("git@git.example.com:repos/widget.git");
		const https = normalizeRemoteIdentity("https://git.example.com/repos/widget.git");

		expect(alice).toBe("git-remote:v1://alice@git.example.com/repos/widget");
		expect(bob).toBe("git-remote:v1://bob@git.example.com/repos/widget");
		expect(alice).not.toBe(bob);
		expect(git).toBe(https);
		expect(normalizeRemoteIdentity(alice as string)).toBe(alice);
		expect(normalizeRemoteIdentity(bob as string)).toBe(bob);
	});

	it("normalizes expanded URL and compressed SCP IPv6 hosts to one identity", () => {
		const url = normalizeRemoteIdentity("ssh://git@[2001:db8::1]/team/repo.git");
		const scp = normalizeRemoteIdentity("git@[2001:0db8:0:0:0:0:0:1]:team/repo.git");

		expect(url).toBe("git-remote:v1://[2001:db8::1]/team/repo");
		expect(scp).toBe(url);
		expect(normalizeRemoteIdentity(url as string)).toBe(url);
	});

	it("folds the git protocol default port 9418", () => {
		const explicit = normalizeRemoteIdentity("git://git.example.com:9418/team/repo.git");
		const implicit = normalizeRemoteIdentity("git://git.example.com/team/repo.git");

		expect(explicit).toBe("git-remote:v1://git.example.com/team/repo");
		expect(implicit).toBe(explicit);
		expect(normalizeRemoteIdentity(explicit as string)).toBe(explicit);
	});

	it("keeps canonical syntax disjoint from relative paths and raw network observations", () => {
		const canonical = normalizeRemoteIdentity("ssh://git@foo/team/repo.git");

		expect(canonical).toBe("git-remote:v1://foo/team/repo");
		expect(normalizeRemoteIdentity(canonical as string)).toBe(canonical);
		expect(normalizeRemoteIdentity("foo/team/repo")).toBeUndefined();
	});

	it("normalizes one DNS termination point and validates every DNS label", () => {
		expect(normalizeRemoteIdentity("https://git.example.com./team/repo.git")).toBe(
			normalizeRemoteIdentity("https://git.example.com/team/repo.git"),
		);
		for (const remote of [
			"ssh://git@./team/repo.git",
			"ssh://git@../team/repo.git",
			"https://git..example.com/team/repo.git",
			"https://-git.example.com/team/repo.git",
			"https://git-.example.com/team/repo.git",
			"https://git_example.com/team/repo.git",
		]) {
			expect(normalizeRemoteIdentity(remote)).toBeUndefined();
		}
	});

	it.each([
		["127.1", "127.0.0.1"],
		["2130706433", "127.0.0.1"],
		["0x7f000001", "127.0.0.1"],
	])("normalizes numeric IPv4 host %s identically for URL and SCP syntax", (host, canonicalHost) => {
		const url = normalizeRemoteIdentity(`ssh://git@${host}/team/repo.git`);
		const scp = normalizeRemoteIdentity(`git@${host}:team/repo.git`);

		expect(url).toBe(`git-remote:v1://${canonicalHost}/team/repo`);
		expect(scp).toBe(url);
	});

	it.each(["999.999.999.999", "256.1.1.1"])("rejects invalid numeric host %s in URL and SCP syntax", (host) => {
		expect(normalizeRemoteIdentity(`ssh://git@${host}/team/repo.git`)).toBeUndefined();
		expect(normalizeRemoteIdentity(`git@${host}:team/repo.git`)).toBeUndefined();
	});

	it.each([
		"foo/team/repo",
		"../team/repo",
		"./team/repo",
		"/srv/git/team/repo.git",
		"C:/git/team/repo.git",
		"file:///srv/git/team/repo.git",
		"https://user:password@host.example/org/repo.git",
		"user:password@host.example:org/repo.git",
		"https://host.example/org/%2Frepo.git",
		"https://host.example/org/%252Frepo.git",
		"https://host.example/org/%25252Frepo.git",
		"https://host.example/org/%255Crepo.git",
		"https://host.example/org/%ZZrepo.git",
		"https://host.example/org/../repo.git",
		"host.example:repo.git",
		"not a remote",
	])("fails closed for ambiguous remote %s", (remote) => {
		expect(normalizeRemoteIdentity(remote)).toBeUndefined();
	});

	it("refuses an unsafe credential-bearing remote without persisting an identity", () => {
		const root = initGit("https://token-user:secret-token@github.com/acme/widget.git");

		expect(() => ProjectIdentityStore.open(root)).toThrow(PROJECT_IDENTITY_INVALID_ERROR);
		expect(existsSync(bindingPath(root))).toBe(false);
	});
});

describe("createProjectContext", () => {
	it("derives an immutable narrow context from a bound store result", () => {
		const root = initGit("https://github.com/acme/widget.git");
		const identity = ProjectIdentityStore.open(root, { codebaseProjectId: "codebase-acme-widget" });
		const cwd = join(identity.binding.canonicalRoot, "packages", "app");
		const sessionId = randomUUID();
		mkdirSync(cwd, { recursive: true });

		const context = createProjectContext(identity, sessionId, cwd);

		expect(context).toEqual({
			projectId: identity.binding.projectId,
			root: identity.binding.canonicalRoot,
			remote: "git-remote:v1://github.com/acme/widget",
			codebaseProject: "codebase-acme-widget",
			sessionId,
			cwd,
		});
		expect(Object.isFrozen(context)).toBe(true);
		expect("switchProject" in context).toBe(false);
	});

	it("rejects a bare ProjectBinding", () => {
		const root = realpathSync(tempProject());
		const binding: ProjectBinding = {
			schemaVersion: 1,
			projectId: randomUUID(),
			canonicalRoot: root,
			createdAt: new Date().toISOString(),
		};

		expect(() => createProjectContext(binding as never, randomUUID(), root)).toThrow("OMP project context is invalid");
	});

	it("rejects an unbranded copy of a bound result", () => {
		const root = initGit();
		const identity = ProjectIdentityStore.open(root);

		expect(() => createProjectContext({ ...identity }, randomUUID(), identity.observedRoot)).toThrow(
			"OMP project context is invalid",
		);
	});

	it("rejects a genuine rebind_required result", () => {
		const original = initGit("git@github.com:acme/widget.git");
		ProjectIdentityStore.open(original);
		const moved = `${original}-context-moved`;
		renameSync(original, moved);
		cleanup.splice(cleanup.indexOf(original), 1, moved);
		const identity = ProjectIdentityStore.open(moved);

		expect(identity.status).toBe("rebind_required");
		expect(() => createProjectContext(identity, randomUUID(), moved)).toThrow("OMP project context is invalid");
	});

	it("rejects a genuine project_mismatch result", () => {
		const root = initGit("https://github.com/acme/widget.git");
		ProjectIdentityStore.open(root);
		git(root, "remote", "set-url", "origin", "https://github.com/acme/other.git");
		const identity = ProjectIdentityStore.open(root);

		expect(identity.status).toBe("project_mismatch");
		expect(() => createProjectContext(identity, randomUUID(), root)).toThrow("OMP project context is invalid");
	});

	it("rejects a stale bound result after the repository remote changes", () => {
		const root = initGit("https://github.com/acme/widget.git");
		const staleBound = ProjectIdentityStore.open(root);
		git(root, "remote", "set-url", "origin", "https://github.com/acme/other.git");

		expect(ProjectIdentityStore.open(root).status).toBe("project_mismatch");
		expect(() => createProjectContext(staleBound, randomUUID(), root)).toThrow("OMP project context is invalid");
	});

	it("accepts an older bound result when a fresh store open still matches", () => {
		const root = initGit("https://github.com/acme/widget.git");
		const olderBound = ProjectIdentityStore.open(root, { codebaseProjectId: "codebase-widget" });

		expect(ProjectIdentityStore.open(root, { codebaseProjectId: "codebase-widget" }).status).toBe("bound");
		expect(createProjectContext(olderBound, randomUUID(), root).projectId).toBe(olderBound.binding.projectId);
	});

	it("rejects a cwd outside the binding root", () => {
		const root = initGit();
		const identity = ProjectIdentityStore.open(root);
		const outside = realpathSync(tempProject());

		expect(() => createProjectContext(identity, randomUUID(), outside)).toThrow("OMP project context is invalid");
	});

	it("accepts a native absolute cwd and canonicalizes it after realpath", () => {
		const root = initGit();
		const identity = ProjectIdentityStore.open(root);
		const expectedCwd = join(identity.binding.canonicalRoot, "packages", "app");
		mkdirSync(expectedCwd, { recursive: true });
		const nativeCwd = `${identity.binding.canonicalRoot}${sep}packages${sep}..${sep}packages${sep}app`;

		const context = createProjectContext(identity, randomUUID(), nativeCwd);

		expect(context.cwd).toBe(realpathSync(expectedCwd).split(sep).join("/"));
	});

	it("rejects a cwd symlink that escapes the binding root", () => {
		const root = initGit();
		const identity = ProjectIdentityStore.open(root);
		const outside = realpathSync(tempProject());
		const escaped = join(identity.binding.canonicalRoot, "escaped");
		symlinkSync(outside, escaped, process.platform === "win32" ? "junction" : "dir");

		expect(() => createProjectContext(identity, randomUUID(), escaped)).toThrow("OMP project context is invalid");
	});

	it.each(["not-a-uuid", {}])("rejects an invalid session id", (sessionId) => {
		const root = initGit();
		const identity = ProjectIdentityStore.open(root);

		expect(() => createProjectContext(identity, sessionId as never, root)).toThrow("OMP project context is invalid");
	});

	it("does not expose Task 9 internals from the package root", async () => {
		const rootApi = await import("../../src/index");

		expect(Object.keys(rootApi)).toEqual(["activate"]);
	});
});
