import { dirname, join } from "node:path";
import { EvidencePersistenceError } from "./event-log";
import { SecurePathScope, secureFileName } from "./secure-fs";

export class SnapshotStore {
	private readonly scope: SecurePathScope;
	private readonly fileName: string;

	constructor(
		readonly path: string,
		scope?: SecurePathScope,
	) {
		this.scope = scope ?? SecurePathScope.forFile(path);
		this.fileName = secureFileName(path);
	}

	read<T = unknown>(): T | undefined {
		let content: Buffer | undefined;
		try {
			content = this.scope.readFile(this.fileName);
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("read_snapshot", this.path, error);
		}
		if (content === undefined) return undefined;

		try {
			return JSON.parse(content.toString("utf8")) as T;
		} catch (error) {
			throw new EvidencePersistenceError("parse_snapshot", this.path, error);
		}
	}

	write(value: unknown): void {
		try {
			this.scope.atomicWrite(this.fileName, Buffer.from(`${JSON.stringify(value)}\n`));
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("write_snapshot", this.path, error);
		}
	}

	recover(): string[] {
		try {
			return this.scope.removeAtomicTemps(this.fileName).map((name) => join(dirname(this.path), name));
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("recover_snapshot", this.path, error);
		}
	}
}
