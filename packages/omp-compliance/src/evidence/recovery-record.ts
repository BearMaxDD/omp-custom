import { type Hash, createHash } from "node:crypto";

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

export function createRecoveryTruncatedTailHasher(): Hash {
	return createHash("sha256").update("recovery_truncated_tail\0");
}

export function recoveryTruncatedTailDigest(originalContent: Buffer): Buffer {
	return createRecoveryTruncatedTailHasher().update(originalContent).digest();
}

export function createRecoveryTruncatedTailEvent(
	originalContent: Buffer,
	truncatedTail: Buffer,
	timestamp = new Date().toISOString(),
): RecoveryTruncatedTailEvent {
	return createRecoveryTruncatedTailEventFromDigest(
		recoveryTruncatedTailDigest(originalContent),
		truncatedTail.byteLength,
		timestamp,
	);
}

export function createRecoveryTruncatedTailEventFromDigest(
	originalDigest: Buffer,
	truncatedBytes: number,
	timestamp = new Date().toISOString(),
): RecoveryTruncatedTailEvent {
	if (originalDigest.byteLength !== 32) throw new TypeError("Recovery digest must be a SHA-256 digest");
	if (!Number.isSafeInteger(truncatedBytes) || truncatedBytes < 0) {
		throw new TypeError("Recovery truncatedBytes must be a non-negative safe integer");
	}
	return {
		eventId: evidenceUuidFromDigest(originalDigest),
		type: "recovery_truncated_tail",
		timestamp,
		truncatedBytes,
	};
}

export function isRecoveryTruncatedTailFor(
	value: unknown,
	originalContent: Buffer,
	truncatedTail: Buffer,
): value is RecoveryTruncatedTailEvent {
	return isRecoveryTruncatedTailForDigest(
		value,
		recoveryTruncatedTailDigest(originalContent),
		truncatedTail.byteLength,
	);
}

export function isRecoveryTruncatedTailForDigest(
	value: unknown,
	originalDigest: Buffer,
	truncatedBytes: number,
): value is RecoveryTruncatedTailEvent {
	if (originalDigest.byteLength !== 32) return false;
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
	return record.eventId === evidenceUuidFromDigest(originalDigest) && record.truncatedBytes === truncatedBytes;
}
