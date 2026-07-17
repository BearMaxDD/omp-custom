import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { EvidencePersistenceError } from "./event-log";

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function flushDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

export class SnapshotStore {
	constructor(readonly path: string) {}

	read<T = unknown>(): T | undefined {
		let content: string;
		try {
			content = readFileSync(this.path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) {
				return undefined;
			}
			throw new EvidencePersistenceError("read_snapshot", this.path, error);
		}

		try {
			return JSON.parse(content) as T;
		} catch (error) {
			throw new EvidencePersistenceError("parse_snapshot", this.path, error);
		}
	}

	write(value: unknown): void {
		const parent = dirname(this.path);
		const temporaryPath = join(parent, `.${basename(this.path)}.${randomUUID()}.tmp`);
		let descriptor: number | undefined;

		try {
			mkdirSync(parent, { recursive: true });
			descriptor = openSync(temporaryPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporaryPath, this.path);
			flushDirectory(parent);
		} catch (error) {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// The original persistence failure remains authoritative.
				}
			}
			try {
				unlinkSync(temporaryPath);
			} catch {
				// The temp may not exist or may already have been renamed.
			}
			throw new EvidencePersistenceError("write_snapshot", this.path, error);
		}
	}
}
