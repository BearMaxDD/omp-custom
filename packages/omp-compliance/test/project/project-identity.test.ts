import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectContext } from "../../src/project/project-context";
import {
	PROJECT_IDENTITY_INVALID_ERROR,
	type ProjectBinding,
	ProjectIdentityStore,
	normalizeRemoteIdentity,
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

function readBinding(root: string): ProjectBinding {
	return JSON.parse(readFileSync(bindingPath(root), "utf8")) as ProjectBinding;
}

describe("ProjectIdentityStore", () => {
	it("creates one credential-free UUID binding atomically and reuses it", () => {
		const root = initGit("https://github.com/acme/platform/widget.git");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		const first = ProjectIdentityStore.open(nested);
		const second = ProjectIdentityStore.open(root);

		expect(first.status).toBe("bound");
		expect(first.binding.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(second.binding.projectId).toBe(first.binding.projectId);
		expect(first.binding.gitRemoteIdentity).toBe("github.com/acme/platform/widget");
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

	it("creates exactly one identity under concurrent first open", async () => {
		const root = initGit("https://github.com/acme/widget.git");
		const modulePath = join(import.meta.dir, "../../src/project/project-identity.ts");
		const script = `import { ProjectIdentityStore } from ${JSON.stringify(modulePath)}; console.log(ProjectIdentityStore.open(${JSON.stringify(root)}).binding.projectId);`;
		const processes = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" }),
		);

		const ids = new Set(
			await Promise.all(
				processes.map(async (process) => {
					const output = await new Response(process.stdout).text();
					expect(await process.exited).toBe(0);
					return output.trim();
				}),
			),
		);
		const leftovers = readdirSync(join(root, ".omp", "compliance")).map((name) =>
			join(root, ".omp", "compliance", name),
		);

		expect(ids.size).toBe(1);
		expect(leftovers).toEqual([bindingPath(root)]);
		expect(ids.has(readBinding(root).projectId)).toBe(true);
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

	it("does not recover a lock owned by a live process", async () => {
		const root = initGit();
		const directory = join(root, ".omp", "compliance");
		mkdirSync(directory, { recursive: true });
		const lockPath = join(directory, ".project.lock");
		const token = randomUUID();
		writeFileSync(lockPath, JSON.stringify({ token, pid: process.pid, createdAt: new Date(0).toISOString() }));
		const modulePath = join(import.meta.dir, "../../src/project/project-identity.ts");
		const script = `import { ProjectIdentityStore } from ${JSON.stringify(modulePath)}; ProjectIdentityStore.open(${JSON.stringify(root)});`;
		const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe", stdout: "pipe" });
		await Bun.sleep(100);
		child.kill();
		await child.exited;

		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(token);
		expect(existsSync(bindingPath(root))).toBe(false);
	});
});

describe("normalizeRemoteIdentity", () => {
	it.each([
		["https://github.com/acme/platform/widget.git", "github.com/acme/platform/widget"],
		["ssh://git@github.com/acme/platform/widget.git", "github.com/acme/platform/widget"],
		["ssh://git@github.com:22/acme/platform/widget.git", "github.com/acme/platform/widget"],
		["git@github.com:acme/platform/widget.git", "github.com/acme/platform/widget"],
		["https://github.com:443/acme/platform/widget.git", "github.com/acme/platform/widget"],
		["ssh://git@[2001:db8::1]:2222/acme/widget.git", "[2001:db8::1]:2222/acme/widget"],
		["https://GitHub.COM/acme/%77idget.git", "github.com/acme/widget"],
	])("normalizes %s", (remote, expected) => {
		expect(normalizeRemoteIdentity(remote)).toBe(expected);
	});

	it("keeps host, port, and the full namespace collision-resistant", () => {
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

	it.each([
		"https://user:password@host.example/org/repo.git",
		"user:password@host.example:org/repo.git",
		"https://host.example/org/%2Frepo.git",
		"https://host.example/org/%ZZrepo.git",
		"https://host.example/org/../repo.git",
		"host.example:repo.git",
		"not a remote",
	])("fails closed for ambiguous remote %s", (remote) => {
		expect(normalizeRemoteIdentity(remote)).toBeUndefined();
	});

	it("never persists credentials from an unsafe remote", () => {
		const root = initGit("https://token-user:secret-token@github.com/acme/widget.git");
		const result = ProjectIdentityStore.open(root);
		const persisted = readFileSync(bindingPath(root), "utf8");

		expect(result.binding.gitRemoteIdentity).toBeUndefined();
		expect(persisted).not.toContain("token-user");
		expect(persisted).not.toContain("secret-token");
	});
});

describe("createProjectContext", () => {
	it("returns an immutable narrow context with explicit project and session identity", () => {
		const context = createProjectContext({
			projectId: randomUUID(),
			root: "/repo",
			remote: "acme/widget",
			codebaseProject: "codebase-acme-widget",
			sessionId: randomUUID(),
			cwd: "/repo/packages/app",
		});

		expect(context).toEqual({
			projectId: expect.any(String),
			root: "/repo",
			remote: "acme/widget",
			codebaseProject: "codebase-acme-widget",
			sessionId: expect.any(String),
			cwd: "/repo/packages/app",
		});
		expect(Object.isFrozen(context)).toBe(true);
		expect("switchProject" in context).toBe(false);
	});

	it.each([
		["projectId", {}],
		["projectId", "not-a-uuid"],
		["root", "relative/path"],
		["root", ""],
		["remote", ""],
		["remote", {}],
		["codebaseProject", ""],
		["sessionId", "not-a-uuid"],
		["cwd", "relative/path"],
	])("rejects invalid runtime field %s", (field, value) => {
		expect(() =>
			createProjectContext({
				projectId: randomUUID(),
				root: "/repo",
				remote: "github.com/acme/widget",
				codebaseProject: "codebase-acme-widget",
				sessionId: randomUUID(),
				cwd: "/repo/app",
				[field]: value,
			} as never),
		).toThrow("OMP project context is invalid");
	});
});
