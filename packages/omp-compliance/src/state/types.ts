/**
 * Core type definitions for the TDD Compliance Task State Machine.
 *
 * Defines the finite state machine states, events, and the full
 * TaskState shape used across evidence and compliance flows.
 */

import type { SHA256Hash } from "../contract/types";

/**
 * Valid status values for a compliance task.
 *
 * inactive                  — task created, not yet started
 * active                    — agent is actively working
 * completion_requested      — agent signals completion
 * advisor_reviewing         — advisor is reviewing results
 * completed                 — passed review, terminal
 * remediation_required      — advisor found issues
 * stalled                   — repeated identical remediation with no progress
 */
export type TaskStatus =
	| "inactive"
	| "active"
	| "completion_requested"
	| "advisor_reviewing"
	| "completed"
	| "remediation_required"
	| "stalled"
	| "overridden";

/**
 * A compliance verdict issued by the advisor.
 */
export interface ComplianceVerdict {
	status: "pass" | "remediation_required";
	summary?: string;
	requiredFixes?: string[];
	schemaValid: boolean;
}

/**
 * Full persisted state for a compliance task.
 */
export interface TaskState {
	taskId: string;
	projectId: string;
	status: TaskStatus;
	attempt: number;
	contractHash: SHA256Hash;
	evidenceRevision: string;
	gitHead: string;
	diffHash: string;
	activeReviewId?: string;
	tddPath: string;
	worktreeFingerprint: string;
	createdAt: string;
	updatedAt: string;
	lastVerdict?: ComplianceVerdict;
	error?: string;
	/** Consecutive remediations with the same fingerprint (for stalled detection). */
	consecutiveStalledFingerprints: number;
	/** The last remediation fingerprint, compared on each remediation event. */
	lastRemediationFingerprint?: string;
}

/**
 * A typed event that triggers a state transition.
 */
export type TaskEvent =
	| { type: "activity"; worktreeFingerprint: string }
	| {
			type: "completion_requested";
			reviewId?: string;
			evidenceRevision?: string;
			gitHead?: string;
			diffHash?: string;
	  }
	| { type: "advisor_accepted"; reviewId: string }
	| { type: "review_failed"; reviewId: string; reason: string }
	| { type: "retry"; reviewId: string }
	| { type: "override"; reason: string; actor: "user" }
	| { type: "advisor_silent" }
	| { type: "verdict"; status: "pass"; summary?: string; schemaValid?: boolean }
	| {
			type: "verdict";
			status: "remediation_required";
			summary?: string;
			requiredFixes: string[];
			schemaValid?: boolean;
	  }
	| { type: "remediation"; fingerprint: string }
	| { type: "protocol_error"; error: string };
