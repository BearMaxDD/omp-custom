/**
 * Completion Gate — builds structured completion snapshots.
 *
 * The completion snapshot is a read-only facts-only report that captures
 * the full state of a managed code task at the moment of completion
 * request. It records what happened (signals), what was claimed (agent),
 * what remediation is pending, and what policy-required evidence was
 * produced.
 *
 * IMPORTANT: This module ONLY assembles facts. It NEVER produces a
 * pass/remediate verdict — that is the Advisor's exclusive role.
 */

import type { ComplianceContract, ContractSummary, SHA256Hash } from "../contract/types";
import type { EvidenceSnapshot } from "../signals/types";
import type { ComplianceVerdict, TaskState } from "../state/types";

// ─── Completion Snapshot Types ──────────────────────────────────────

/** Policy-required evidence fact: was the thing done? */
export type EvidenceFact = "present" | "missing" | "partial";

/** Facts about mandatory compliance evidence. */
export interface EvidenceFacts {
	codebaseMemoryUsed: EvidenceFact;
	taskDelegationUsed: EvidenceFact;
	verificationRun: EvidenceFact;
}

/** Remediation item in the snapshot. */
export interface RemediationItem {
	id: string;
	requiredFix: string;
}

/** Agent's completion claim. */
export interface AgentClaim {
	summary: string;
	claimedVerification?: string[];
}

/** Contract info embedded in the snapshot. */
export interface ContractInfo {
	hash: SHA256Hash;
	tddPath: string;
	summary: ContractSummary;
}

/**
 * Composite completion snapshot — an immutable facts-only record.
 *
 * Fields:
 *  - taskId, timestamp, attempt — identity and version
 *  - contract — loaded compliance contract
 *  - codebaseMemory, verifications, delegations — signal evidence
 *  - diffFingerprint — worktree state digest
 *  - agentClaim — what the agent says it did
 *  - remediation — open/closed fix items
 *  - evidenceFacts — policy-required evidence summary
 */
export interface CompletionSnapshot {
	taskId: string;
	timestamp: string;
	attempt: number;
	contract: ContractInfo;
	codebaseMemory: {
		indexReady: boolean;
		queries: string[];
		references: string[];
	};
	verifications: Array<{
		command: string;
		exitCode: number;
		passed: boolean;
	}>;
	delegations: Array<{
		agentId?: string;
		taskSummary?: string;
	}>;
	diffFingerprint: string;
	agentClaim: AgentClaim;
	remediation: {
		open: RemediationItem[];
		closed: RemediationItem[];
	};
	evidenceFacts: EvidenceFacts;
}

// ─── Snapshot Builder ───────────────────────────────────────────────

/**
 * Build a completion snapshot from the current task state.
 *
 * @param taskState  — current managed task state
 * @param contract   — loaded compliance contract
 * @param signals    — evidence snapshot from the signal collector
 * @param fingerprint — worktree composite fingerprint
 * @param agentClaim — what the agent claims (summary + optional verifications)
 * @returns a read-only CompletionSnapshot (never a verdict)
 */
export function buildCompletionSnapshot(
	taskState: TaskState,
	contract: ComplianceContract,
	signals: EvidenceSnapshot,
	fingerprint: string,
	agentClaim: AgentClaim,
): CompletionSnapshot {
	const evidenceFacts = computeEvidenceFacts(signals);

	const openRemediation: RemediationItem[] = [];
	if (
		taskState.status === "remediation_required" &&
		taskState.lastVerdict?.requiredFixes
	) {
		taskState.lastVerdict.requiredFixes.forEach((fix, i) => {
			openRemediation.push({ id: `fix-${i + 1}`, requiredFix: fix });
		});
	}

	const snapshot: CompletionSnapshot = {
		taskId: taskState.taskId,
		timestamp: new Date().toISOString(),
		attempt: taskState.attempt,
		contract: {
			hash: contract.contractHash,
			tddPath: contract.tddPath,
			summary: contract.summary,
		},
		codebaseMemory: {
			indexReady: signals.codebaseMemory.indexReady,
			queries: [...signals.codebaseMemory.queries],
			references: [...signals.codebaseMemory.references],
		},
		verifications: signals.verifications.map((v) => ({
			command: v.command,
			exitCode: v.exitCode,
			passed: v.passed,
		})),
		delegations: signals.subagentDelegations.map((d) => ({
			agentId: d.agentId,
			taskSummary: d.taskSummary,
		})),
		diffFingerprint: fingerprint,
		agentClaim: {
			summary: agentClaim.summary,
			claimedVerification: agentClaim.claimedVerification,
		},
		remediation: {
			open: openRemediation,
			closed: [],
		},
		evidenceFacts,
	};

	return snapshot;
}

// ─── Evidence Fact Computation ──────────────────────────────────────

/**
 * Compute policy-required evidence facts from the signal snapshot.
 *
 * Rules:
 *  - codebaseMemoryUsed: "present" if at least one query was made
 *  - taskDelegationUsed: "present" if at least one subagent was spawned
 *  - verificationRun: "present" if ALL verifications passed,
 *                     "partial" if any failed,
 *                     "missing" if none attempted
 */
function computeEvidenceFacts(signals: EvidenceSnapshot): EvidenceFacts {
	const codebaseMemoryUsed: EvidenceFact =
		signals.codebaseMemory.queries.length > 0 ? "present" : "missing";

	const taskDelegationUsed: EvidenceFact =
		signals.subagentDelegations.length > 0 ? "present" : "missing";

	let verificationRun: EvidenceFact = "missing";
	if (signals.verifications.length > 0) {
		const allPassed = signals.verifications.every((v) => v.passed);
		verificationRun = allPassed ? "present" : "partial";
	}

	return {
		codebaseMemoryUsed,
		taskDelegationUsed,
		verificationRun,
	};
}
