/**
 * History Reader — reads and formats evidence JSONL records for display.
 *
 * Returns a chronological event list with large outputs omitted (beyond
 * redaction) to keep the display useful without overwhelming it.
 */

import type { EvidenceRecord, EvidenceStore } from "../evidence/evidence-store";
import { redact } from "../evidence/redaction";

// ─── Types ─────────────────────────────────────────────────────────

export interface HistoryEvent {
	/** ISO timestamp of the event. */
	timestamp: string;
	/** Event type (e.g. "active", "stopped", "completed"). */
	event: string;
	/** Human-readable summary of the event. */
	summary: string;
	/** Attempt number at the time of the event. */
	attempt: number;
	/** Verdect summary, if present. */
	verdictSummary?: string;
	/** Worktree fingerprint at the time, short (first 12 chars). */
	worktreeFingerprintShort?: string;
}

// ─── Reader ────────────────────────────────────────────────────────

/**
 * Read all evidence records for a task and return display-friendly events.
 *
 * Records are sorted chronologically by timestamp. Large raw outputs
 * (signalDigest, outputTruncated, commandTruncated) beyond the event
 * metadata are omitted from the summary to avoid flooding the display.
 */
export async function readHistory(
	store: EvidenceStore,
	taskId: string,
): Promise<HistoryEvent[]> {
	const records = await store.readAll(taskId);

	const events: HistoryEvent[] = [];

	for (const record of records) {
		const summary = buildSummary(record);
		const wf = record.worktreeFingerprint;
		const wfShort = wf && wf.length >= 12 ? wf.slice(0, 12) : wf;

		events.push({
			timestamp: record.timestamp,
			event: record.event,
			summary,
			attempt: record.attempt,
			verdictSummary: record.verdictSummary ? redact(record.verdictSummary) : undefined,
			worktreeFingerprintShort: wfShort,
		});
	}

	// Sort chronologically — stable sort, timestamps are ISO strings
	events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	return events;
}

// ─── Private helpers ───────────────────────────────────────────────

/** Build a human-readable summary for an evidence record. */
function buildSummary(record: EvidenceRecord): string {
	const parts: string[] = [];

	switch (record.event) {
		case "active":
			parts.push("Task started");
			break;
		case "stopped":
			parts.push("Task stopped by user");
			break;
		case "resumed":
			parts.push("Task resumed");
			break;
		case "completion_requested":
			parts.push("Completion requested");
			break;
		case "completed":
			parts.push("Task completed");
			break;
		case "remediation_required":
			parts.push("Remediation required");
			break;
		default:
			parts.push(`Event: ${record.event}`);
	}

	if (record.verdictSummary) {
		const redactedSummary = redact(record.verdictSummary);
		parts.push(`— ${redactedSummary}`);
	}

	if (record.signalDigest && record.signalDigest.length > 0) {
		const redactedDigest = redact(record.signalDigest);
		parts.push(`(digest: ${redactedDigest.length > 60 ? `${redactedDigest.slice(0, 60)}…` : redactedDigest})`);
	}

	return parts.join(" ");
}
