import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { join, normalize, sep } from "node:path";

export const PROJECT_IDENTITY_INVALID_ERROR = "OMP project identity is invalid; compliance activation refused";

export interface ProjectBinding {
	readonly schemaVersion: 1;
	readonly projectId: string;
	readonly canonicalRoot: string;
	readonly gitRemoteIdentity?: string;
	readonly codebaseProjectId?: string;
	readonly createdAt: string;
	readonly reboundAt?: string;
}

export type ProjectBindingStatus = "bound" | "rebind_required" | "project_mismatch";

export interface ProjectIdentityResult {
	readonly status: ProjectBindingStatus;
	readonly binding: Readonly<ProjectBinding>;
	readonly observedRoot: string;
	readonly observedRemote?: string;
}

export interface ProjectIdentityOpenOptions {
	readonly codebaseProjectId?: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 5_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

// biome-ignore lint/complexity/noStaticOnlyClass: The plan specifies a named ProjectIdentityStore.open boundary.
export class ProjectIdentityStore {
	static open(cwd: string, options: ProjectIdentityOpenOptions = {}): ProjectIdentityResult {
		const canonicalCwd = canonicalPath(cwd);
		const observedRoot = findGitRoot(canonicalCwd) ?? canonicalCwd;
		const observedRemote = readGitRemoteIdentity(observedRoot);
		const filePath = join(observedRoot, ".omp", "compliance", "project.json");
		const existing = readBindingIfPresent(filePath);
		const binding =
			existing ?? createBindingAtomically(filePath, observedRoot, observedRemote, options.codebaseProjectId);

		return Object.freeze({
			status: compareBinding(binding, observedRoot, observedRemote, options.codebaseProjectId),
			binding,
			observedRoot,
			...(observedRemote === undefined ? {} : { observedRemote }),
		});
	}
}

function canonicalPath(path: string): string {
	return normalize(realpathSync(path)).split(sep).join("/");
}

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

function findGitRoot(cwd: string): string | undefined {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	return root ? canonicalPath(root) : undefined;
}

function readGitRemoteIdentity(root: string): string | undefined {
	const names = runGit(root, ["remote"])
		?.split("\n")
		.map((name) => name.trim())
		.filter(Boolean)
		.sort();
	if (!names?.length) return undefined;
	const remoteName = names.includes("origin") ? "origin" : names[0];
	const remoteUrl = remoteName ? runGit(root, ["remote", "get-url", remoteName]) : undefined;
	return remoteUrl ? normalizeRemoteIdentity(remoteUrl) : undefined;
}

export function normalizeRemoteIdentity(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim().replace(/[?#].*$/, "");
	let path = trimmed;

	try {
		const parsed = new URL(trimmed);
		path = parsed.pathname;
	} catch {
		const scpLike = trimmed.match(/^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/);
		if (scpLike?.[1]) path = scpLike[1];
	}

	const segments = path
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return undefined;
	return segments.slice(-2).join("/");
}

function createBindingAtomically(
	filePath: string,
	canonicalRoot: string,
	gitRemoteIdentity: string | undefined,
	codebaseProjectId: string | undefined,
): Readonly<ProjectBinding> {
	const directory = join(canonicalRoot, ".omp", "compliance");
	const lockPath = join(directory, ".project.lock");
	mkdirSync(directory, { recursive: true });
	const ownsLock = acquireLock(lockPath, filePath);
	if (!ownsLock) {
		const concurrentBinding = readBindingIfPresent(filePath);
		if (concurrentBinding) return concurrentBinding;
		throw new Error("OMP project identity lock released without a durable binding");
	}

	try {
		const concurrentBinding = readBindingIfPresent(filePath);
		if (concurrentBinding) return concurrentBinding;

		const binding = freezeBinding({
			schemaVersion: 1,
			projectId: randomUUID(),
			canonicalRoot,
			...(gitRemoteIdentity === undefined ? {} : { gitRemoteIdentity }),
			...(codebaseProjectId === undefined ? {} : { codebaseProjectId }),
			createdAt: new Date().toISOString(),
		});
		const temporaryPath = join(directory, `.project.${randomUUID()}.tmp`);

		try {
			writeFileSync(temporaryPath, `${JSON.stringify(binding, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			const fd = openSync(temporaryPath, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporaryPath, filePath);
		} finally {
			rmSync(temporaryPath, { force: true });
		}

		return binding;
	} finally {
		try {
			rmdirSync(lockPath);
		} catch {
			// The binding is already durable; lock cleanup is best-effort.
		}
	}
}

function acquireLock(lockPath: string, filePath: string): boolean {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			mkdirSync(lockPath);
			return true;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			if (existsSync(filePath)) return false;
			if (Date.now() >= deadline) throw new Error("Timed out acquiring OMP project identity lock");
			Atomics.wait(SLEEP_BUFFER, 0, 0, 10);
		}
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function readBindingIfPresent(filePath: string): Readonly<ProjectBinding> | undefined {
	try {
		return parseBinding(readFileSync(filePath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function parseBinding(content: string): Readonly<ProjectBinding> {
	try {
		const value = JSON.parse(content) as Record<string, unknown>;
		if (
			value.schemaVersion !== 1 ||
			typeof value.projectId !== "string" ||
			!UUID_V4.test(value.projectId) ||
			typeof value.canonicalRoot !== "string" ||
			value.canonicalRoot.length === 0 ||
			typeof value.createdAt !== "string" ||
			Number.isNaN(Date.parse(value.createdAt)) ||
			(value.gitRemoteIdentity !== undefined && typeof value.gitRemoteIdentity !== "string") ||
			(value.codebaseProjectId !== undefined && typeof value.codebaseProjectId !== "string") ||
			(value.reboundAt !== undefined && typeof value.reboundAt !== "string")
		) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		return freezeBinding(value as unknown as ProjectBinding);
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function freezeBinding(binding: ProjectBinding): Readonly<ProjectBinding> {
	return Object.freeze({ ...binding });
}

function compareBinding(
	binding: Readonly<ProjectBinding>,
	observedRoot: string,
	observedRemote: string | undefined,
	codebaseProjectId: string | undefined,
): ProjectBindingStatus {
	if (binding.codebaseProjectId !== codebaseProjectId || binding.gitRemoteIdentity !== observedRemote) {
		return "project_mismatch";
	}
	if (binding.canonicalRoot === observedRoot) return "bound";
	return observedRemote === undefined ? "project_mismatch" : "rebind_required";
}
