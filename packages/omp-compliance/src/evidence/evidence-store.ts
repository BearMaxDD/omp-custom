import { deterministicEvidenceEventId } from "./event-log";
import { EvidenceRepository } from "./evidence-repository";

export interface ComplianceOverride {
	readonly overrideId: string;
	readonly taskId: string;
	readonly taskRunId: string;
	readonly projectId: string;
	readonly operator: "user";
	readonly reason: string;
	readonly gitHead: string;
	readonly diffHash: string;
	readonly contractHash: string;
	readonly evidenceRevision: string;
	readonly missingChecks: readonly string[];
	readonly stalledReason: string;
	readonly attempt: number;
	readonly createdAt: string;
}

type StoredComplianceOverride = ComplianceOverride & {
	readonly eventId: string;
	readonly type: "compliance_override";
	readonly event: "overridden";
};

const OVERRIDE_KEYS = new Set([
	"overrideId",
	"taskId",
	"taskRunId",
	"projectId",
	"operator",
	"reason",
	"gitHead",
	"diffHash",
	"contractHash",
	"evidenceRevision",
	"missingChecks",
	"stalledReason",
	"attempt",
	"createdAt",
	"eventId",
	"type",
	"event",
]);

function boundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validStoredOverride(value: unknown): value is StoredComplianceOverride {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== OVERRIDE_KEYS.size || Object.keys(record).some((key) => !OVERRIDE_KEYS.has(key))) {
		return false;
	}
	return (
		typeof record.overrideId === "string" &&
		/^override:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.overrideId) &&
		boundedString(record.taskId, 128) &&
		typeof record.taskRunId === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.taskRunId) &&
		boundedString(record.projectId, 256) &&
		record.operator === "user" &&
		boundedString(record.reason, 2_048) &&
		typeof record.gitHead === "string" &&
		/^[0-9a-f]{40}$/.test(record.gitHead) &&
		typeof record.diffHash === "string" &&
		/^sha256:[0-9a-f]{64}$/.test(record.diffHash) &&
		typeof record.contractHash === "string" &&
		/^sha256:[0-9a-f]{64}$/.test(record.contractHash) &&
		typeof record.evidenceRevision === "string" &&
		/^sha256:[0-9a-f]{64}$/.test(record.evidenceRevision) &&
		Array.isArray(record.missingChecks) &&
		record.missingChecks.length <= 64 &&
		record.missingChecks.every((check) => boundedString(check, 128)) &&
		typeof record.stalledReason === "string" &&
		record.stalledReason.length <= 4_096 &&
		Number.isSafeInteger(record.attempt) &&
		Number(record.attempt) >= 1 &&
		typeof record.createdAt === "string" &&
		!Number.isNaN(Date.parse(record.createdAt)) &&
		new Date(record.createdAt).toISOString() === record.createdAt &&
		typeof record.eventId === "string" &&
		record.type === "compliance_override" &&
		record.event === "overridden"
	);
}

function overrideRecordWithoutMetadata(record: StoredComplianceOverride): ComplianceOverride {
	const { eventId: _eventId, type: _type, event: _event, ...override } = record;
	return override;
}

function assertOverrideIntegrity(value: unknown): StoredComplianceOverride {
	if (!validStoredOverride(value)) throw new Error("Invalid compliance override audit integrity");
	const override = overrideRecordWithoutMetadata(value);
	const expected = deterministicEvidenceEventId(`compliance_override\0${JSON.stringify(override)}`);
	if (value.eventId !== expected) throw new Error("Invalid compliance override audit integrity");
	return value;
}

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
	return deterministicEvidenceEventId(`evidence_store\0${identity}`);
}

/**
 * Compatibility adapter for callers that still use the original EvidenceStore API.
 * New persistence is delegated to EvidenceRepository and never falls back to memory.
 */
export class EvidenceStore {
	private readonly repository: EvidenceRepository;

	constructor(basePath: string, trustedRoot?: string) {
		this.repository = new EvidenceRepository(basePath, trustedRoot);
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

	async appendOverride(record: ComplianceOverride): Promise<void> {
		const eventId = deterministicEvidenceEventId(`compliance_override\0${JSON.stringify(record)}`);
		this.repository.overrides.append({
			...record,
			eventId,
			type: "compliance_override",
			event: "overridden",
		} satisfies StoredComplianceOverride);
	}

	async readOverrides(taskId?: string): Promise<ComplianceOverride[]> {
		const records = this.repository.overrides.readAll().map(assertOverrideIntegrity);
		return records
			.filter((record) => record.type === "compliance_override" && (taskId === undefined || record.taskId === taskId))
			.map(overrideRecordWithoutMetadata);
	}
}
