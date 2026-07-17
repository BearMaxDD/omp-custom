import { createHash } from "node:crypto";
import { EvidenceRepository } from "./evidence-repository";

export interface EvidenceRecord {
	schemaVersion: number;
	timestamp: string;
	taskId: string;
	contractPath: string;
	contractHash: string;
	attempt: number;
	event: string;
	signalDigest: string;
	eventId?: string;
	verdictSummary?: string;
	worktreeFingerprint?: string;
	outputTruncated?: string;
	commandTruncated?: string;
}

function eventIdFor(record: EvidenceRecord): string {
	if (record.eventId) {
		return record.eventId;
	}
	const identity = JSON.stringify([
		record.schemaVersion,
		record.timestamp,
		record.taskId,
		record.contractPath,
		record.contractHash,
		record.attempt,
		record.event,
		record.signalDigest,
		record.verdictSummary ?? null,
		record.worktreeFingerprint ?? null,
		record.outputTruncated ?? null,
		record.commandTruncated ?? null,
	]);
	return `evidence:${createHash("sha256").update(identity).digest("hex")}`;
}

/**
 * Compatibility adapter for callers that still use the original EvidenceStore API.
 * New persistence is delegated to EvidenceRepository and never falls back to memory.
 */
export class EvidenceStore {
	private readonly repository: EvidenceRepository;

	constructor(basePath: string) {
		this.repository = new EvidenceRepository(basePath);
	}

	pendingCount(_taskId?: string): number {
		return 0;
	}

	getPending(): EvidenceRecord[] {
		return [];
	}

	adoptPending(_other: EvidenceStore): void {}

	async append(record: EvidenceRecord): Promise<void> {
		const eventId = eventIdFor(record);
		this.repository.task(record.taskId).events.append({ ...record, eventId });
	}

	async flushPending(): Promise<void> {}

	async readAll(taskId: string): Promise<EvidenceRecord[]> {
		return this.repository.task(taskId).events.readAll() as unknown as EvidenceRecord[];
	}
}
