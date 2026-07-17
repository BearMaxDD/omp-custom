import { basename, dirname, join } from "node:path";
import {
	type RecoveryTruncatedTailEvent,
	createRecoveryTruncatedTailEvent,
	deterministicEvidenceEventId,
	isRecoveryTruncatedTailFor,
} from "./recovery-record";
import {
	ClaimJournalCorruptionError,
	EvidenceLogCorruptionError,
	SecureFsError,
	SecurePathScope,
	type SecureRecoveryRecord,
	secureFileName,
} from "./secure-fs";

export interface EvidenceEvent {
	eventId: string;
	type?: string;
	[key: string]: unknown;
}

export type EvidenceRecoveryEvent = RecoveryTruncatedTailEvent;

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

export { deterministicEvidenceEventId } from "./recovery-record";

export function isEvidenceEventId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[457][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function recoveryEventFor(content: string, truncatedTail: string): EvidenceRecoveryEvent {
	return createRecoveryTruncatedTailEvent(content, truncatedTail);
}

function recoveryRecordFor(content: string, truncatedTail: string): SecureRecoveryRecord {
	const recovery = recoveryEventFor(content, truncatedTail);
	return { eventId: recovery.eventId, content: Buffer.from(`${JSON.stringify(recovery)}\n`) };
}

function legacyEventIdFor(line: string): string {
	return deterministicEvidenceEventId(`legacy_event\0${line}`);
}

function persistenceFailure(error: unknown, fallback: string): { path: string; cause: unknown } {
	if (!(error instanceof SecureFsError) || !(error.cause instanceof ClaimJournalCorruptionError)) {
		return { path: fallback, cause: error };
	}
	const journalPath = join(dirname(fallback), basename(error.cause.path));
	const diagnostic = new ClaimJournalCorruptionError(
		journalPath,
		error.cause.line,
		error.cause.offset,
		error.cause.reason,
		error.cause.cause,
	);
	return {
		path: journalPath,
		cause: new SecureFsError(error.operation, error.code, diagnostic),
	};
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
	const contentBuffer = Buffer.from(content);
	const lines = content.split("\n");
	const finalLineIndex = lines.length - 1;
	let offset = 0;

	for (const [index, line] of lines.entries()) {
		const lineOffset = offset;
		offset += Buffer.byteLength(line) + (index < finalLineIndex ? 1 : 0);
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Partial<T>;
			const eventId =
				typeof event.eventId === "string" && isEvidenceEventId(event.eventId) ? event.eventId : legacyEventIdFor(line);
			if (seen.has(eventId)) continue;
			seen.add(eventId);
			events.push({ ...event, eventId } as T);
		} catch (error) {
			if (index === finalLineIndex && !content.endsWith("\n")) {
				truncatedTail = line;
				continue;
			}
			let isAuditedTruncatedTail = false;
			const next = lines[index + 1];
			if (next !== undefined) {
				try {
					isAuditedTruncatedTail = isRecoveryTruncatedTailFor(
						JSON.parse(next),
						contentBuffer.subarray(0, lineOffset + Buffer.byteLength(line)),
						Buffer.from(line),
					);
				} catch {
					isAuditedTruncatedTail = false;
				}
			}
			if (!isAuditedTruncatedTail) {
				throw new SecureFsError(
					"read_file",
					undefined,
					new EvidenceLogCorruptionError(index + 1, lineOffset, "malformed_json", error),
				);
			}
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
			const failure = persistenceFailure(error, this.path);
			throw new EvidencePersistenceError("append_event", failure.path, failure.cause);
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
				return this.readAll();
			}
			return result.parsed.events;
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			const failure = persistenceFailure(error, this.path);
			throw new EvidencePersistenceError("read_event_log", failure.path, failure.cause);
		}
	}
}
