import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	constants,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

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
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const BINDING_KEYS = new Set([
	"schemaVersion",
	"projectId",
	"canonicalRoot",
	"gitRemoteIdentity",
	"codebaseProjectId",
	"createdAt",
	"reboundAt",
]);

interface LockOwner {
	readonly token: string;
	readonly pid: number;
	readonly createdAt: string;
}

// biome-ignore lint/complexity/noStaticOnlyClass: The plan specifies a named ProjectIdentityStore.open boundary.
export class ProjectIdentityStore {
	static open(cwd: string, options: ProjectIdentityOpenOptions = {}): ProjectIdentityResult {
		const codebaseProjectId = readCodebaseProjectId(options);
		const canonicalCwd = canonicalPath(cwd);
		const observedRoot = findGitRoot(canonicalCwd) ?? canonicalCwd;
		const observedRemote = readGitRemoteIdentity(observedRoot);
		const filePath = join(observedRoot, ".omp", "compliance", "project.json");
		assertStoragePathSafe(observedRoot);
		const existing = readBindingIfPresent(filePath);
		const binding = existing ?? createBindingAtomically(filePath, observedRoot, observedRemote, codebaseProjectId);

		return Object.freeze({
			status: compareBinding(binding, observedRoot, observedRemote, codebaseProjectId),
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
	if (typeof remoteUrl !== "string") return undefined;
	const trimmed = remoteUrl.trim();
	if (!trimmed || /[\0\s]/.test(trimmed) || /%(?:2f|5c)/i.test(trimmed)) return undefined;

	let host: string;
	let path: string;
	try {
		const parsed = new URL(trimmed);
		if (!(["https:", "http:", "ssh:", "git:"] as const).includes(parsed.protocol as never)) return undefined;
		if (parsed.password || (parsed.username && parsed.protocol !== "ssh:")) return undefined;
		host = parsed.hostname.toLowerCase();
		if (!host) return undefined;
		const defaultPort = parsed.protocol === "ssh:" ? "22" : undefined;
		if (parsed.port && parsed.port !== defaultPort) host = `${host}:${parsed.port}`;
		path = parsed.pathname;
	} catch {
		const scpLike = trimmed.match(/^(?:[A-Za-z0-9._-]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([^?#]+)$/);
		if (!scpLike?.[1] || !scpLike[2]) return undefined;
		host = scpLike[1].toLowerCase();
		path = scpLike[2];
	}

	try {
		const segments = path
			.replace(/^\/+|\/+$/g, "")
			.split("/")
			.map((segment) => decodeURIComponent(segment));
		if (
			segments.length < 2 ||
			segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0/\\]/.test(segment))
		) {
			return undefined;
		}
		segments[segments.length - 1] = segments.at(-1)?.replace(/\.git$/i, "") ?? "";
		if (!segments.at(-1)) return undefined;
		return `${host}/${segments.join("/")}`;
	} catch {
		return undefined;
	}
}

function createBindingAtomically(
	filePath: string,
	canonicalRoot: string,
	gitRemoteIdentity: string | undefined,
	codebaseProjectId: string | undefined,
): Readonly<ProjectBinding> {
	const directory = join(canonicalRoot, ".omp", "compliance");
	const lockPath = join(directory, ".project.lock");
	prepareStorageDirectory(canonicalRoot);
	assertStoragePathSafe(canonicalRoot);
	const lockOwner = acquireLock(lockPath, filePath, canonicalRoot);
	if (!lockOwner) {
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
			const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			assertStoragePathSafe(canonicalRoot);
			renameSync(temporaryPath, filePath);
			fsyncDirectory(directory);
		} finally {
			rmSync(temporaryPath, { force: true });
		}

		return binding;
	} finally {
		removeLockIfOwned(lockPath, lockOwner.token);
	}
}

function acquireLock(lockPath: string, filePath: string, canonicalRoot: string): LockOwner | undefined {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		assertStoragePathSafe(canonicalRoot);
		const owner = Object.freeze({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
		try {
			const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return owner;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			if (existsSync(filePath)) return undefined;
			const existingOwner = readLockOwner(lockPath);
			if (existingOwner && !isProcessAlive(existingOwner.pid)) {
				removeLockIfOwned(lockPath, existingOwner.token);
				continue;
			}
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
		assertRegularFileOrMissing(filePath);
		return parseBinding(readFileNoFollow(filePath));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function readFileNoFollow(filePath: string): string {
	const fd = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
	try {
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

function parseBinding(content: string): Readonly<ProjectBinding> {
	try {
		const value = JSON.parse(content) as unknown;
		if (
			!isRecord(value) ||
			Object.keys(value).some((key) => !BINDING_KEYS.has(key)) ||
			value.schemaVersion !== 1 ||
			typeof value.projectId !== "string" ||
			!UUID_V4.test(value.projectId) ||
			!isCanonicalRoot(value.canonicalRoot) ||
			!isIsoTimestamp(value.createdAt) ||
			(value.gitRemoteIdentity !== undefined && !isCanonicalRemoteIdentity(value.gitRemoteIdentity)) ||
			(value.codebaseProjectId !== undefined && !isNonEmptyString(value.codebaseProjectId)) ||
			(value.reboundAt !== undefined && !isIsoTimestamp(value.reboundAt))
		) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		return freezeBinding({
			schemaVersion: 1,
			projectId: value.projectId,
			canonicalRoot: value.canonicalRoot,
			...(value.gitRemoteIdentity === undefined ? {} : { gitRemoteIdentity: value.gitRemoteIdentity }),
			...(value.codebaseProjectId === undefined ? {} : { codebaseProjectId: value.codebaseProjectId }),
			createdAt: value.createdAt,
			...(value.reboundAt === undefined ? {} : { reboundAt: value.reboundAt }),
		});
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function freezeBinding(binding: ProjectBinding): Readonly<ProjectBinding> {
	return Object.freeze({
		schemaVersion: 1,
		projectId: binding.projectId,
		canonicalRoot: binding.canonicalRoot,
		...(binding.gitRemoteIdentity === undefined ? {} : { gitRemoteIdentity: binding.gitRemoteIdentity }),
		...(binding.codebaseProjectId === undefined ? {} : { codebaseProjectId: binding.codebaseProjectId }),
		createdAt: binding.createdAt,
		...(binding.reboundAt === undefined ? {} : { reboundAt: binding.reboundAt }),
	});
}

function prepareStorageDirectory(canonicalRoot: string): void {
	const ompDirectory = join(canonicalRoot, ".omp");
	const complianceDirectory = join(ompDirectory, "compliance");
	createDirectoryIfMissing(ompDirectory);
	assertDirectoryNotLink(ompDirectory);
	createDirectoryIfMissing(complianceDirectory);
	assertDirectoryNotLink(complianceDirectory);
}

function createDirectoryIfMissing(path: string): void {
	try {
		mkdirSync(path);
	} catch (error) {
		if (!isAlreadyExists(error)) throw error;
	}
}

function assertStoragePathSafe(canonicalRoot: string): void {
	const ompDirectory = join(canonicalRoot, ".omp");
	const complianceDirectory = join(ompDirectory, "compliance");
	assertDirectoryNotLink(ompDirectory, true);
	assertDirectoryNotLink(complianceDirectory, true);
	assertRegularFileOrMissing(join(complianceDirectory, "project.json"));
	assertRegularFileOrMissing(join(complianceDirectory, ".project.lock"));
}

function assertDirectoryNotLink(path: string, allowMissing = false): void {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	} catch (error) {
		if (allowMissing && isNotFound(error)) return;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function assertRegularFileOrMissing(path: string): void {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	} catch (error) {
		if (isNotFound(error)) return;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function readLockOwner(lockPath: string): LockOwner | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(lockPath, constants.O_RDONLY | NO_FOLLOW);
		const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
		if (
			!isRecord(value) ||
			Object.keys(value).length !== 3 ||
			!UUID_V4.test(typeof value.token === "string" ? value.token : "") ||
			!Number.isSafeInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			!isIsoTimestamp(value.createdAt)
		) {
			return undefined;
		}
		return Object.freeze({ token: value.token as string, pid: value.pid as number, createdAt: value.createdAt });
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function removeLockIfOwned(lockPath: string, token: string): void {
	try {
		if (readLockOwner(lockPath)?.token === token) unlinkSync(lockPath);
	} catch {
		// Lock cleanup is best-effort and must never remove another owner's lock.
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = openSync(directory, constants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (process.platform !== "win32" || !hasErrorCode(error, ["EACCES", "EINVAL", "EISDIR", "EPERM"])) throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function readCodebaseProjectId(options: ProjectIdentityOpenOptions): string | undefined {
	try {
		const value = options.codebaseProjectId;
		if (value === undefined || isNonEmptyString(value)) return value;
	} catch {
		// Options are a runtime trust boundary even when TypeScript types look narrow.
	}
	throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCanonicalRoot(value: unknown): value is string {
	return isNonEmptyString(value) && isAbsolute(value) && normalize(value).split(sep).join("/") === value;
}

function isCanonicalRemoteIdentity(value: unknown): value is string {
	return isNonEmptyString(value) && normalizeRemoteIdentity(`ssh://${value}`) === value;
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
	return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
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
