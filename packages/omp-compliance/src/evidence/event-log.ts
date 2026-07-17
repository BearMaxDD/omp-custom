import { createHash } from "node:crypto";
import { SecurePathScope, secureFileName } from "./secure-fs";

export interface EvidenceEvent {
	eventId: string;
	type?: string;
	[key: string]: unknown;
}

export interface EvidenceRecoveryEvent extends EvidenceEvent {
	type: "evidence_log_recovered";
	reason: "truncated_tail";
	timestamp: string;
	truncatedBytes: number;
}

export type EvidencePersistenceOperation =
	| "append_event"
	| "read_event_log"
	| "recover_event_log"
	| "read_snapshot"
	| "parse_snapshot"
	| "write_snapshot"
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

function recoveryEventFor(content: string, truncatedTail: string): EvidenceRecoveryEvent {
	const digest = createHash("sha256").update(content).digest("hex");
	return {
		eventId: `recovery:truncated-tail:${digest}`,
		type: "evidence_log_recovered",
		reason: "truncated_tail",
		timestamp: new Date().toISOString(),
		truncatedBytes: Buffer.byteLength(truncatedTail),
	};
}

function legacyEventIdFor(line: string): string {
	return `legacy:${createHash("sha256").update(line).digest("hex")}`;
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
			const eventId = typeof event.eventId === "string" ? event.eventId : legacyEventIdFor(line);
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
		try {
			this.scope.withLockedFile(this.fileName, { createDirectory: true, createFile: true }, (file) => {
				const { seen } = parseEvents<T>(file.read().toString("utf8"));
				if (!seen.has(event.eventId)) file.append(Buffer.from(`${JSON.stringify(event)}\n`));
			});
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("append_event", this.path, error);
		}
	}

	readAll(): T[] {
		try {
			return (
				this.scope.withLockedFile(this.fileName, { createDirectory: false, createFile: false }, (file) => {
					const content = file.read().toString("utf8");
					const parsed = parseEvents<T>(content);
					if (parsed.truncatedTail === undefined) return parsed.events;

					const recovery = recoveryEventFor(content, parsed.truncatedTail);
					if (!parsed.seen.has(recovery.eventId)) {
						const prefix = content.endsWith("\n") ? "" : "\n";
						file.append(Buffer.from(`${prefix}${JSON.stringify(recovery)}\n`));
						parsed.events.push(recovery as unknown as T);
					}
					return parsed.events;
				}) ?? []
			);
		} catch (error) {
			if (error instanceof EvidencePersistenceError) throw error;
			throw new EvidencePersistenceError("read_event_log", this.path, error);
		}
	}
}
