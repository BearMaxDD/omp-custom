import { createHash } from "node:crypto";
import { SecurePathScope, type SecureRecoveryRecord, secureFileName } from "./secure-fs";

export interface EvidenceEvent {
	eventId: string;
	type?: string;
	[key: string]: unknown;
}

export interface EvidenceRecoveryEvent extends EvidenceEvent {
	type: "recovery_truncated_tail";
	timestamp: string;
	truncatedBytes: number;
}

export type EvidencePersistenceOperation =
	| "append_event"
	| "validate_event_id"
	| "read_event_log"
	| "recover_event_log"
	| "read_snapshot"
	| "parse_snapshot"
	| "write_snapshot"
	| "recover_snapshot"
	| "recover_repository"
	| "validate_evidence_path"
	| "ensure_artifact_directory";

export class EvidencePersistenceError extends Error {
	readonly operation: EvidencePersistenceOperation;
	readonly path: string;
	declare readonly cause: unknown;

	constructor(operation: EvidencePersistenceOperation, path: string, cause: unknown) {
		super(`Evidence persistence operation failed: ${operation}`, { cause });
		this.name = "EvidencePersistenceError";
		this.operation = operation;
		this.path = path;
		this.cause = cause;
	}
}

export function deterministicEvidenceEventId(identity: string): string {
	const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isEvidenceEventId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[457][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function recoveryEventFor(content: string, truncatedTail: string): EvidenceRecoveryEvent {
	return {
		eventId: deterministicEvidenceEventId(`recovery_truncated_tail\0${content}`),
		type: "recovery_truncated_tail",
		timestamp: new Date().toISOString(),
		truncatedBytes: Buffer.byteLength(truncatedTail),
	};
}

function recoveryRecordFor(content: string, truncatedTail: string): SecureRecoveryRecord {
	const recovery = recoveryEventFor(content, truncatedTail);
	return { eventId: recovery.eventId, content: Buffer.from(`${JSON.stringify(recovery)}\n`) };
}

function legacyEventIdFor(line: string): string {
	return deterministicEvidenceEventId(`legacy_event\0${line}`);
}

interface ParsedEvents<T> {
	events: T[];
	seen: Set<string>;
	truncatedTail?: string;
}

function parseEvents<T extends EvidenceEvent>(content: string): ParsedEvents<T> {
	const events: T[] = [];
	const seen = new Set<string>();
	let truncatedTail: string | undefined;
	const lines = content.split("\n");
	const finalLineIndex = lines.length - 1;

	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Partial<T>;
			const eventId =
				typeof event.eventId === "string" && isEvidenceEventId(event.eventId) ? event.eventId : legacyEventIdFor(line);
			if (seen.has(eventId)) continue;
			seen.add(eventId);
			events.push({ ...event, eventId } as T);
		} catch {
			if (index === finalLineIndex && !content.endsWith("\n")) truncatedTail = line;
		}
	}

	return { events, seen, truncatedTail };
}

export class EventLog<T extends EvidenceEvent = EvidenceEvent> {
	private readonly scope: SecurePathScope;
	private readonly fileName: string;

	constructor(
		readonly path: string,
		scope?: SecurePathScope,
	) {
		this.scope = scope ?? SecurePathScope.forFile(path);
		this.fileName = secureFileName(path);
	}

	append(event: T): void {
		if (!isEvidenceEventId(event.eventId)) {
			throw new EvidencePersistenceError(
				"validate_event_id",
				this.path,
				new Error("Evidence eventId must be an RFC UUID v4, v5, or v7"),
			);
		}
		try {
			this.scope.appendIdempotent(
				this.fileName,
				event.eventId,
				Buffer.from(`${JSON.stringify(event)}\n`),
				recoveryRecordFor,
			);
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("append_event", this.path, error);
		}
	}

	readAll(): T[] {
		try {
			const result = this.scope.withLockedFile(this.fileName, { createDirectory: false, createFile: false }, (file) => {
				const content = file.read().toString("utf8");
				return { content, parsed: parseEvents<T>(content) };
			});
			if (result === undefined) return [];
			if (result.parsed.truncatedTail === undefined) return result.parsed.events;

			const recovery = recoveryEventFor(result.content, result.parsed.truncatedTail);
			if (!result.parsed.seen.has(recovery.eventId)) {
				const prefix = result.content.endsWith("\n") ? "" : "\n";
				const recoveryRecord = {
					eventId: recovery.eventId,
					content: Buffer.from(`${JSON.stringify(recovery)}\n`),
				};
				this.scope.appendIdempotent(
					this.fileName,
					recovery.eventId,
					Buffer.from(`${prefix}${JSON.stringify(recovery)}\n`),
					() => recoveryRecord,
				);
				result.parsed.events.push(recovery as unknown as T);
			}
			return result.parsed.events;
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("read_event_log", this.path, error);
		}
	}
}
