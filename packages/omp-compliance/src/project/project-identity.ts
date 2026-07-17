import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	constants,
	accessSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, sep } from "node:path";

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
const PUBLISH_WAIT_MS = 5_000;
const PUBLISH_RECOVERY_GRACE_MS = 1_000;
const PUBLISH_OWNER_LEASE_MS = 30_000;
const PUBLISH_TIMESTAMP_TOLERANCE_MS = 5_000;
const MAX_PROBEABLE_PID = 2_147_483_647;
const REMOTE_IDENTITY_PREFIX = "git-remote:v1://";
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
const REDIRECTING_GIT_ENVIRONMENT_KEYS = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
]);

interface PublishOwner {
	readonly token: string;
	readonly pid: number;
	readonly createdAt: string;
}

interface PublishMarkerSnapshot extends FileIdentity {
	readonly owner?: PublishOwner;
}

interface FileNodeIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface FileIdentity extends FileNodeIdentity {
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly size: bigint;
}

interface DirectoryIdentity {
	readonly path: string;
	readonly realpath: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

interface StorageIdentity {
	readonly omp: DirectoryIdentity;
	readonly compliance: DirectoryIdentity;
}

interface GitCommandResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

type ProcessState = "alive" | "dead" | "unknown";
type PublishOwnerState = "current" | "stale" | "unknown";

// biome-ignore lint/complexity/noStaticOnlyClass: The plan specifies a named ProjectIdentityStore.open boundary.
export class ProjectIdentityStore {
	static open(cwd: string, options: ProjectIdentityOpenOptions = {}): ProjectIdentityResult {
		try {
			const codebaseProjectId = readCodebaseProjectId(options);
			const canonicalCwd = canonicalPath(cwd);
			const gitRoot = findGitRoot(canonicalCwd);
			const observedRoot = gitRoot ?? canonicalCwd;
			const observedRemote = gitRoot === undefined ? undefined : readGitRemoteIdentity(gitRoot);
			const filePath = join(observedRoot, ".omp", "compliance", "project.json");
			assertStoragePathSafe(observedRoot);
			const existing = readPublishedBindingIfPresent(filePath);
			const binding = existing ?? createBindingAtomically(filePath, observedRoot, observedRemote, codebaseProjectId);

			const result = Object.freeze({
				status: compareBinding(binding, observedRoot, observedRemote, codebaseProjectId),
				binding,
				observedRoot,
				...(observedRemote === undefined ? {} : { observedRemote }),
			});
			PROJECT_IDENTITY_RESULTS.add(result);
			return result;
		} catch (error) {
			if (isProjectIdentityError(error)) throw error;
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
		}
	}
}

function readPublishedBindingIfPresent(filePath: string): Readonly<ProjectBinding> | undefined {
	const directory = dirname(filePath);
	if (!pathExists(directory)) return undefined;
	const storageIdentity = captureStorageIdentityForFile(filePath);
	waitForActivePublishers(directory, storageIdentity);
	return readProjectBindingIfPresent(filePath);
}

function isProjectIdentityError(error: unknown): error is Error {
	return error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR;
}

export function isBoundProjectIdentityResult(value: unknown): value is ProjectIdentityResult {
	return isRecord(value) && PROJECT_IDENTITY_RESULTS.has(value) && value.status === "bound";
}

function canonicalPath(path: string): string {
	return normalize(realpathSync(path)).split(sep).join("/");
}

function resolveGitExecutable(): string {
	const path = process.env.PATH;
	if (!path) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(delimiter) : [""];
	for (const directory of path.split(delimiter)) {
		const base = directory.replace(/^"|"$/g, "") || process.cwd();
		for (const extension of extensions) {
			const candidate = join(base, `git${extension.toLowerCase()}`);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Keep searching PATH for an executable Git candidate.
			}
		}
	}
	throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
}

function executeGit(cwd: string, args: string[]): GitCommandResult {
	const executable = resolveGitExecutable();
	const env = createGitEnvironment();
	const probe = spawnSync(executable, ["--version"], { encoding: "utf8", env });
	if (probe.error || probe.status !== 0 || !probe.stdout.startsWith("git version ")) {
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: probe.error });
	}
	const result = spawnSync(executable, ["-C", cwd, ...args], { encoding: "utf8", env });
	if (result.error || result.status === null) {
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: result.error });
	}
	return Object.freeze({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
}

function createGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LANG: "C", LC_ALL: "C" };
	for (const key of Object.keys(env)) {
		if (REDIRECTING_GIT_ENVIRONMENT_KEYS.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
			delete env[key];
		}
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
	return env;
}

function runGit(cwd: string, args: string[]): string | undefined {
	const result = executeGit(cwd, args);
	return result.status === 0 ? result.stdout : undefined;
}

function findGitRoot(cwd: string): string | undefined {
	const result = executeGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status === 0 && result.stdout) return canonicalPath(result.stdout);
	if (hasGitMarker(cwd)) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	if (/^fatal: not a git repository \(or any of the parent directories\): \.git$/.test(result.stderr)) return undefined;
	throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
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
	const configuredRemotes = executeGit(root, [
		"config",
		"--local",
		"--name-only",
		"--get-regexp",
		"^remote\\..*\\.url$",
	]);
	if (configuredRemotes.status === 1 && !configuredRemotes.stdout && !configuredRemotes.stderr) return undefined;
	if (configuredRemotes.status !== 0) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	const names = configuredRemotes.stdout
		.split("\n")
		.map((key) => key.match(/^remote\.(.+)\.url$/)?.[1])
		.filter((name): name is string => Boolean(name))
		.filter((name, index, all) => all.indexOf(name) === index)
		.sort();
	if (!names.length) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	const remoteName = names.includes("origin") ? "origin" : names[0];
	const remoteUrl = remoteName ? runGit(root, ["config", "--local", "--get", `remote.${remoteName}.url`]) : undefined;
	const identity = remoteUrl ? normalizeObservedRemoteIdentity(remoteUrl) : undefined;
	if (!identity) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	return identity;
}

export function normalizeRemoteIdentity(remoteUrl: string): string | undefined {
	if (typeof remoteUrl !== "string") return undefined;
	const trimmed = remoteUrl.trim();
	if (!trimmed || /[\0\s]/.test(trimmed) || /%(?:25|2f|5c)/i.test(trimmed)) return undefined;
	if (trimmed.startsWith(REMOTE_IDENTITY_PREFIX)) return parseCanonicalRemoteIdentity(trimmed);
	return normalizeObservedRemoteIdentity(trimmed);
}

function normalizeObservedRemoteIdentity(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim();
	if (
		!trimmed ||
		/[\0\s]/.test(trimmed) ||
		/%(?:25|2f|5c)/i.test(trimmed) ||
		trimmed.startsWith(REMOTE_IDENTITY_PREFIX) ||
		isAbsolute(trimmed) ||
		/^[A-Za-z]:[\\/]/.test(trimmed) ||
		trimmed.startsWith("\\\\")
	)
		return undefined;
	let host: string;
	let path: string;
	let sshUsername: string | undefined;
	if (!trimmed.includes("://")) {
		const scpLike = trimmed.match(/^(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([^?#]+)$/);
		if (!scpLike?.[2] || !scpLike[3] || scpLike[3].includes("@")) return undefined;
		sshUsername = scpLike[1];
		const scpHost = normalizeRemoteHost(scpLike[2]);
		if (!scpHost) return undefined;
		host = scpHost;
		path = scpLike[3];
	} else {
		try {
			const parsed = new URL(trimmed);
			if (!(["https:", "http:", "ssh:", "git:"] as const).includes(parsed.protocol as never)) return undefined;
			if (parsed.password || (parsed.username && parsed.protocol !== "ssh:") || parsed.search || parsed.hash)
				return undefined;
			if (parsed.username && !/^[A-Za-z0-9._-]+$/.test(parsed.username)) return undefined;
			sshUsername = parsed.username || undefined;
			host = normalizeRemoteHost(parsed.hostname) ?? "";
			if (!host) return undefined;
			const defaultPort = parsed.protocol === "ssh:" ? "22" : parsed.protocol === "git:" ? "9418" : undefined;
			if (parsed.port && parsed.port !== defaultPort) host = `${host}!${parsed.port}`;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	}

	return formatCanonicalRemoteIdentity(sshUsername, host, path);
}

function parseCanonicalRemoteIdentity(value: string): string | undefined {
	const canonical = value.match(
		/^git-remote:v1:\/\/(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?:!(\d+))?\/(.+)$/,
	);
	if (!canonical?.[2] || !canonical[4] || (canonical[3] && !isValidPort(canonical[3]))) return undefined;
	const host = normalizeRemoteHost(canonical[2]);
	if (!host) return undefined;
	const normalized = formatCanonicalRemoteIdentity(
		canonical[1],
		`${host}${canonical[3] ? `!${canonical[3]}` : ""}`,
		canonical[4],
	);
	return normalized === value ? normalized : undefined;
}

function formatCanonicalRemoteIdentity(
	sshUsername: string | undefined,
	host: string,
	path: string,
): string | undefined {
	try {
		const segments = path
			.replace(/^\/+|\/+$/g, "")
			.split("/")
			.map((segment) => decodeURIComponent(segment));
		if (
			segments.length < 2 ||
			segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0/\\\s?#]/.test(segment))
		)
			return undefined;
		segments[segments.length - 1] = segments.at(-1)?.replace(/\.git$/i, "") ?? "";
		if (!segments.at(-1)) return undefined;
		const userPrefix = sshUsername && sshUsername !== "git" ? `${sshUsername}@` : "";
		return `${REMOTE_IDENTITY_PREFIX}${userPrefix}${host}/${segments.join("/")}`;
	} catch {
		return undefined;
	}
}

function isValidPort(value: string): boolean {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 && String(port) === value;
}

function normalizeRemoteHost(value: string): string | undefined {
	if (value.startsWith("[")) {
		try {
			const hostname = new URL(`http://${value}/`).hostname.toLowerCase();
			return hostname.startsWith("[") && hostname.endsWith("]") ? hostname : undefined;
		} catch {
			return undefined;
		}
	}
	const withoutTerminationPoint = value.endsWith(".") ? value.slice(0, -1) : value;
	if (!withoutTerminationPoint) return undefined;
	try {
		const normalized = new URL(`http://${withoutTerminationPoint}/`).hostname.toLowerCase();
		if (/^[0-9.]+$/.test(normalized)) {
			const octets = normalized.split(".");
			return octets.length === 4 && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
				? normalized
				: undefined;
		}
		if (!normalized || normalized.length > 253) return undefined;
		const labels = normalized.split(".");
		if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
			return undefined;
		return normalized;
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
	prepareStorageDirectory(canonicalRoot);
	const storageIdentity = captureStorageIdentity(canonicalRoot);
	assertStoragePathSafe(canonicalRoot);
	const publication = createPublishMarker(directory, storageIdentity);
	const temporaryPath = join(directory, `.project.${publication.owner.token}.tmp`);
	const readyPath = join(directory, `.project.${publication.owner.token}.ready`);
	let temporaryNode: FileNodeIdentity | undefined;
	let published = false;
	const binding = freezeBinding({
		schemaVersion: 1,
		projectId: randomUUID(),
		canonicalRoot,
		...(gitRemoteIdentity === undefined ? {} : { gitRemoteIdentity }),
		...(codebaseProjectId === undefined ? {} : { codebaseProjectId }),
		createdAt: new Date().toISOString(),
	});
	try {
		assertStorageIdentity(storageIdentity);
		const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
		try {
			const opened = fstatSync(fd, { bigint: true });
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
		renameSync(temporaryPath, readyPath);
		captureRegularFileIdentity(readyPath, temporaryNode);
		fsyncDirectory(directory, storageIdentity.compliance);
		try {
			linkSync(readyPath, filePath);
			published = true;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
		if (published) {
			const publishedIdentity = captureRegularFileIdentity(filePath, temporaryNode);
			assertRegularFileIdentity(readyPath, publishedIdentity);
		}
		assertStorageIdentity(storageIdentity);
		fsyncDirectory(directory, storageIdentity.compliance);
		assertStorageIdentity(storageIdentity);
	} finally {
		if (temporaryNode) {
			removeFileNodeIfUnchanged(temporaryPath, temporaryNode);
			removeFileNodeIfUnchanged(readyPath, temporaryNode);
		}
		assertStorageIdentity(storageIdentity);
		fsyncDirectory(directory, storageIdentity.compliance);
		removeFileNodeIfUnchanged(publication.markerPath, publication.markerNode);
		fsyncDirectory(directory, storageIdentity.compliance);
	}

	if (published) return binding;
	waitForActivePublishers(directory, storageIdentity);
	const competingBinding = readProjectBindingIfPresent(filePath);
	if (competingBinding) return competingBinding;
	throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
}

interface PublishAttempt {
	readonly owner: PublishOwner;
	readonly markerPath: string;
	readonly markerNode: FileNodeIdentity;
}

function createPublishMarker(directory: string, storageIdentity: StorageIdentity): PublishAttempt {
	while (true) {
		const owner = Object.freeze({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
		const markerPath = join(directory, `.project.publish.${owner.token}.json`);
		let markerNode: FileNodeIdentity | undefined;
		try {
			const fd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
			try {
				const opened = fstatSync(fd, { bigint: true });
				markerNode = Object.freeze({ dev: opened.dev, ino: opened.ino });
				writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			assertStorageIdentity(storageIdentity);
			captureRegularFileIdentity(markerPath, markerNode);
			fsyncDirectory(directory, storageIdentity.compliance);
			return Object.freeze({ owner, markerPath, markerNode });
		} catch (error) {
			if (isAlreadyExists(error)) continue;
			if (markerNode) cleanupOwnedPublishMarker(markerPath, markerNode, directory, storageIdentity);
			throw error;
		}
	}
}

function cleanupOwnedPublishMarker(
	markerPath: string,
	markerNode: FileNodeIdentity,
	directory: string,
	storageIdentity: StorageIdentity,
): void {
	try {
		removeFileNodeIfUnchanged(markerPath, markerNode);
		fsyncDirectory(directory, storageIdentity.compliance);
	} catch {
		// Cleanup is best-effort and the inode check prevents removing a replacement marker.
	}
}

function waitForActivePublishers(directory: string, storageIdentity: StorageIdentity): void {
	const deadline = Date.now() + PUBLISH_WAIT_MS;
	while (true) {
		assertStorageIdentity(storageIdentity);
		const markerPaths = listPublishMarkerPaths(directory);
		let active = false;
		for (const markerPath of markerPaths) {
			const snapshot = readPublishMarkerSnapshot(markerPath);
			if (!snapshot) continue;
			if (isPublishMarkerActive(snapshot)) {
				active = true;
				continue;
			}
			reclaimExpiredPublication(markerPath, snapshot, directory, storageIdentity);
		}
		if (!active && listPublishMarkerPaths(directory).length === 0) return;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for OMP project identity publishers");
		Atomics.wait(SLEEP_BUFFER, 0, 0, 10);
	}
}

function reclaimExpiredPublication(
	marker: PublishMarkerPath,
	snapshot: PublishMarkerSnapshot,
	directory: string,
	storageIdentity: StorageIdentity,
): void {
	const preparedPaths = [
		join(directory, `.project.${marker.token}.tmp`),
		join(directory, `.project.${marker.token}.ready`),
	];
	assertStorageIdentity(storageIdentity);
	if (!matchesRegularFileIdentity(marker.path, snapshot)) return;

	for (const preparedPath of preparedPaths) {
		const preparedIdentity = captureOptionalRegularFileIdentity(preparedPath);
		assertStorageIdentity(storageIdentity);
		if (!matchesRegularFileIdentity(marker.path, snapshot)) return;
		if (!preparedIdentity) {
			if (pathExists(preparedPath)) return;
			continue;
		}
		if (!removeFileIfIdentityMatches(preparedPath, preparedIdentity)) return;
		fsyncDirectory(directory, storageIdentity.compliance);
		assertStorageIdentity(storageIdentity);
	}

	if (preparedPaths.some((preparedPath) => pathExists(preparedPath))) {
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	}
	assertStorageIdentity(storageIdentity);
	if (!removeFileIfIdentityMatches(marker.path, snapshot)) return;
	fsyncDirectory(directory, storageIdentity.compliance);
	assertStorageIdentity(storageIdentity);
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

type ProjectFileOpener = (path: string, flags: number) => number;

export function readProjectBindingIfPresent(
	filePath: string,
	openFile: ProjectFileOpener = openSync,
): Readonly<ProjectBinding> | undefined {
	let fileIdentity: FileIdentity;
	try {
		fileIdentity = captureExistingRegularFileIdentity(filePath);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}

	try {
		const storageIdentity = captureStorageIdentityForFile(filePath);
		assertStorageIdentity(storageIdentity);
		const content = readFileNoFollow(filePath, fileIdentity, openFile);
		assertStorageIdentity(storageIdentity);
		return parseBinding(content);
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function readFileNoFollow(filePath: string, expectedIdentity: FileIdentity, openFile: ProjectFileOpener): string {
	const fd = openFile(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | NO_FOLLOW);
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || !sameFileIdentity(expectedIdentity, opened)) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		const content = readFileSync(fd, "utf8");
		const afterRead = fstatSync(fd, { bigint: true });
		if (!afterRead.isFile() || !sameFileIdentity(expectedIdentity, afterRead)) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		assertRegularFileIdentity(filePath, expectedIdentity);
		return content;
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
	return captureStorageIdentityFromDirectories(join(canonicalRoot, ".omp"), join(canonicalRoot, ".omp", "compliance"));
}

function captureStorageIdentityForFile(filePath: string): StorageIdentity {
	const complianceDirectory = dirname(filePath);
	return captureStorageIdentityFromDirectories(dirname(complianceDirectory), complianceDirectory);
}

function captureStorageIdentityFromDirectories(ompDirectory: string, complianceDirectory: string): StorageIdentity {
	return Object.freeze({
		omp: captureDirectoryIdentity(ompDirectory),
		compliance: captureDirectoryIdentity(complianceDirectory),
	});
}

function captureDirectoryIdentity(path: string): DirectoryIdentity {
	try {
		const stats = lstatSync(path, { bigint: true });
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
		const stats = lstatSync(identity.path, { bigint: true });
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
	if (pathExists(complianceDirectory)) listPublishMarkerPaths(complianceDirectory);
}

interface PublishMarkerPath {
	readonly path: string;
	readonly token: string;
}

function listPublishMarkerPaths(directory: string): PublishMarkerPath[] {
	const markers: PublishMarkerPath[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(".project.")) continue;
		const marker = name.match(
			/^\.project\.publish\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i,
		);
		const prepared = name.match(
			/^\.project\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:tmp|ready)$/i,
		);
		if (!marker && !prepared) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		const path = join(directory, name);
		assertRegularFileOrMissing(path);
		if (marker?.[1]) markers.push(Object.freeze({ path, token: marker[1] }));
	}
	return markers;
}

function assertDirectoryNotLink(path: string, allowMissing = false): void {
	try {
		const stats = lstatSync(path, { bigint: true });
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
		const stats = lstatSync(path, { bigint: true });
		if (stats.isSymbolicLink() || !stats.isFile() || stats.dev !== expectedNode.dev || stats.ino !== expectedNode.ino) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		return Object.freeze({
			dev: stats.dev,
			ino: stats.ino,
			mtimeNs: stats.mtimeNs,
			ctimeNs: stats.ctimeNs,
			size: stats.size,
		});
	} catch (error) {
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function captureExistingRegularFileIdentity(path: string): FileIdentity {
	const stats = lstatSync(path, { bigint: true });
	if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
	return Object.freeze({
		dev: stats.dev,
		ino: stats.ino,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		size: stats.size,
	});
}

function captureOptionalRegularFileIdentity(path: string): FileIdentity | undefined {
	try {
		return captureExistingRegularFileIdentity(path);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function assertRegularFileIdentity(path: string, identity: FileIdentity): void {
	try {
		const stats = lstatSync(path, { bigint: true });
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
		const stats = lstatSync(path, { bigint: true });
		if (!stats.isSymbolicLink() && stats.isFile() && stats.dev === identity.dev && stats.ino === identity.ino) {
			unlinkSync(path);
		}
	} catch {
		// Best-effort cleanup must not remove a replacement path.
	}
}

function matchesRegularFileIdentity(path: string, identity: FileIdentity): boolean {
	try {
		const stats = lstatSync(path, { bigint: true });
		return !stats.isSymbolicLink() && stats.isFile() && sameFileIdentity(identity, stats);
	} catch (error) {
		if (isNotFound(error)) return false;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function removeFileIfIdentityMatches(path: string, identity: FileIdentity): boolean {
	try {
		const stats = lstatSync(path, { bigint: true });
		if (stats.isSymbolicLink() || !stats.isFile() || !sameFileIdentity(identity, stats)) {
			throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
		}
		unlinkSync(path);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		if (error instanceof Error && error.message === PROJECT_IDENTITY_INVALID_ERROR) throw error;
		throw new Error(PROJECT_IDENTITY_INVALID_ERROR, { cause: error });
	}
}

function parsePublishOwner(content: string, expectedToken: string): PublishOwner | undefined {
	try {
		const value = JSON.parse(content) as unknown;
		if (
			!isRecord(value) ||
			Object.keys(value).length !== 3 ||
			value.token !== expectedToken ||
			!Number.isSafeInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			(value.pid as number) > MAX_PROBEABLE_PID ||
			!isIsoTimestamp(value.createdAt)
		) {
			return undefined;
		}
		return Object.freeze({ token: value.token as string, pid: value.pid as number, createdAt: value.createdAt });
	} catch {
		return undefined;
	}
}

function readPublishMarkerSnapshot(marker: PublishMarkerPath): PublishMarkerSnapshot | undefined {
	try {
		const before = lstatSync(marker.path, { bigint: true });
		if (before.isSymbolicLink() || !before.isFile()) return undefined;
		const owner = parsePublishOwner(readFileNoFollow(marker.path, before, openSync), marker.token);
		const after = lstatSync(marker.path, { bigint: true });
		if (!sameFileIdentity(before, after)) return undefined;
		return Object.freeze({
			dev: after.dev,
			ino: after.ino,
			mtimeNs: after.mtimeNs,
			ctimeNs: after.ctimeNs,
			size: after.size,
			...(owner === undefined ? {} : { owner }),
		});
	} catch {
		return undefined;
	}
}

function isPublishMarkerActive(snapshot: PublishMarkerSnapshot): boolean {
	const ageMs = Date.now() - nanosecondsToMilliseconds(snapshot.mtimeNs);
	const timestampIsPlausible = ageMs >= -PUBLISH_TIMESTAMP_TOLERANCE_MS;
	if (!snapshot.owner) return timestampIsPlausible && ageMs < PUBLISH_RECOVERY_GRACE_MS;
	const ownerState = probePublishOwner(snapshot.owner, snapshot);
	if (ownerState === "current") return true;
	if (ownerState === "unknown") return timestampIsPlausible && ageMs < PUBLISH_OWNER_LEASE_MS;
	return false;
}

function sameFileIdentity(
	left: Pick<FileIdentity, "dev" | "ino" | "mtimeNs" | "ctimeNs" | "size">,
	right: Pick<FileIdentity, "dev" | "ino" | "mtimeNs" | "ctimeNs" | "size">,
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.size === right.size
	);
}

function nanosecondsToMilliseconds(value: bigint): number {
	return Number(value / 1_000_000n);
}

function probePublishOwner(owner: PublishOwner, snapshot: PublishMarkerSnapshot): PublishOwnerState {
	const createdAt = Date.parse(owner.createdAt);
	if (Math.abs(createdAt - nanosecondsToMilliseconds(snapshot.mtimeNs)) > PUBLISH_TIMESTAMP_TOLERANCE_MS)
		return "stale";
	const processState = probeProcess(owner.pid);
	if (processState === "dead") return "stale";
	if (processState === "unknown") return "unknown";
	const processStartedAt = readProcessStartedAt(owner.pid);
	if (processStartedAt === undefined) return "unknown";
	return processStartedAt <= createdAt + PUBLISH_TIMESTAMP_TOLERANCE_MS ? "current" : "stale";
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

function probeProcess(pid: number): ProcessState {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			if (error.code === "ESRCH") return "dead";
			if (error.code === "EPERM") return "alive";
		}
		return "unknown";
	}
}

function fsyncDirectory(directory: string, identity: DirectoryIdentity): void {
	assertDirectoryIdentity(identity);
	try {
		const fd = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
		try {
			const before = fstatSync(fd, { bigint: true });
			if (before.dev !== identity.dev || before.ino !== identity.ino) throw new Error(PROJECT_IDENTITY_INVALID_ERROR);
			fsyncSync(fd);
			const after = fstatSync(fd, { bigint: true });
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
	return isNonEmptyString(value) && parseCanonicalRemoteIdentity(value) === value;
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
