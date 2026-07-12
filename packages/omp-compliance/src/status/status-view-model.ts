/**
 * Status View Model — read-only projection of task state + evidence snapshot.
 *
 * Produces a typed, human-readable view for the `/compliance status` command.
 * NEVER mutates task state or triggers side effects.
 */

import type { ComplianceVerdict, TaskState, TaskStatus } from "../state/types";
import type { EvidenceSnapshot } from "../signals/types";

// ─── Types ─────────────────────────────────────────────────────────

export type EvidenceGap = "missing" | "partial" | "present";

export interface EvidenceGaps {
	/** Codebase-memory search coverage. */
	codebaseMemory: EvidenceGap;
	/** Subagent task delegation coverage. */
	taskDelegation: EvidenceGap;
}

export interface StatusViewModel {
	tddPath: string;
	contractHashShort: string;
	status: TaskStatus;
	attempt: number;
	advisor: { available: boolean };
	lastVerdict?: ComplianceVerdict;
	requiredFixes: string[];
	verificationSummary?: string;
	evidence: EvidenceGaps;
}

// ─── Projection ────────────────────────────────────────────────────

/**
 * Build a read-only status view from the current task state and optional
 * evidence snapshot.
 *
 * @param state  — current task state (required; null = no task started)
 * @param snapshot — optional evidence snapshot for gap detection
 */
export function toStatusViewModel(
	state: TaskState,
	snapshot?: EvidenceSnapshot,
): StatusViewModel {
	const hashShort = state.contractHash.length >= 8
		? state.contractHash.slice(0, 8)
		: state.contractHash;

	const advisorAvailable = state.status !== "completed";

	const requiredFixes = state.lastVerdict?.requiredFixes ?? [];

	return {
		tddPath: state.tddPath,
		contractHashShort: hashShort,
		status: state.status,
		attempt: state.attempt,
		advisor: { available: advisorAvailable },
		lastVerdict: state.lastVerdict,
		requiredFixes,
		verificationSummary: buildVerificationSummary(snapshot),
		evidence: classifyEvidenceGaps(snapshot),
	};
}

// ─── Private helpers ───────────────────────────────────────────────

function buildVerificationSummary(snapshot?: EvidenceSnapshot): string | undefined {
	if (!snapshot || snapshot.verifications.length === 0) {
		return undefined;
	}

	const total = snapshot.verifications.length;
	const passed = snapshot.verifications.filter((v) => v.passed).length;
	return `${passed}/${total} verifications passed`;
}

function classifyEvidenceGaps(snapshot?: EvidenceSnapshot): EvidenceGaps {
	if (!snapshot) {
		return { codebaseMemory: "missing", taskDelegation: "missing" };
	}

	const cm = snapshot.codebaseMemory;

	let codebaseMemory: EvidenceGap;
	if (cm.queries.length === 0 && cm.references.length === 0) {
		codebaseMemory = "missing";
	} else if (!cm.indexReady) {
		codebaseMemory = "partial";
	} else {
		codebaseMemory = "present";
	}

	const delegations = snapshot.subagentDelegations;

	let taskDelegation: EvidenceGap;
	if (delegations.length === 0) {
		taskDelegation = "missing";
	} else if (delegations.some((d) => d.status !== "completed")) {
		taskDelegation = "partial";
	} else {
		taskDelegation = "present";
	}

	return { codebaseMemory, taskDelegation };
}
