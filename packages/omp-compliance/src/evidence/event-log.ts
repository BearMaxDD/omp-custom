import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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

export class EventLog<T extends EvidenceEvent = EvidenceEvent> {
	private readonly appendedEventIds = new Set<string>();

	constructor(readonly path: string) {}

	append(event: T): void {
		if (this.appendedEventIds.has(event.eventId)) {
			return;
		}

		this.appendSerialized(`${JSON.stringify(event)}\n`, "append_event");
		this.appendedEventIds.add(event.eventId);
	}

	readAll(): T[] {
		let content: string;
		try {
			content = readFileSync(this.path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) {
				return [];
			}
			throw new EvidencePersistenceError("read_event_log", this.path, error);
		}

		const events: T[] = [];
		const seen = new Set<string>();
		let truncatedTail: string | undefined;
		const lines = content.split("\n");
		const finalLineIndex = lines.length - 1;

		for (const [index, line] of lines.entries()) {
			if (!line.trim()) {
				continue;
			}
			try {
				const event = JSON.parse(line) as Partial<T>;
				const eventId = typeof event.eventId === "string" ? event.eventId : legacyEventIdFor(line);
				if (seen.has(eventId)) {
					continue;
				}
				seen.add(eventId);
				events.push({ ...event, eventId } as T);
			} catch {
				if (index === finalLineIndex && !content.endsWith("\n")) {
					truncatedTail = line;
				}
			}
		}

		if (truncatedTail !== undefined) {
			const recovery = recoveryEventFor(content, truncatedTail);
			if (!seen.has(recovery.eventId)) {
				this.appendSerialized(`\n${JSON.stringify(recovery)}\n`, "recover_event_log");
				events.push(recovery as unknown as T);
			}
		}

		for (const event of events) {
			this.appendedEventIds.add(event.eventId);
		}
		return events;
	}

	private appendSerialized(serialized: string, operation: "append_event" | "recover_event_log"): void {
		try {
			const parent = dirname(this.path);
			mkdirSync(parent, { recursive: true });
			appendFileSync(this.path, serialized, { encoding: "utf8", flush: true });
			flushDirectory(parent);
		} catch (error) {
			throw new EvidencePersistenceError(operation, this.path, error);
		}
	}
}
