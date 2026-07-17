import { FFIType, type Pointer, dlopen, ptr, read } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
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
	| "unlink_file";

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
	stage: "directory_opened" | "lock_acquired" | "claim_created" | "event_appended";
}

let testHook: ((event: SecureFsTestEvent) => void) | undefined;

export function setSecureFsTestHook(hook: ((event: SecureFsTestEvent) => void) | undefined): void {
	testHook = hook;
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
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
			...(process.platform === "darwin"
				? { __error: { args: [], returns: FFIType.ptr } }
				: { __errno_location: { args: [], returns: FFIType.ptr } }),
		}).symbols
	: undefined;

const LOCK_EX = 2;
const LOCK_UN = 8;
const SEEK_SET = 0;
const SEEK_END = 2;

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
		requirePosix().close(descriptor);
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
	if (requirePosix().fstat(descriptor, ptr(status)) < 0) fail("open_directory");
	return process.platform === "darwin"
		? { device: BigInt(status.readUInt32LE(0)), inode: status.readBigUInt64LE(8) }
		: { device: status.readBigUInt64LE(0), inode: status.readBigUInt64LE(8) };
}

function openAt(directory: number, name: string, flags: number, mode = 0): number {
	assertComponent(name);
	const descriptor = invokePath(name, (address) => requirePosix().openat(directory, address, flags, mode));
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
		if (requirePosix().fchmod(descriptor, 0o600) < 0) {
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
		const written = Number(requirePosix().write(descriptor, ptr(content, offset), content.byteLength - offset));
		if (written <= 0) fail("write_file");
		offset += written;
	}
}

function readAll(descriptor: number): Buffer {
	if (Number(requirePosix().lseek(descriptor, 0, SEEK_SET)) < 0) fail("read_file");
	const chunks: Buffer[] = [];
	for (;;) {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		const bytesRead = Number(requirePosix().read(descriptor, ptr(chunk), chunk.byteLength));
		if (bytesRead < 0) fail("read_file");
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks);
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

function createExclusiveAt(directory: number, name: string, content: Buffer): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = openAt(
			directory,
			name,
			constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		if (requirePosix().fchmod(descriptor, 0o600) < 0) fail("open_file");
		writeAll(descriptor, content);
		if (requirePosix().fsync(descriptor) < 0) fail("sync_file");
		return true;
	} catch (error) {
		if (error instanceof SecureFsError && error.code === osConstants.errno.EEXIST) return false;
		throw error;
	} finally {
		if (descriptor !== undefined) closeQuietly(descriptor);
	}
}

function atomicReplaceAt(directory: number, name: string, content: Buffer): void {
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
		if (requirePosix().fchmod(descriptor, 0o600) < 0) fail("open_file");
		writeAll(descriptor, content);
		if (requirePosix().fsync(descriptor) < 0) fail("sync_file");
		closeQuietly(descriptor);
		descriptor = undefined;
		const result = invokePath(temporaryName, (temporaryAddress) =>
			invokePath(name, (finalAddress) => requirePosix().renameat(directory, temporaryAddress, directory, finalAddress)),
		);
		if (result < 0) fail("rename_file");
		temporaryExists = false;
		if (requirePosix().fsync(directory) < 0) fail("sync_file");
	} finally {
		if (descriptor !== undefined) closeQuietly(descriptor);
		if (temporaryExists) {
			try {
				const result = invokePath(temporaryName, (address) => requirePosix().unlinkat(directory, address, 0));
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

export class SecurePathScope {
	private readonly components: string[];
	private readonly anchorDepth: number;
	private readonly anchorDevice: bigint;
	private readonly anchorInode: bigint;

	constructor(root: string, childDirectories: readonly string[] = []) {
		const canonical = canonicalTrustedRoot(root);
		const absoluteRoot = canonical.path;
		if (!isAbsolute(absoluteRoot) || parse(absoluteRoot).root !== sep) {
			throw new SecureFsError("open_directory", undefined, new Error("Secure root must be absolute"));
		}
		const rootComponents = absoluteRoot.slice(sep.length).split(sep).filter(Boolean);
		for (const component of [...rootComponents, ...childDirectories]) assertComponent(component);
		this.components = [...rootComponents, ...childDirectories];
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
			if (requirePosix().flock(directory, LOCK_EX) < 0) fail("lock_file");
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
			if (requirePosix().flock(descriptor, LOCK_EX) < 0) fail("lock_file");
			locked = true;
			if (requirePosix().flock(directory, LOCK_UN) < 0) fail("lock_file");
			directoryLocked = false;
			testHook?.({ stage: "lock_acquired" });
			const result = operation({
				read: () => readAll(descriptor as number),
				append: (content) => {
					if (Number(requirePosix().lseek(descriptor as number, 0, SEEK_END)) < 0) fail("write_file");
					writeAll(descriptor as number, content);
					if (requirePosix().fsync(descriptor as number) < 0) fail("sync_file");
				},
			});
			if (options.createFile && requirePosix().fsync(directory) < 0) fail("sync_file");
			return result;
		} finally {
			if (directoryLocked) requirePosix().flock(directory, LOCK_UN);
			if (descriptor !== undefined) {
				if (locked) requirePosix().flock(descriptor, LOCK_UN);
				closeQuietly(descriptor);
			}
			closeQuietly(directory);
		}
	}

	readFile(name: string): Buffer | undefined {
		return this.withLockedFile(name, { createDirectory: false, createFile: false }, (file) => file.read());
	}

	appendIdempotent(name: string, eventId: string, content: Buffer): void {
		assertComponent(name);
		const directory = this.openDirectory(true);
		if (directory === undefined) fail("open_directory");
		testHook?.({ stage: "directory_opened" });
		const claimDirectoryName = `.${name}.claims`;
		const claimName = `${createHash("sha256").update(eventId).digest("hex")}.claim`;
		let claimDirectory: number | undefined;
		let logDescriptor: number | undefined;
		let directoryLocked = false;
		let logLocked = false;
		try {
			if (requirePosix().flock(directory, LOCK_EX) < 0) fail("lock_file");
			directoryLocked = true;
			claimDirectory = this.openChildDirectory(directory, claimDirectoryName, true);
			if (claimDirectory === undefined) fail("open_directory");
			if (requirePosix().fsync(directory) < 0) fail("sync_file");

			const claimCreated = createExclusiveAt(claimDirectory, claimName, Buffer.from("pending\n"));
			if (claimCreated) {
				if (requirePosix().fsync(claimDirectory) < 0) fail("sync_file");
				testHook?.({ stage: "claim_created" });
			} else {
				const claimDescriptor = openAt(claimDirectory, claimName, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					if (readAll(claimDescriptor).toString("utf8") === "done\n") return;
				} finally {
					closeQuietly(claimDescriptor);
				}
			}

			logDescriptor = openOrCreateAt(directory, name);
			if (requirePosix().fsync(directory) < 0) fail("sync_file");
			if (requirePosix().flock(logDescriptor, LOCK_EX) < 0) fail("lock_file");
			logLocked = true;
			if (requirePosix().flock(directory, LOCK_UN) < 0) fail("lock_file");
			directoryLocked = false;
			testHook?.({ stage: "lock_acquired" });

			if (!claimCreated) {
				const currentClaim = openAt(claimDirectory, claimName, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					if (readAll(currentClaim).toString("utf8") === "done\n") return;
				} finally {
					closeQuietly(currentClaim);
				}
			}

			if (claimCreated || !fileContainsEventId(logDescriptor, eventId)) {
				if (Number(requirePosix().lseek(logDescriptor, 0, SEEK_END)) < 0) fail("write_file");
				writeAll(logDescriptor, content);
				if (requirePosix().fsync(logDescriptor) < 0) fail("sync_file");
				testHook?.({ stage: "event_appended" });
			}
			atomicReplaceAt(claimDirectory, claimName, Buffer.from("done\n"));
		} finally {
			if (directoryLocked) requirePosix().flock(directory, LOCK_UN);
			if (logDescriptor !== undefined) {
				if (logLocked) requirePosix().flock(logDescriptor, LOCK_UN);
				closeQuietly(logDescriptor);
			}
			if (claimDirectory !== undefined) closeQuietly(claimDirectory);
			closeQuietly(directory);
		}
	}

	atomicWrite(name: string, content: Buffer): void {
		assertComponent(name);
		const directory = this.openDirectory(true);
		if (directory === undefined) fail("open_directory");
		testHook?.({ stage: "directory_opened" });
		try {
			atomicReplaceAt(directory, name, content);
		} finally {
			closeQuietly(directory);
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
			if (requirePosix().fsync(parent) < 0) fail("sync_file");
		} finally {
			if (child !== undefined) closeQuietly(child);
			closeQuietly(parent);
		}
	}

	private openDirectory(create: boolean): number | undefined {
		const api = requirePosix();
		const rootPath = cString(sep);
		let current = api.open(ptr(rootPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0);
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

		const result = invokePath(name, (address) => requirePosix().mkdirat(parent, address, 0o700));
		if (result < 0 && errno() !== osConstants.errno.EEXIST) fail("open_directory");
		return openAt(parent, name, flags);
	}
}

export function secureFileName(path: string): string {
	const name = basename(resolve(path));
	assertComponent(name);
	return name;
}
