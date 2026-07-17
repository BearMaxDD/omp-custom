import { createHash } from "node:crypto";

export interface RecoveryTruncatedTailEvent {
	eventId: string;
	type: "recovery_truncated_tail";
	timestamp: string;
	truncatedBytes: number;
}

const RECOVERY_FIELDS = ["eventId", "timestamp", "truncatedBytes", "type"] as const;

export function deterministicEvidenceEventId(identity: string): string {
	return evidenceUuidFromDigest(createHash("sha256").update(identity).digest());
}

function evidenceUuidFromDigest(digest: Buffer): string {
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRecoveryTruncatedTailEvent(
	originalContent: Buffer,
	truncatedTail: Buffer,
	timestamp = new Date().toISOString(),
): RecoveryTruncatedTailEvent {
	return {
		eventId: evidenceUuidFromDigest(
			createHash("sha256").update("recovery_truncated_tail\0").update(originalContent).digest(),
		),
		type: "recovery_truncated_tail",
		timestamp,
		truncatedBytes: truncatedTail.byteLength,
	};
}

export function isRecoveryTruncatedTailFor(
	value: unknown,
	originalContent: Buffer,
	truncatedTail: Buffer,
): value is RecoveryTruncatedTailEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const fields = Object.keys(record).sort();
	if (fields.length !== RECOVERY_FIELDS.length || fields.some((field, index) => field !== RECOVERY_FIELDS[index])) {
		return false;
	}
	if (record.type !== "recovery_truncated_tail") return false;
	if (typeof record.timestamp !== "string") return false;
	const timestamp = Date.parse(record.timestamp);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.timestamp) return false;
	const expected = createRecoveryTruncatedTailEvent(originalContent, truncatedTail, record.timestamp);
	return record.eventId === expected.eventId && record.truncatedBytes === expected.truncatedBytes;
}
