import { FFIType, type Pointer, dlopen, ptr, read } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { constants, fstatSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, parse, resolve, sep } from "node:path";

type SecureFsOperation =
	| "open_directory"
	| "open_file"
	| "lock_file"
	| "read_file"
	| "write_file"
	| "sync_file"
	| "rename_file"
	| "unlink_file"
	| "list_directory";

export class SecureFsError extends Error {
	constructor(
		readonly operation: SecureFsOperation,
		readonly code?: number,
		cause?: unknown,
	) {
		super(`Secure filesystem operation failed: ${operation}`, { cause });
		this.name = "SecureFsError";
	}
}

export interface SecureFsTestEvent {
	stage:
		| "directory_opened"
		| "lock_acquired"
		| "claim_created"
		| "event_appended"
		| "tail_recovered"
		| "recovery_entries_listed"
		| "snapshot_lock_acquired"
		| "snapshot_temp_synced"
		| "claim_journal_full_read"
		| "claim_journal_delta_read"
		| "claim_journal_appended"
		| "claim_journal_truncated"
		| "claim_journal_cache_stats"
		| "claim_journal_target_scan"
		| "legacy_claims_persisted"
		| "legacy_claims_migrated";
	bloomBytes?: number;
	hotSize?: number;
	pendingSize?: number;
}

let testHook: ((event: SecureFsTestEvent) => void) | undefined;

export function setSecureFsTestHook(hook: ((event: SecureFsTestEvent) => void) | undefined): void {
	testHook = hook;
}

export type SecureFsSyscall =
	| "open"
	| "openat"
	| "mkdirat"
	| "renameat"
	| "unlinkat"
	| "fstat"
	| "fsync"
	| "fchmod"
	| "close"
	| "write"
	| "read"
	| "pread"
	| "flock"
	| "lseek"
	| "ftruncate";

let eintrTestPlan = new Map<SecureFsSyscall, number>();

export function setSecureFsEintrTestPlan(plan: Partial<Record<SecureFsSyscall, number>> | undefined): void {
	eintrTestPlan = new Map(
		Object.entries(plan ?? {}).filter((entry): entry is [SecureFsSyscall, number] => (entry[1] ?? 0) > 0),
	);
}

export function getSecureFsEintrTestRemaining(): Partial<Record<SecureFsSyscall, number>> {
	return Object.fromEntries([...eintrTestPlan].filter(([, remaining]) => remaining > 0));
}

const supportedPlatform = process.platform === "darwin" || process.platform === "linux";
const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

const posix = supportedPlatform
	? dlopen(libraryPath, {
			open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			renameat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
			unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			fstat: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			fsync: { args: [FFIType.i32], returns: FFIType.i32 },
			fchmod: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
			close: { args: [FFIType.i32], returns: FFIType.i32 },
			write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
			read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
			pread: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
			ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
			...(process.platform === "darwin"
				? { __error: { args: [], returns: FFIType.ptr } }
				: { __errno_location: { args: [], returns: FFIType.ptr } }),
		}).symbols
	: undefined;

const LOCK_EX = 2;
const LOCK_UN = 8;
const SEEK_SET = 0;
const SEEK_END = 2;
const EINTR = osConstants.errno.EINTR;
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;

function requirePosix(): NonNullable<typeof posix> {
	if (!posix) {
		throw new SecureFsError("open_directory", undefined, new Error("POSIX secure filesystem is unavailable"));
	}
	return posix;
}

function errno(): number {
	const api = requirePosix() as typeof posix & {
		__error?: () => Pointer;
		__errno_location?: () => Pointer;
	};
	const address = process.platform === "darwin" ? api.__error?.() : api.__errno_location?.();
	return address ? read.u32(address) : 0;
}

function retryPosix<T extends number | bigint>(syscall: SecureFsSyscall, operation: () => T): T {
	for (;;) {
		const simulated = eintrTestPlan.get(syscall) ?? 0;
		if (simulated > 0) {
			if (simulated === 1) eintrTestPlan.delete(syscall);
			else eintrTestPlan.set(syscall, simulated - 1);
			continue;
		}
		const result = operation();
		if (Number(result) >= 0) return result;
		if (errno() !== EINTR) return result;
		if (syscall === "close" && process.platform === "linux") return 0 as T;
	}
}

function cString(value: string): Buffer {
	return Buffer.from(`${value}\0`);
}

function invokePath<T>(value: string, operation: (address: ReturnType<typeof ptr>) => T): T {
	const buffer = cString(value);
	return operation(ptr(buffer));
}

function fail(operation: SecureFsOperation): never {
	throw new SecureFsError(operation, errno());
}

function closeQuietly(descriptor: number): void {
	try {
		retryPosix("close", () => requirePosix().close(descriptor));
	} catch {
		// Preserve the authoritative operation failure.
	}
}

function assertComponent(component: string): void {
	if (!component || component === "." || component === ".." || component.includes("/") || component.includes("\\")) {
		throw new SecureFsError("open_directory", undefined, new Error("Invalid secure path component"));
	}
}

interface CanonicalTrustedRoot {
	path: string;
	anchorDepth: number;
	anchorDevice: bigint;
	anchorInode: bigint;
}

function canonicalTrustedRoot(path: string): CanonicalTrustedRoot {
	const trustedRoot = resolve(path);
	let canonicalExisting: string;
	try {
		lstatSync(trustedRoot);
		canonicalExisting = realpathSync.native(trustedRoot);
	} catch (error) {
		throw new SecureFsError("open_directory", undefined, error);
	}
	const identity = lstatSync(canonicalExisting, { bigint: true });
	if (!identity.isDirectory()) {
		throw new SecureFsError("open_directory", undefined, new Error("Trusted root is not a directory"));
	}
	const anchorDepth = canonicalExisting.slice(sep.length).split(sep).filter(Boolean).length;
	return {
		path: canonicalExisting,
		anchorDepth,
		anchorDevice: identity.dev,
		anchorInode: identity.ino,
	};
}

function directoryIdentity(descriptor: number): { device: bigint; inode: bigint } {
	const status = Buffer.alloc(256);
	if (retryPosix("fstat", () => requirePosix().fstat(descriptor, ptr(status))) < 0) fail("open_directory");
	return process.platform === "darwin"
		? { device: BigInt(status.readUInt32LE(0)), inode: status.readBigUInt64LE(8) }
		: { device: status.readBigUInt64LE(0), inode: status.readBigUInt64LE(8) };
}

function openAt(directory: number, name: string, flags: number, mode = 0): number {
	assertComponent(name);
	const descriptor = invokePath(name, (address) =>
		retryPosix("openat", () => requirePosix().openat(directory, address, flags, mode)),
	);
	if (descriptor < 0) fail("open_file");
	return descriptor;
}

function openOrCreateAt(directory: number, name: string): number {
	try {
		return openAt(directory, name, constants.O_RDWR | constants.O_NOFOLLOW);
	} catch (error) {
		if (!(error instanceof SecureFsError) || error.code !== osConstants.errno.ENOENT) throw error;
	}

	try {
		const descriptor = openAt(
			directory,
			name,
			constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		if (retryPosix("fchmod", () => requirePosix().fchmod(descriptor, 0o600)) < 0) {
			closeQuietly(descriptor);
			fail("open_file");
		}
		return descriptor;
	} catch (error) {
		if (!(error instanceof SecureFsError) || error.code !== osConstants.errno.EEXIST) throw error;
		return openAt(directory, name, constants.O_RDWR | constants.O_NOFOLLOW);
	}
}

function writeAll(descriptor: number, content: Buffer): void {
	let offset = 0;
	while (offset < content.byteLength) {
		const written = Number(
			retryPosix("write", () => requirePosix().write(descriptor, ptr(content, offset), content.byteLength - offset)),
		);
		if (written <= 0) fail("write_file");
		offset += written;
	}
}

function readAll(descriptor: number): Buffer {
	if (Number(retryPosix("lseek", () => requirePosix().lseek(descriptor, 0, SEEK_SET))) < 0) fail("read_file");
	const chunks: Buffer[] = [];
	for (;;) {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		const bytesRead = Number(retryPosix("read", () => requirePosix().read(descriptor, ptr(chunk), chunk.byteLength)));
		if (bytesRead < 0) fail("read_file");
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks);
}

function preadAll(descriptor: number, offset: number, length: number): Buffer {
	const content = Buffer.allocUnsafe(length);
	let bytesRead = 0;
	while (bytesRead < length) {
		const current = Number(
			retryPosix("pread", () =>
				requirePosix().pread(descriptor, ptr(content, bytesRead), length - bytesRead, offset + bytesRead),
			),
		);
		if (current < 0) fail("read_file");
		if (current === 0) break;
		bytesRead += current;
	}
	return content.subarray(0, bytesRead);
}

function appendAndSync(descriptor: number, content: Buffer): void {
	if (Number(retryPosix("lseek", () => requirePosix().lseek(descriptor, 0, SEEK_END))) < 0) fail("write_file");
	writeAll(descriptor, content);
	if (retryPosix("fsync", () => requirePosix().fsync(descriptor)) < 0) fail("sync_file");
}

function fileContainsEventId(descriptor: number, eventId: string): boolean {
	const content = readAll(descriptor).toString("utf8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { eventId?: unknown };
			if (event.eventId === eventId) return true;
		} catch {
			// Truncated or malformed lines are not committed events.
		}
	}
	return false;
}

function atomicReplaceAt(directory: number, name: string, content: Buffer, afterTemporarySync?: () => void): void {
	const temporaryName = `.${name}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	let temporaryExists = false;
	try {
		descriptor = openAt(
			directory,
			temporaryName,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		temporaryExists = true;
		if (retryPosix("fchmod", () => requirePosix().fchmod(descriptor as number, 0o600)) < 0) fail("open_file");
		writeAll(descriptor, content);
		if (retryPosix("fsync", () => requirePosix().fsync(descriptor as number)) < 0) fail("sync_file");
		afterTemporarySync?.();
		closeQuietly(descriptor);
		descriptor = undefined;
		const result = invokePath(temporaryName, (temporaryAddress) =>
			invokePath(name, (finalAddress) =>
				retryPosix("renameat", () => requirePosix().renameat(directory, temporaryAddress, directory, finalAddress)),
			),
		);
		if (result < 0) fail("rename_file");
		temporaryExists = false;
		if (retryPosix("fsync", () => requirePosix().fsync(directory)) < 0) fail("sync_file");
	} finally {
		if (descriptor !== undefined) closeQuietly(descriptor);
		if (temporaryExists) {
			try {
				const result = invokePath(temporaryName, (address) =>
					retryPosix("unlinkat", () => requirePosix().unlinkat(directory, address, 0)),
				);
				if (result < 0 && errno() !== osConstants.errno.ENOENT) fail("unlink_file");
			} catch {
				// Cleanup cannot replace the authoritative write failure.
			}
		}
	}
}

export interface SecureLockedFile {
	read(): Buffer;
	append(content: Buffer): void;
}

export interface SecureRecoveryRecord {
	eventId: string;
	content: Buffer;
}

export type SecureRecoveryFactory = (content: string, truncatedTail: string) => SecureRecoveryRecord;

type ClaimState = "pending" | "done";

interface ClaimJournalRecord {
	eventId: string;
	state: ClaimState;
}

const CLAIM_BLOOM_BYTES = 1024 * 1024;
const CLAIM_HOT_LIMIT = 4_096;

class ClaimBloom {
	private readonly bits = Buffer.alloc(CLAIM_BLOOM_BYTES);

	get byteLength(): number {
		return this.bits.byteLength;
	}

	add(eventId: string): void {
		for (const position of this.positions(eventId)) {
			const byte = position >>> 3;
			this.bits[byte] = (this.bits[byte] ?? 0) | (1 << (position & 7));
		}
	}

	mightContain(eventId: string): boolean {
		for (const position of this.positions(eventId)) {
			if (((this.bits[position >>> 3] ?? 0) & (1 << (position & 7))) === 0) return false;
		}
		return true;
	}

	private positions(eventId: string): number[] {
		const digest = createHash("sha256").update(eventId).digest();
		const first = digest.readUInt32LE(0);
		const second = (digest.readUInt32LE(4) | 1) >>> 0;
		const bitCount = this.bits.byteLength * 8;
		return Array.from({ length: 7 }, (_, index) => (first + index * second + index * index) % bitCount);
	}
}

interface ClaimJournalCache {
	device: bigint;
	inode: bigint;
	offset: number;
	mtimeNs: bigint;
	bloom: ClaimBloom;
	hotDone: Map<string, true>;
	pending: Set<string>;
}

function rememberDone(cache: ClaimJournalCache, eventId: string): void {
	cache.hotDone.delete(eventId);
	cache.hotDone.set(eventId, true);
	if (cache.hotDone.size > CLAIM_HOT_LIMIT) {
		const oldest = cache.hotDone.keys().next().value;
		if (oldest !== undefined) cache.hotDone.delete(oldest);
	}
}

function applyClaimRecord(cache: ClaimJournalCache, record: ClaimJournalRecord): void {
	if (record.state === "pending") {
		cache.pending.add(record.eventId);
		cache.hotDone.delete(record.eventId);
		return;
	}
	cache.pending.delete(record.eventId);
	cache.bloom.add(record.eventId);
	rememberDone(cache, record.eventId);
}

function emitClaimCacheStats(cache: ClaimJournalCache): void {
	testHook?.({
		stage: "claim_journal_cache_stats",
		bloomBytes: cache.bloom.byteLength,
		hotSize: cache.hotDone.size,
		pendingSize: cache.pending.size,
	});
}

function claimState(content: string): { state: "pending" | "done"; eventId?: string } | undefined {
	const match = /^(pending|done)(?: ([^\n]+))?\n$/.exec(content);
	if (!match) return undefined;
	return { state: match[1] as "pending" | "done", eventId: match[2] };
}

function withNamedLock<T>(directory: number, lockName: string, operation: () => T): T {
	let descriptor: number | undefined;
	let directoryLocked = false;
	let locked = false;
	try {
		if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_EX)) < 0) fail("lock_file");
		directoryLocked = true;
		descriptor = openOrCreateAt(directory, lockName);
		if (retryPosix("flock", () => requirePosix().flock(descriptor as number, LOCK_EX)) < 0) fail("lock_file");
		locked = true;
		if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN)) < 0) fail("lock_file");
		directoryLocked = false;
		return operation();
	} finally {
		if (directoryLocked) retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN));
		if (descriptor !== undefined) {
			if (locked) retryPosix("flock", () => requirePosix().flock(descriptor as number, LOCK_UN));
			closeQuietly(descriptor);
		}
	}
}

export class SecurePathScope {
	private readonly components: string[];
	private readonly absolutePath: string;
	private readonly anchorDepth: number;
	private readonly anchorDevice: bigint;
	private readonly anchorInode: bigint;
	private readonly claimJournalCache = new Map<string, ClaimJournalCache>();

	constructor(root: string, childDirectories: readonly string[] = []) {
		const canonical = canonicalTrustedRoot(root);
		const absoluteRoot = canonical.path;
		if (!isAbsolute(absoluteRoot) || parse(absoluteRoot).root !== sep) {
			throw new SecureFsError("open_directory", undefined, new Error("Secure root must be absolute"));
		}
		const rootComponents = absoluteRoot.slice(sep.length).split(sep).filter(Boolean);
		for (const component of [...rootComponents, ...childDirectories]) assertComponent(component);
		this.components = [...rootComponents, ...childDirectories];
		this.absolutePath = `${sep}${this.components.join(sep)}`;
		this.anchorDepth = canonical.anchorDepth;
		this.anchorDevice = canonical.anchorDevice;
		this.anchorInode = canonical.anchorInode;
	}

	static forFile(path: string): SecurePathScope {
		const parent = dirname(resolve(path));
		const trustedRoot = dirname(parent);
		return parent === trustedRoot ? new SecurePathScope(parent) : new SecurePathScope(trustedRoot, [basename(parent)]);
	}

	withLockedFile<T>(
		name: string,
		options: { createDirectory: boolean; createFile: boolean },
		operation: (file: SecureLockedFile) => T,
	): T | undefined {
		assertComponent(name);
		const directory = this.openDirectory(options.createDirectory);
		if (directory === undefined) return undefined;
		testHook?.({ stage: "directory_opened" });
		let descriptor: number | undefined;
		let locked = false;
		let directoryLocked = false;
		try {
			if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_EX)) < 0) fail("lock_file");
			directoryLocked = true;
			try {
				descriptor = options.createFile
					? openOrCreateAt(directory, name)
					: openAt(directory, name, constants.O_RDWR | constants.O_NOFOLLOW);
			} catch (error) {
				if (!options.createFile && error instanceof SecureFsError && error.code === osConstants.errno.ENOENT) {
					return undefined;
				}
				throw error;
			}
			if (retryPosix("flock", () => requirePosix().flock(descriptor as number, LOCK_EX)) < 0) fail("lock_file");
			locked = true;
			if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN)) < 0) fail("lock_file");
			directoryLocked = false;
			testHook?.({ stage: "lock_acquired" });
			const result = operation({
				read: () => readAll(descriptor as number),
				append: (content) => {
					if (Number(retryPosix("lseek", () => requirePosix().lseek(descriptor as number, 0, SEEK_END))) < 0) {
						fail("write_file");
					}
					writeAll(descriptor as number, content);
					if (retryPosix("fsync", () => requirePosix().fsync(descriptor as number)) < 0) fail("sync_file");
				},
			});
			if (options.createFile && retryPosix("fsync", () => requirePosix().fsync(directory)) < 0) fail("sync_file");
			return result;
		} finally {
			if (directoryLocked) retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN));
			if (descriptor !== undefined) {
				if (locked) retryPosix("flock", () => requirePosix().flock(descriptor as number, LOCK_UN));
				closeQuietly(descriptor);
			}
			closeQuietly(directory);
		}
	}

	readFile(name: string): Buffer | undefined {
		return this.withLockedFile(name, { createDirectory: false, createFile: false }, (file) => file.read());
	}

	appendIdempotent(name: string, eventId: string, content: Buffer, recoveryFactory: SecureRecoveryFactory): void {
		assertComponent(name);
		const directory = this.openDirectory(true);
		if (directory === undefined) fail("open_directory");
		testHook?.({ stage: "directory_opened" });
		const journalName = `.${name}.claims.jsonl`;
		const legacyDirectoryName = `.${name}.claims`;
		let logDescriptor: number | undefined;
		let journalDescriptor: number | undefined;
		let directoryLocked = false;
		let logLocked = false;
		let completed = false;
		try {
			if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_EX)) < 0) fail("lock_file");
			directoryLocked = true;
			logDescriptor = openOrCreateAt(directory, name);
			journalDescriptor = openOrCreateAt(directory, journalName);
			if (retryPosix("fsync", () => requirePosix().fsync(directory)) < 0) fail("sync_file");
			if (retryPosix("flock", () => requirePosix().flock(logDescriptor as number, LOCK_EX)) < 0) fail("lock_file");
			logLocked = true;
			if (retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN)) < 0) fail("lock_file");
			directoryLocked = false;
			testHook?.({ stage: "lock_acquired" });
			const journal = this.refreshClaimJournal(journalName, journalDescriptor);
			const migratedEventIds = this.migrateLegacyClaims(
				directory,
				legacyDirectoryName,
				journalDescriptor,
				journal,
				logDescriptor,
			);

			const initialState = this.getClaimState(journalDescriptor, journal, eventId);
			if (initialState === "done") {
				completed = true;
				return;
			}
			if (initialState === undefined) {
				this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "pending" });
				testHook?.({ stage: "claim_created" });
			}

			this.recoverUnterminatedTail(logDescriptor, journalDescriptor, journal, recoveryFactory);
			if (this.getClaimState(journalDescriptor, journal, eventId) === "done") {
				completed = true;
				return;
			}
			if (
				initialState === "pending" &&
				(migratedEventIds?.has(eventId) ?? fileContainsEventId(logDescriptor, eventId))
			) {
				this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "done" });
				completed = true;
				return;
			}

			appendAndSync(logDescriptor, content);
			testHook?.({ stage: "event_appended" });
			this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "done" });
			completed = true;
		} finally {
			try {
				if (completed) this.assertCanonicalDirectory(directory);
			} finally {
				if (directoryLocked) retryPosix("flock", () => requirePosix().flock(directory, LOCK_UN));
				if (logDescriptor !== undefined) {
					if (logLocked) retryPosix("flock", () => requirePosix().flock(logDescriptor as number, LOCK_UN));
					closeQuietly(logDescriptor);
				}
				if (journalDescriptor !== undefined) closeQuietly(journalDescriptor);
				closeQuietly(directory);
			}
		}
	}

	private recoverUnterminatedTail(
		logDescriptor: number,
		journalDescriptor: number,
		journal: ClaimJournalCache,
		recoveryFactory: SecureRecoveryFactory,
	): void {
		const size = Number(retryPosix("lseek", () => requirePosix().lseek(logDescriptor, 0, SEEK_END)));
		if (size < 0) fail("read_file");
		if (size === 0) return;

		const finalByte = Buffer.allocUnsafe(1);
		const bytesRead = Number(
			retryPosix("pread", () => requirePosix().pread(logDescriptor, ptr(finalByte), 1, size - 1)),
		);
		if (bytesRead !== 1) fail("read_file");
		if (finalByte[0] === 0x0a) return;

		const content = readAll(logDescriptor).toString("utf8");
		const truncatedTail = content.slice(content.lastIndexOf("\n") + 1);
		try {
			JSON.parse(truncatedTail);
			if (Number(retryPosix("lseek", () => requirePosix().lseek(logDescriptor, 0, SEEK_END))) < 0) {
				fail("write_file");
			}
			writeAll(logDescriptor, Buffer.from("\n"));
			if (retryPosix("fsync", () => requirePosix().fsync(logDescriptor)) < 0) fail("sync_file");
			return;
		} catch (error) {
			if (error instanceof SecureFsError) throw error;
		}

		const recovery = recoveryFactory(content, truncatedTail);
		this.appendClaimedWhileLocked(
			journalDescriptor,
			journal,
			logDescriptor,
			recovery.eventId,
			Buffer.concat([Buffer.from("\n"), recovery.content]),
		);
		testHook?.({ stage: "tail_recovered" });
	}

	private appendClaimedWhileLocked(
		journalDescriptor: number,
		journal: ClaimJournalCache,
		logDescriptor: number,
		eventId: string,
		content: Buffer,
	): void {
		const state = this.getClaimState(journalDescriptor, journal, eventId);
		if (state === "done") return;
		if (state === undefined) {
			this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "pending" });
		} else if (fileContainsEventId(logDescriptor, eventId)) {
			this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "done" });
			return;
		}

		appendAndSync(logDescriptor, content);
		this.appendClaimJournalRecord(journalDescriptor, journal, { eventId, state: "done" });
	}

	private refreshClaimJournal(name: string, descriptor: number): ClaimJournalCache {
		const status = fstatSync(descriptor, { bigint: true });
		const existing = this.claimJournalCache.get(name);
		const canReadDelta =
			existing !== undefined &&
			existing.device === status.dev &&
			existing.inode === status.ino &&
			status.size >= BigInt(existing.offset) &&
			(status.size > BigInt(existing.offset) || existing.mtimeNs === status.mtimeNs);
		const offset = canReadDelta ? (existing?.offset ?? 0) : 0;
		const cache: ClaimJournalCache = canReadDelta
			? (existing as ClaimJournalCache)
			: {
					device: status.dev,
					inode: status.ino,
					offset: 0,
					mtimeNs: status.mtimeNs,
					bloom: new ClaimBloom(),
					hotDone: new Map(),
					pending: new Set(),
				};
		const size = Number(status.size);
		if (!Number.isSafeInteger(size))
			throw new SecureFsError("read_file", undefined, new Error("Claim journal is too large"));
		const unread = preadAll(descriptor, offset, size - offset);
		if (offset === 0) testHook?.({ stage: "claim_journal_full_read" });
		else if (unread.byteLength > 0) testHook?.({ stage: "claim_journal_delta_read" });

		let completeLength = unread.byteLength;
		if (unread.byteLength > 0 && unread[unread.byteLength - 1] !== 0x0a) {
			completeLength = unread.lastIndexOf(0x0a) + 1;
			const committedLength = offset + completeLength;
			if (retryPosix("ftruncate", () => requirePosix().ftruncate(descriptor, committedLength)) < 0) {
				fail("write_file");
			}
			if (retryPosix("fsync", () => requirePosix().fsync(descriptor)) < 0) fail("sync_file");
			testHook?.({ stage: "claim_journal_truncated" });
		}

		const committed = unread.subarray(0, completeLength).toString("utf8");
		for (const line of committed.split("\n")) {
			if (!line) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch (error) {
				throw new SecureFsError("read_file", undefined, error);
			}
			if (
				typeof record !== "object" ||
				record === null ||
				typeof (record as Partial<ClaimJournalRecord>).eventId !== "string" ||
				!(["pending", "done"] as const).includes((record as Partial<ClaimJournalRecord>).state as ClaimState)
			) {
				throw new SecureFsError("read_file", undefined, new Error("Invalid claim journal record"));
			}
			applyClaimRecord(cache, record as ClaimJournalRecord);
		}
		cache.offset = offset + completeLength;
		const refreshed = fstatSync(descriptor, { bigint: true });
		cache.device = refreshed.dev;
		cache.inode = refreshed.ino;
		cache.mtimeNs = refreshed.mtimeNs;
		this.claimJournalCache.set(name, cache);
		emitClaimCacheStats(cache);
		return cache;
	}

	private appendClaimJournalRecord(descriptor: number, cache: ClaimJournalCache, record: ClaimJournalRecord): void {
		const content = Buffer.from(`${JSON.stringify(record)}\n`);
		appendAndSync(descriptor, content);
		applyClaimRecord(cache, record);
		cache.offset += content.byteLength;
		cache.mtimeNs = fstatSync(descriptor, { bigint: true }).mtimeNs;
		testHook?.({ stage: "claim_journal_appended" });
		emitClaimCacheStats(cache);
	}

	private getClaimState(descriptor: number, cache: ClaimJournalCache, eventId: string): ClaimState | undefined {
		if (cache.pending.has(eventId)) return "pending";
		if (cache.hotDone.has(eventId)) {
			rememberDone(cache, eventId);
			return "done";
		}
		if (!cache.bloom.mightContain(eventId)) return undefined;

		testHook?.({ stage: "claim_journal_target_scan" });
		let state: ClaimState | undefined;
		for (const line of readAll(descriptor).toString("utf8").split("\n")) {
			if (!line) continue;
			let record: ClaimJournalRecord;
			try {
				record = JSON.parse(line) as ClaimJournalRecord;
			} catch (error) {
				throw new SecureFsError("read_file", undefined, error);
			}
			if (record.eventId === eventId && (record.state === "pending" || record.state === "done")) {
				state = record.state;
			}
		}
		if (state === "done") {
			cache.pending.delete(eventId);
			cache.bloom.add(eventId);
			rememberDone(cache, eventId);
		} else if (state === "pending") {
			cache.pending.add(eventId);
		}
		emitClaimCacheStats(cache);
		return state;
	}

	private migrateLegacyClaims(
		directory: number,
		legacyDirectoryName: string,
		journalDescriptor: number,
		journal: ClaimJournalCache,
		logDescriptor: number,
	): Set<string> | undefined {
		const legacyDirectory = this.openChildDirectory(directory, legacyDirectoryName, false);
		if (legacyDirectory === undefined) return;
		const legacyPath = `${this.absolutePath}${sep}${legacyDirectoryName}`;
		const entries = this.discoverEntriesAt(legacyDirectory, legacyPath);
		const migrated = new Map<string, ClaimState>();
		const legacyEventIds = new Map<string, string>();
		const eventsInLog = new Set<string>();
		for (const line of readAll(logDescriptor).toString("utf8").split("\n")) {
			if (!line) continue;
			try {
				const event = JSON.parse(line) as { eventId?: unknown };
				if (typeof event.eventId === "string") {
					eventsInLog.add(event.eventId);
					legacyEventIds.set(createHash("sha256").update(event.eventId).digest("hex"), event.eventId);
				}
			} catch {
				// A malformed event tail is handled by the normal recovery path.
			}
		}

		try {
			for (const entry of entries) {
				let descriptor: number | undefined;
				try {
					descriptor = openAt(legacyDirectory, entry, constants.O_RDONLY | constants.O_NOFOLLOW);
					const content = readAll(descriptor).toString("utf8");
					if (entry === ".checkpoint.json") {
						const checkpoint = JSON.parse(content) as { version?: unknown; eventIds?: unknown };
						if (checkpoint.version !== 1 || !Array.isArray(checkpoint.eventIds)) {
							throw new Error("Invalid legacy checkpoint");
						}
						for (const eventId of checkpoint.eventIds) {
							if (typeof eventId !== "string") throw new Error("Invalid legacy checkpoint eventId");
							migrated.set(eventId, "done");
						}
						continue;
					}
					const match = /^([0-9a-f]{64})\.claim$/.exec(entry);
					const state = claimState(content);
					if (!match || !state) throw new Error("Invalid legacy claim");
					const legacyEventId = state.eventId ?? legacyEventIds.get(match[1] as string);
					if (!legacyEventId) throw new Error("Legacy claim eventId cannot be recovered");
					if (state.state === "done" || migrated.get(legacyEventId) !== "done") {
						migrated.set(legacyEventId, state.state);
					}
				} finally {
					if (descriptor !== undefined) closeQuietly(descriptor);
				}
			}

			for (const [legacyEventId, state] of migrated) {
				const current = this.getClaimState(journalDescriptor, journal, legacyEventId);
				if (current === "done" || current === state) continue;
				this.appendClaimJournalRecord(journalDescriptor, journal, { eventId: legacyEventId, state });
			}
			testHook?.({ stage: "legacy_claims_persisted" });

			for (const entry of entries) {
				const result = invokePath(entry, (address) =>
					retryPosix("unlinkat", () => requirePosix().unlinkat(legacyDirectory, address, 0)),
				);
				if (result < 0 && errno() !== osConstants.errno.ENOENT) fail("unlink_file");
			}
			if (retryPosix("fsync", () => requirePosix().fsync(legacyDirectory)) < 0) fail("sync_file");
		} catch (error) {
			if (error instanceof SecureFsError) throw error;
			throw new SecureFsError("read_file", undefined, error);
		} finally {
			closeQuietly(legacyDirectory);
		}

		const result = invokePath(legacyDirectoryName, (address) =>
			retryPosix("unlinkat", () => requirePosix().unlinkat(directory, address, AT_REMOVEDIR)),
		);
		if (result < 0 && errno() !== osConstants.errno.ENOENT) fail("unlink_file");
		if (retryPosix("fsync", () => requirePosix().fsync(directory)) < 0) fail("sync_file");
		testHook?.({ stage: "legacy_claims_migrated" });
		return eventsInLog;
	}

	atomicWrite(name: string, content: Buffer): void {
		assertComponent(name);
		const directory = this.openDirectory(true);
		if (directory === undefined) fail("open_directory");
		testHook?.({ stage: "directory_opened" });
		let completed = false;
		try {
			withNamedLock(directory, `.${name}.lock`, () => {
				testHook?.({ stage: "snapshot_lock_acquired" });
				atomicReplaceAt(directory, name, content, () => testHook?.({ stage: "snapshot_temp_synced" }));
			});
			completed = true;
		} finally {
			try {
				if (completed) this.assertCanonicalDirectory(directory);
			} finally {
				closeQuietly(directory);
			}
		}
	}

	ensureDirectory(name: string): void {
		assertComponent(name);
		const parent = this.openDirectory(true);
		if (parent === undefined) fail("open_directory");
		let child: number | undefined;
		try {
			child = this.openChildDirectory(parent, name, true);
			if (child === undefined) fail("open_directory");
			if (retryPosix("fsync", () => requirePosix().fsync(parent)) < 0) fail("sync_file");
		} finally {
			if (child !== undefined) closeQuietly(child);
			closeQuietly(parent);
		}
	}

	listDirectories(): string[] {
		const directory = this.openDirectory(false);
		if (directory === undefined) return [];
		try {
			return this.discoverEntries(directory).filter((name) => {
				try {
					const child = openAt(
						directory,
						name,
						constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					closeQuietly(child);
					return true;
				} catch (error) {
					if (
						error instanceof SecureFsError &&
						(error.code === osConstants.errno.ENOENT ||
							error.code === osConstants.errno.ENOTDIR ||
							error.code === osConstants.errno.ELOOP)
					) {
						return false;
					}
					throw error;
				}
			});
		} finally {
			closeQuietly(directory);
		}
	}

	removeAtomicTemps(fileName: string): string[] {
		assertComponent(fileName);
		const directory = this.openDirectory(false);
		if (directory === undefined) return [];
		const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const temporaryPattern = new RegExp(
			`^\\.${escapedFileName}\\.[0-9a-f]{8}-[0-9a-f]{4}-[457][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
			"i",
		);
		try {
			return withNamedLock(directory, `.${fileName}.lock`, () => {
				testHook?.({ stage: "snapshot_lock_acquired" });
				const removed: string[] = [];
				for (const name of this.discoverEntries(directory)) {
					if (!temporaryPattern.test(name)) continue;
					let descriptor: number | undefined;
					try {
						descriptor = openAt(directory, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
						if (!fstatSync(descriptor).isFile()) continue;
					} catch (error) {
						if (
							error instanceof SecureFsError &&
							(error.code === osConstants.errno.ENOENT || error.code === osConstants.errno.ELOOP)
						) {
							continue;
						}
						throw error;
					} finally {
						if (descriptor !== undefined) closeQuietly(descriptor);
					}

					const result = invokePath(name, (address) =>
						retryPosix("unlinkat", () => requirePosix().unlinkat(directory, address, 0)),
					);
					if (result < 0) {
						if (errno() === osConstants.errno.ENOENT) continue;
						fail("unlink_file");
					}
					removed.push(name);
				}
				if (removed.length > 0 && retryPosix("fsync", () => requirePosix().fsync(directory)) < 0) fail("sync_file");
				return removed;
			});
		} finally {
			closeQuietly(directory);
		}
	}

	private discoverEntries(directory: number): string[] {
		return this.discoverEntriesAt(directory, this.absolutePath, true);
	}

	private discoverEntriesAt(directory: number, absolutePath: string, emitRecoveryHook = false): string[] {
		let entries: string[];
		try {
			entries = readdirSync(absolutePath);
		} catch (error) {
			throw new SecureFsError("list_directory", undefined, error);
		}
		if (emitRecoveryHook) testHook?.({ stage: "recovery_entries_listed" });
		let status: ReturnType<typeof lstatSync>;
		try {
			status = lstatSync(absolutePath, { bigint: true });
		} catch (error) {
			throw new SecureFsError("list_directory", undefined, error);
		}
		const identity = directoryIdentity(directory);
		if (
			status.isSymbolicLink() ||
			!status.isDirectory() ||
			status.dev !== identity.device ||
			status.ino !== identity.inode
		) {
			throw new SecureFsError("list_directory", undefined, new Error("Secure directory identity changed"));
		}
		return entries;
	}

	private openDirectory(create: boolean): number | undefined {
		const api = requirePosix();
		const rootPath = cString(sep);
		let current = retryPosix("open", () =>
			api.open(ptr(rootPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0),
		);
		if (current < 0) fail("open_directory");
		try {
			if (this.anchorDepth === 0) this.verifyAnchor(current);
			for (const [index, component] of this.components.entries()) {
				const next = this.openChildDirectory(current, component, create);
				if (next === undefined) {
					closeQuietly(current);
					return undefined;
				}
				closeQuietly(current);
				current = next;
				if (index + 1 === this.anchorDepth) this.verifyAnchor(current);
			}
			return current;
		} catch (error) {
			closeQuietly(current);
			throw error;
		}
	}

	private assertCanonicalDirectory(expectedDescriptor: number): void {
		const canonical = this.openDirectory(false);
		if (canonical === undefined) {
			throw new SecureFsError("open_directory", undefined, new Error("Secure directory path disappeared"));
		}
		try {
			const expected = directoryIdentity(expectedDescriptor);
			const current = directoryIdentity(canonical);
			if (current.device !== expected.device || current.inode !== expected.inode) {
				throw new SecureFsError("open_directory", undefined, new Error("Secure directory identity changed"));
			}
		} finally {
			closeQuietly(canonical);
		}
	}

	private verifyAnchor(descriptor: number): void {
		const identity = directoryIdentity(descriptor);
		if (identity.device !== this.anchorDevice || identity.inode !== this.anchorInode) {
			throw new SecureFsError("open_directory", undefined, new Error("Secure directory identity changed"));
		}
	}

	private openChildDirectory(parent: number, name: string, create: boolean): number | undefined {
		const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
		try {
			return openAt(parent, name, flags);
		} catch (error) {
			if (!(error instanceof SecureFsError) || error.code !== osConstants.errno.ENOENT) throw error;
			if (!create) return undefined;
		}

		const result = invokePath(name, (address) =>
			retryPosix("mkdirat", () => requirePosix().mkdirat(parent, address, 0o700)),
		);
		if (result < 0 && errno() !== osConstants.errno.EEXIST) fail("open_directory");
		return openAt(parent, name, flags);
	}
}

export function secureFileName(path: string): string {
	const name = basename(resolve(path));
	assertComponent(name);
	return name;
}
