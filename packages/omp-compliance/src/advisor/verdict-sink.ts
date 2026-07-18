/**
 * Verdict Sink — receives and processes ComplianceVerdicts from the
 * Advisor with strict enforcement of protocol rules.
 *
 * Responsibilities:
 *  1. Schema validation via parseVerdict (task_id, contract_hash, attempt)
 *  2. Idempotency: same (task_id, contract_hash, attempt) only once
 *  3. Stale attempt detection: older attempts logged as protocol error
 *  4. Post-pass rejection: "remediate" after "pass" is never accepted
 *  5. Persistence of last processed verdict per task
 *
 * The sink stores an ordered list of verdict records so downstream
 * consumers (state machine, compliance runtime) can inspect the
 * last action and detect protocol violations.
 */

import type { SHA256Hash } from "../contract/types";
import { VerdictValidationError, parseVerdict } from "./verdict-schema";
import type { ComplianceFinding, ComplianceVerdict, VerdictContext } from "./verdict-schema";

// ─── Verdict Record ──────────────────────────────────────────────────

/** Outcome of processing a verdict through the sink. */
export type VerdictAcceptResult =
	| {
			status: "accepted";
			verdict: ComplianceVerdict;
	  }
	| {
			status: "rejected";
			reason: string;
			protocolError?: boolean;
	  };

/** A persisted verdict record in the sink store. */
export interface VerdictRecord {
	reviewId: string;
	projectId: string;
	taskId: string;
	contractHash: SHA256Hash;
	attempt: number;
	status: "pass" | "remediate";
	findings: ComplianceFinding[];
	acceptedAt: string; // ISO timestamp
}

/** Ordered store of verdicts — in-memory for now. */
export interface VerdictStore {
	/** All verdicts ever accepted, in order. */
	records: VerdictRecord[];
	/** The last pass verdict attempt per (taskId, contractHash). */
	lastPass: Record<string, number>; // key = `${taskId}:${contractHash}` => attempt
	/**
	 * Set of accepted verdict keys for O(1) idempotency checking.
	 * Each key is `${taskId}:${contractHash}:${attempt}`.
	 */
	acceptedKeys: Set<string>;
	acceptedDigests?: Record<string, string>;
}

// ─── Sink ────────────────────────────────────────────────────────────

/**
 * In-memory verdict store — extends as needed for persistence.
 * Module-level singleton for the extension session.
 */
export const defaultStore: VerdictStore = {
	records: [],
	lastPass: {},
	acceptedKeys: new Set(),
	acceptedDigests: {},
};

/**
 * Accept and validate a ComplianceVerdict from the Advisor.
 *
 * Rules enforced:
 *  1. parseVerdict validates schema structure + context binding
 *  2. Idempotency: (task_id, contract_hash, attempt) must be new
 *  3. Stale attempt: attempt < current known attempt for this task
 *     → protocol error (never overwrites)
 *  4. Post-pass lock: "remediate" after "pass" for same task+hash
 *     → rejected (pass is final)
 *  5. pass records the attempt in lastPass for idempotency
 *
 * @param verdict      — raw verdict object from the Advisor
 * @param context      — expected task context (taskId, contractHash, attempt)
 * @param store        — verdict store (defaultStore if omitted)
 * @param parsed       — optional pre-validated verdict (avoids duplicate parseVerdict)
 * @returns Accepted or rejected result
 */
export function acceptVerdict(
	verdict: Record<string, unknown>,
	context: VerdictContext,
	store: VerdictStore = defaultStore,
	parsed?: ComplianceVerdict,
): VerdictAcceptResult {
	// Step 1: Schema + context validation (skip if pre-parsed provided)
	let resolved: ComplianceVerdict;
	if (parsed) {
		resolved = parsed;
	} else {
		try {
			resolved = parseVerdict(verdict, context);
		} catch (err) {
			if (err instanceof VerdictValidationError) {
				return {
					status: "rejected",
					reason: err.message,
					protocolError: true,
				};
			}
			throw err;
		}
	}

	const { review_id, task_id, project_id, contract_hash, attempt, status, findings } = resolved;

	// Step 2: Stale attempt check — older attempt after a newer pass is a protocol error
	const passKey = `${task_id}:${contract_hash}`;
	const lastPassAttempt = store.lastPass[passKey];
	if (lastPassAttempt !== undefined && attempt < lastPassAttempt) {
		return {
			status: "rejected",
			reason: `Stale verdict: attempt ${attempt} < last pass at attempt ${lastPassAttempt}`,
			protocolError: true,
		};
	}

	// Step 3: Post-pass lock — "remediate" after a "pass" at the same or later attempt
	if (status === "remediate" && lastPassAttempt !== undefined && attempt >= lastPassAttempt) {
		return {
			status: "rejected",
			reason: `Cannot remediate after pass (last pass at attempt ${lastPassAttempt})`,
			protocolError: true,
		};
	}

	// Step 4: Idempotency — O(1) check via Set
	const verdictKey = review_id ?? `${task_id}:${contract_hash}:${attempt}`;
	const digest = JSON.stringify(resolved);
	if (store.acceptedKeys.has(verdictKey)) {
		const conflict = store.acceptedDigests?.[verdictKey] !== undefined && store.acceptedDigests[verdictKey] !== digest;
		return {
			status: "rejected",
			reason: conflict
				? `Conflicting verdict for review ${review_id}`
				: `Verdict for review ${review_id} already processed`,
			protocolError: conflict || undefined,
		};
	}

	// Step 5: Persist
	const record: VerdictRecord = {
		reviewId: review_id ?? verdictKey,
		projectId: project_id ?? "legacy",
		taskId: task_id,
		contractHash: contract_hash,
		attempt,
		status,
		findings,
		acceptedAt: new Date().toISOString(),
	};

	store.records.push(record);
	store.acceptedKeys.add(verdictKey);
	if (!store.acceptedDigests) store.acceptedDigests = {};
	store.acceptedDigests[verdictKey] = digest;

	if (status === "pass") {
		store.lastPass[passKey] = attempt;
	}

	return {
		status: "accepted",
		verdict: resolved,
	};
}

/**
 * Check whether a given (taskId, contractHash) has a completed pass.
 *
 * @returns true if a "pass" verdict has been accepted for this task+hash.
 */
export function hasPassed(taskId: string, contractHash: SHA256Hash, store: VerdictStore = defaultStore): boolean {
	const passKey = `${taskId}:${contractHash}`;
	return store.lastPass[passKey] !== undefined;
}
