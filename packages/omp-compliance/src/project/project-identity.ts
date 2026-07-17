import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

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
const LOCK_RECOVERY_GRACE_MS = 1_000;
const LOCK_TIMESTAMP_TOLERANCE_MS = 5_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const PROJECT_IDENTITY_RESULTS = new WeakSet<object>();
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

interface LockSnapshot {
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly owner?: LockOwner;
}

interface FileNodeIdentity {
	readonly dev: number;
	readonly ino: number;
}

interface FileIdentity extends FileNodeIdentity {
	readonly mtimeMs: number;
	readonly size: number;
}

interface DirectoryIdentity {
	readonly path: string;
	readonly realpath: string;
	readonly dev: number;
	readonly ino: number;
}

interface StorageIdentity {
	readonly omp: DirectoryIdentity;
	readonly compliance: DirectoryIdentity;
}

// biome-ignore lint/complexity/noStaticOnlyClass: The plan specifies a named ProjectIdentityStore.open boundary.
export class ProjectIdentityStore {
	static open(cwd: string, options: ProjectIdentityOpenOptions = {}): ProjectIdentityResult {
		const codebaseProjectId = readCodebaseProjectId(options);
		const canonicalCwd = canonicalPath(cwd);
		const gitRoot = findGitRoot(canonicalCwd);
		const observedRoot = gitRoot ?? canonicalCwd;
		const observedRemote = gitRoot === undefined ? undefined : readGitRemoteIdentity(gitRoot);
		const filePath = join(observedRoot, ".omp", "compliance", "project.json");
		assertStoragePathSafe(observedRoot);
		const existing = readBindingIfPresent(filePath);
		const binding = existing ?? createBindingAtomically(filePath, observedRoot, observedRemote, codebaseProjectId);

		const result = Object.freeze({
			status: compareBinding(binding, observedRoot, observedRemote, codebaseProjectId),
			binding,
			observedRoot,
			...(observedRemote === undefined ? {} : { observedRemote }),
		});
		PROJECT_IDENTITY_RESULTS.add(result);
		return result;
	}
}

export function isBoundProjectIdentityResult(value: unknown): value is ProjectIdentityResult {
	return isRecord(value) && PROJECT_IDENTITY_RESULTS.has(value) && value.status === "bound";
}

function canonicalPath(path: string): string {
	return normalize(realpathSync(path)).split(sep).join("/");
}

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env: process.env,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

function findGitRoot(cwd: string): string | undefined {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (root) return canonicalPath(root);
	if (hasGitMarker(cwd)) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	return undefined;
}

function hasGitMarker(cwd: string): boolean {
	let current = cwd;
	while (true) {
		try {
			lstatSync(join(current, ".git"));
			return true;
		} catch (error) {
			if (!isNotFound(error)) throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function readGitRemoteIdentity(root: string): string | undefined {
	const remoteNames = runGit(root, ["remote"]);
	if (remoteNames === undefined) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	const names = remoteNames
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean)
		.sort();
	if (!names.length) return undefined;
	const remoteName = names.includes("origin") ? "origin" : names[0];
	const remoteUrl = remoteName ? runGit(root, ["remote", "get-url", remoteName]) : undefined;
	const identity = remoteUrl ? normalizeRemoteIdentity(remoteUrl) : undefined;
	if (!identity) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	return identity;
}

export function normalizeRemoteIdentity(remoteUrl: string): string | undefined {
	if (typeof remoteUrl !== "string") return undefined;
	const trimmed = remoteUrl.trim();
	if (!trimmed || /[\0\s]/.test(trimmed) || /%(?:25|2f|5c)/i.test(trimmed)) return undefined;

	let host: string;
	let path: string;
	let sshUsername: string | undefined;
	const canonical = trimmed.match(
		/^(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\](?::\d+)?|[A-Za-z0-9.-]+(?::\d+)?)\/(.+)$/,
	);
	if (canonical?.[2] && canonical[3]) {
		sshUsername = canonical[1];
		host = canonical[2].toLowerCase();
		path = canonical[3];
	} else if (!trimmed.includes("://")) {
		const scpLike = trimmed.match(/^(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([^?#]+)$/);
		if (!scpLike?.[2] || !scpLike[3] || scpLike[3].includes("@")) return undefined;
		sshUsername = scpLike[1];
		host = scpLike[2].toLowerCase();
		path = scpLike[3];
	} else {
		try {
			const parsed = new URL(trimmed);
			if (!(["https:", "http:", "ssh:", "git:"] as const).includes(parsed.protocol as never)) return undefined;
			if (parsed.password || (parsed.username && parsed.protocol !== "ssh:") || parsed.search || parsed.hash)
				return undefined;
			if (parsed.username && !/^[A-Za-z0-9._-]+$/.test(parsed.username)) return undefined;
			sshUsername = parsed.username || undefined;
			host = parsed.hostname.toLowerCase();
			if (!host) return undefined;
			const defaultPort = parsed.protocol === "ssh:" ? "22" : undefined;
			if (parsed.port && parsed.port !== defaultPort) host = `${host}:${parsed.port}`;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	}

	try {
		const segments = path
			.replace(/^\/+|\/+$/g, "")
			.split("/")
			.map((segment) => decodeURIComponent(segment));
		if (
			segments.length < 2 ||
			segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0/\\\s?#]/.test(segment))
		) {
			return undefined;
		}
		segments[segments.length - 1] = segments.at(-1)?.replace(/\.git$/i, "") ?? "";
		if (!segments.at(-1)) return undefined;
		const userPrefix = sshUsername && sshUsername !== "git" ? `${sshUsername}@` : "";
		return `${userPrefix}${host}/${segments.join("/")}`;
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
	const storageIdentity = captureStorageIdentity(canonicalRoot);
	assertStoragePathSafe(canonicalRoot);
	const lockOwner = acquireLock(lockPath, filePath, canonicalRoot, storageIdentity);
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
		let publishedBinding = binding;
		let temporaryNode: FileNodeIdentity | undefined;

		try {
			assertStorageIdentity(storageIdentity);
			const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
			try {
				const opened = fstatSync(fd);
				temporaryNode = Object.freeze({ dev: opened.dev, ino: opened.ino });
				assertStorageIdentity(storageIdentity);
				writeFileSync(fd, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
				fsyncSync(fd);
				assertStorageIdentity(storageIdentity);
			} finally {
				closeSync(fd);
			}
			const temporaryIdentity = captureRegularFileIdentity(temporaryPath, temporaryNode);
			assertStorageIdentity(storageIdentity);
			assertStoragePathSafe(canonicalRoot);
			assertRegularFileIdentity(temporaryPath, temporaryIdentity);
			let linked = false;
			try {
				linkSync(temporaryPath, filePath);
				linked = true;
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				const competingBinding = readBindingIfPresent(filePath);
				if (!competingBinding) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
				publishedBinding = competingBinding;
			}
			if (linked) assertRegularFileIdentity(filePath, temporaryIdentity);
			assertStorageIdentity(storageIdentity);
			fsyncDirectory(directory, storageIdentity.compliance);
			assertStorageIdentity(storageIdentity);
		} finally {
			if (temporaryNode) removeFileNodeIfUnchanged(temporaryPath, temporaryNode);
		}

		return publishedBinding;
	} finally {
		removeLockIfOwned(lockPath, lockOwner.token);
	}
}

function acquireLock(
	lockPath: string,
	filePath: string,
	canonicalRoot: string,
	storageIdentity: StorageIdentity,
): LockOwner | undefined {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		assertStorageIdentity(storageIdentity);
		assertStoragePathSafe(canonicalRoot);
		const owner = Object.freeze({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
		let createdLock = false;
		try {
			const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
			createdLock = true;
			try {
				writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			assertStorageIdentity(storageIdentity);
			return owner;
		} catch (error) {
			if (createdLock) {
				removeLockIfOwned(lockPath, owner.token);
				throw error;
			}
			if (!isAlreadyExists(error)) throw error;
			if (existsSync(filePath)) return undefined;
			const snapshot = readLockSnapshot(lockPath);
			if (snapshot) {
				const ageMs = Date.now() - snapshot.mtimeMs;
				if (snapshot.owner && !isProcessAlive(snapshot.owner.pid)) {
					if (removeLockIfUnchanged(lockPath, snapshot)) continue;
				} else if (
					ageMs >= LOCK_RECOVERY_GRACE_MS &&
					(!snapshot.owner || !isLockOwnerCurrent(snapshot.owner, snapshot)) &&
					removeLockIfUnchanged(lockPath, snapshot)
				) {
					continue;
				}
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
		return validateProjectBinding(JSON.parse(content) as unknown);
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

function captureStorageIdentity(canonicalRoot: string): StorageIdentity {
	return Object.freeze({
		omp: captureDirectoryIdentity(join(canonicalRoot, ".omp")),
		compliance: captureDirectoryIdentity(join(canonicalRoot, ".omp", "compliance")),
	});
}

function captureDirectoryIdentity(path: string): DirectoryIdentity {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		return Object.freeze({ path, realpath: canonicalPath(path), dev: stats.dev, ino: stats.ino });
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function assertStorageIdentity(identity: StorageIdentity): void {
	assertDirectoryIdentity(identity.omp);
	assertDirectoryIdentity(identity.compliance);
}

function assertDirectoryIdentity(identity: DirectoryIdentity): void {
	try {
		const stats = lstatSync(identity.path);
		if (
			stats.isSymbolicLink() ||
			!stats.isDirectory() ||
			stats.dev !== identity.dev ||
			stats.ino !== identity.ino ||
			canonicalPath(identity.path) !== identity.realpath
		) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
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

function captureRegularFileIdentity(path: string, expectedNode: FileNodeIdentity): FileIdentity {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile() || stats.dev !== expectedNode.dev || stats.ino !== expectedNode.ino) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		return Object.freeze({ dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size });
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function assertRegularFileIdentity(path: string, identity: FileIdentity): void {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile() || !sameFileIdentity(identity, stats)) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function removeFileNodeIfUnchanged(path: string, identity: FileNodeIdentity): void {
	try {
		const stats = lstatSync(path);
		if (!stats.isSymbolicLink() && stats.isFile() && stats.dev === identity.dev && stats.ino === identity.ino) {
			unlinkSync(path);
		}
	} catch {
		// Best-effort cleanup must not remove a replacement path.
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

function readLockSnapshot(lockPath: string): LockSnapshot | undefined {
	try {
		const before = lstatSync(lockPath);
		if (before.isSymbolicLink() || !before.isFile()) return undefined;
		const owner = readLockOwner(lockPath);
		const after = lstatSync(lockPath);
		if (!sameFileIdentity(before, after)) return undefined;
		return Object.freeze({
			dev: after.dev,
			ino: after.ino,
			mtimeMs: after.mtimeMs,
			size: after.size,
			...(owner === undefined ? {} : { owner }),
		});
	} catch {
		return undefined;
	}
}

function removeLockIfUnchanged(lockPath: string, snapshot: LockSnapshot): boolean {
	try {
		const current = lstatSync(lockPath);
		if (!sameFileIdentity(snapshot, current)) return false;
		unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}

function sameFileIdentity(
	left: Pick<LockSnapshot, "dev" | "ino" | "mtimeMs" | "size">,
	right: Pick<LockSnapshot, "dev" | "ino" | "mtimeMs" | "size">,
): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function isLockOwnerCurrent(owner: LockOwner, snapshot: LockSnapshot): boolean {
	const createdAt = Date.parse(owner.createdAt);
	if (Math.abs(createdAt - snapshot.mtimeMs) > LOCK_TIMESTAMP_TOLERANCE_MS) return false;
	const processStartedAt = readProcessStartedAt(owner.pid);
	return processStartedAt === undefined || processStartedAt <= createdAt + LOCK_TIMESTAMP_TOLERANCE_MS;
}

function readProcessStartedAt(pid: number): number | undefined {
	if (pid === process.pid) return Date.now() - process.uptime() * 1_000;
	if (process.platform === "win32") return undefined;
	try {
		const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const timestamp = Date.parse(output);
		return Number.isNaN(timestamp) ? undefined : timestamp;
	} catch {
		return undefined;
	}
}

function removeLockIfOwned(lockPath: string, token: string): void {
	try {
		const snapshot = readLockSnapshot(lockPath);
		if (snapshot?.owner?.token === token) removeLockIfUnchanged(lockPath, snapshot);
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

function fsyncDirectory(directory: string, identity: DirectoryIdentity): void {
	assertDirectoryIdentity(identity);
	try {
		const fd = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
		try {
			const before = fstatSync(fd);
			if (before.dev !== identity.dev || before.ino !== identity.ino) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
			fsyncSync(fd);
			const after = fstatSync(fd);
			if (after.dev !== identity.dev || after.ino !== identity.ino) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (process.platform !== "win32" || !hasErrorCode(error, ["EACCES", "EINVAL", "EISDIR", "EPERM"])) throw error;
	}
	assertDirectoryIdentity(identity);
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
	return isNonEmptyString(value) && normalizeRemoteIdentity(value) === value;
}

export function validateProjectBinding(value: unknown): Readonly<ProjectBinding> {
	try {
		if (!isRecord(value)) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const snapshot: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			const descriptor = descriptors[key as keyof typeof descriptors];
			if (typeof key !== "string" || !BINDING_KEYS.has(key) || !descriptor?.enumerable || !("value" in descriptor)) {
				throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
			}
			snapshot[key] = descriptor.value;
		}

		if (
			snapshot.schemaVersion !== 1 ||
			typeof snapshot.projectId !== "string" ||
			!UUID_V4.test(snapshot.projectId) ||
			!isCanonicalRoot(snapshot.canonicalRoot) ||
			!isIsoTimestamp(snapshot.createdAt) ||
			(snapshot.gitRemoteIdentity !== undefined && !isCanonicalRemoteIdentity(snapshot.gitRemoteIdentity)) ||
			(snapshot.codebaseProjectId !== undefined && !isNonEmptyString(snapshot.codebaseProjectId)) ||
			(snapshot.reboundAt !== undefined && !isIsoTimestamp(snapshot.reboundAt))
		) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}

		return freezeBinding({
			schemaVersion: 1,
			projectId: snapshot.projectId,
			canonicalRoot: snapshot.canonicalRoot,
			...(snapshot.gitRemoteIdentity === undefined ? {} : { gitRemoteIdentity: snapshot.gitRemoteIdentity }),
			...(snapshot.codebaseProjectId === undefined ? {} : { codebaseProjectId: snapshot.codebaseProjectId }),
			createdAt: snapshot.createdAt,
			...(snapshot.reboundAt === undefined ? {} : { reboundAt: snapshot.reboundAt }),
		});
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
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
