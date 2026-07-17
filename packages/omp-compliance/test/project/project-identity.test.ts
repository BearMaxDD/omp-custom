import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectContext } from "../../src/project/project-context";
import {
	PROJECT_IDENTITY_INVALID_ERROR,
	type ProjectBinding,
	ProjectIdentityStore,
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
		const root = initGit("https://token-user:secret-token@github.com/acme/widget.git");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		const first = ProjectIdentityStore.open(nested);
		const second = ProjectIdentityStore.open(root);
		const persisted = readFileSync(bindingPath(root), "utf8");

		expect(first.status).toBe("bound");
		expect(first.binding.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(second.binding.projectId).toBe(first.binding.projectId);
		expect(first.binding.gitRemoteIdentity).toBe("acme/widget");
		expect(persisted).not.toContain("token-user");
		expect(persisted).not.toContain("secret-token");
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
		const leftovers = execFileSync("find", [join(root, ".omp", "compliance"), "-maxdepth", "1", "-type", "f"], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean);

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
});

describe("createProjectContext", () => {
	it("returns an immutable narrow context with explicit project and session identity", () => {
		const context = createProjectContext({
			projectId: randomUUID(),
			root: "/repo",
			remote: "acme/widget",
			codebaseProject: "codebase-acme-widget",
			sessionId: "session-1",
			cwd: "/repo/packages/app",
		});

		expect(context).toEqual({
			projectId: expect.any(String),
			root: "/repo",
			remote: "acme/widget",
			codebaseProject: "codebase-acme-widget",
			sessionId: "session-1",
			cwd: "/repo/packages/app",
		});
		expect(Object.isFrozen(context)).toBe(true);
		expect("switchProject" in context).toBe(false);
	});
});
