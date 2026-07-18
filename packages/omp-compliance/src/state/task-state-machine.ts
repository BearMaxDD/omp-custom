/**
 * TDD Compliance Task State Machine.
 *
 * Implements the finite state machine for task compliance lifecycle:
 *   inactive -> active -> completion_requested -> advisor_reviewing
 *     -> completed | remediation_required -> active | stalled
 *
 * Stalled protection prevents meaningless loops — three consecutive
 * identical remediation fingerprints trigger stalled, but real progress
 * (fingerprint change) resumes to active. Stalled is NOT a quality verdict.
 *
 * Rules:
 * - completed is terminal — no further transitions permitted.
 * - No verdict, schema failure, or task/hash mismatch keeps advisor_reviewing
 *   and writes a protocol error — never completes.
 * - remediation requires at least one requiredFix.
 * - After pass, no remediate is accepted (idempotent).
 */

import type { TaskEvent, TaskState, TaskStatus } from "./types";

const STALLED_THRESHOLD = 3;

/**
 * Transition a task state in response to an event.
 *
 * Returns a new TaskState (immutable) reflecting the transition, or the
 * original state unchanged when the event is invalid in the current status.
 * Invalid events set the error field rather than throwing.
 */
export function transition(state: TaskState, event: TaskEvent): TaskState {
	if (state.status === "completed" || state.status === "overridden") {
		return state;
	}
	if (event.type === "override") {
		return update(state, { status: "overridden", error: `Overridden by ${event.actor}: ${event.reason}` });
	}

	switch (state.status) {
		case "inactive":
			return transitionInactive(state, event);
		case "active":
			return transitionActive(state, event);
		case "completion_requested":
			return transitionCompletionRequested(state, event);
		case "advisor_reviewing":
			return transitionAdvisorReviewing(state, event);
		case "remediation_required":
			return transitionRemediationRequired(state, event);
		case "stalled":
			return transitionStalled(state, event);
		default:
			return withError(state, `Unknown status: ${state.status}`);
	}
}

// ─── Per-status transition dispatchers ─────────────────────────────

function transitionInactive(state: TaskState, event: TaskEvent): TaskState {
	if (event.type === "activity") {
		return update(state, {
			status: "active",
			worktreeFingerprint: event.worktreeFingerprint,
		});
	}
	return withError(state, `Cannot handle ${event.type} from inactive`);
}

function transitionActive(state: TaskState, event: TaskEvent): TaskState {
	switch (event.type) {
		case "activity":
			return update(state, { worktreeFingerprint: event.worktreeFingerprint });
		case "completion_requested":
			if (
				typeof event.reviewId !== "string" ||
				event.reviewId.length === 0 ||
				typeof event.evidenceRevision !== "string" ||
				event.evidenceRevision.length === 0 ||
				typeof event.gitHead !== "string" ||
				event.gitHead.length === 0 ||
				typeof event.diffHash !== "string" ||
				event.diffHash.length === 0
			) {
				return withError(state, "invalid completion context");
			}
			return update(state, {
				status: "completion_requested",
				activeReviewId: event.reviewId,
				evidenceRevision: event.evidenceRevision,
				gitHead: event.gitHead,
				diffHash: event.diffHash,
				error: undefined,
			});
		default:
			return withError(state, `Cannot handle ${event.type} from active`);
	}
}

/**
 * Handle events while in completion_requested state.
 *
 * A verdict event passes through advisor_reviewing status before
 * being processed by processVerdict, ensuring the state machine
 * correctly captures the review transition in the state history.
 * The status update to advisor_reviewing happens first, then
 * processVerdict determines the final status (completed or
 * remediation_required).
 */
function transitionCompletionRequested(state: TaskState, event: TaskEvent): TaskState {
	if (event.type === "advisor_accepted" && event.reviewId === state.activeReviewId) {
		return update(state, { status: "advisor_reviewing", error: undefined });
	}
	if (event.type === "advisor_silent") {
		return update(state, { status: "stalled", error: "Advisor silent — no verdict issued" });
	}
	if (event.type === "review_failed" && event.reviewId === state.activeReviewId) {
		return update(state, { status: "stalled", error: event.reason });
	}
	return withError(state, `Cannot handle ${event.type} from completion_requested`);
}

function transitionAdvisorReviewing(state: TaskState, event: TaskEvent): TaskState {
	switch (event.type) {
		case "advisor_silent":
			return update(state, { status: "stalled", error: "Advisor silent — no verdict issued" });
		case "review_failed":
			return event.reviewId === state.activeReviewId
				? update(state, { status: "stalled", error: event.reason })
				: withError(state, "Review identity mismatch");
		case "protocol_error":
			return update(state, { error: event.error });
		case "verdict":
			return processVerdict(state, event);
		default:
			return withError(state, `Cannot handle ${event.type} from advisor_reviewing`);
	}
}

function transitionRemediationRequired(state: TaskState, event: TaskEvent): TaskState {
	switch (event.type) {
		case "activity":
			return update(state, {
				status: "active",
				worktreeFingerprint: event.worktreeFingerprint,
				error: undefined,
			});
		case "remediation": {
			const lastFp = state.lastRemediationFingerprint;
			const same = lastFp !== undefined && event.fingerprint === lastFp;
			const consecutive = same ? state.consecutiveStalledFingerprints + 1 : 1;

			if (consecutive >= STALLED_THRESHOLD) {
				return update(state, {
					status: "stalled",
					lastRemediationFingerprint: event.fingerprint,
					consecutiveStalledFingerprints: consecutive,
				});
			}
			return update(state, {
				lastRemediationFingerprint: event.fingerprint,
				consecutiveStalledFingerprints: consecutive,
			});
		}
		default:
			return withError(state, `Cannot handle ${event.type} from remediation_required`);
	}
}

function transitionStalled(state: TaskState, event: TaskEvent): TaskState {
	if (event.type === "retry") {
		return update(state, { status: "completion_requested", activeReviewId: event.reviewId, error: undefined });
	}
	if (event.type === "activity") {
		if (event.worktreeFingerprint === state.worktreeFingerprint) {
			return state;
		}
		return update(state, {
			status: "active",
			worktreeFingerprint: event.worktreeFingerprint,
			consecutiveStalledFingerprints: 0,
			lastRemediationFingerprint: undefined,
			error: undefined,
		});
	}
	return withError(state, `Cannot handle ${event.type} from stalled`);
}

// ─── Verdict processing ────────────────────────────────────────────

function processVerdict(state: TaskState, event: TaskEvent): TaskState {
	if (event.type !== "verdict") {
		return withError(state, "Internal error: non-verdict passed to processVerdict");
	}
	if (event.schemaValid !== true) {
		return update(state, { error: "Schema validation failed — verdict rejected", lastVerdict: undefined });
	}

	if (event.status === "pass") {
		return update(state, {
			status: "completed",
			lastVerdict: {
				status: "pass",
				summary: event.summary,
				schemaValid: true,
			},
			error: undefined,
		});
	}

	if (!event.requiredFixes || event.requiredFixes.length === 0) {
		return update(state, { error: "Remediation verdict requires at least one requiredFix" });
	}

	return update(state, {
		status: "remediation_required",
		lastVerdict: {
			status: "remediation_required",
			summary: event.summary,
			requiredFixes: event.requiredFixes,
			schemaValid: true,
		},
		consecutiveStalledFingerprints: 0,
		lastRemediationFingerprint: undefined,
		error: undefined,
	});
}

// ─── Helpers ───────────────────────────────────────────────────────

function update(state: TaskState, patch: Partial<TaskState> & { status?: TaskStatus }): TaskState {
	return {
		...state,
		...patch,
		updatedAt: new Date().toISOString(),
	};
}

function withError(state: TaskState, error: string): TaskState {
	return {
		...state,
		error,
		updatedAt: new Date().toISOString(),
	};
}
