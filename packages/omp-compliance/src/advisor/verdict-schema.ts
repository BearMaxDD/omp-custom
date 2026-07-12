/**
 * ComplianceVerdict schema, validation, and parsing.
 *
 * The Advisor issues a ComplianceVerdict (schema_version=1) for each
 * compliance review. The verdict is validated against the expected
 * task context (task_id, contract_hash, attempt) and structural rules:
 *
 *  - pass  => findings MAY be empty
 *  - remediate => EVERY finding MUST include a required_fix
 *
 * This module provides parseVerdict() for strict one-shot validation
 * with detailed errors. It NEVER decides semantics — only shape and
 * context binding.
 */

import type { SHA256Hash } from "../contract/types";

// ─── Verdict Schema (version 1) ──────────────────────────────────────

/** Schema version constant — only v1 exists. */
export const VERDICT_SCHEMA_VERSION = 1 as const;

/** A single finding from the advisor review. */
export interface ComplianceFinding {
	/** Unique identifier for this finding. */
	id: string;
	/** Human-readable explanation of the issue. */
	reason: string;
	/** Required fix steps (MUST be present when status is "remediate"). */
	required_fix?: string;
	/** Optional references to supporting evidence (tool call IDs, file paths). */
	evidence_refs?: string[];
}

/**
 * A compliance verdict issued by the advisor.
 *
 * Schema version 1:
 *  - pass  → findings MAY be empty; required_fix is never checked
 *  - remediate → every finding MUST include a non-empty required_fix
 */
export interface ComplianceVerdict {
	schema_version: typeof VERDICT_SCHEMA_VERSION;
	task_id: string;
	contract_hash: SHA256Hash;
	attempt: number;
	status: "pass" | "remediate";
	findings: ComplianceFinding[];
}

/** Expected context for verdict validation. */
export interface VerdictContext {
	taskId: string;
	contractHash: SHA256Hash;
	attempt: number;
}

// ─── Validation ──────────────────────────────────────────────────────

/** Errors collected during verdict validation. */
export interface VerdictValidationErrorInfo {
	field: string;
	message: string;
}

/**
 * Validate a raw input object as a ComplianceVerdict against the
 * expected execution context.
 *
 * Returns the validated verdict on success. Throws a descriptive error
 * (joining all findings with "; ") on failure.
 *
 * Validation rules:
 *  1. schema_version must be exactly 1
 *  2. task_id must be a non-empty string matching expectedContext
 *  3. contract_hash must be a valid SHA256Hash matching expectedContext
 *  4. attempt must be a positive integer matching expectedContext
 *  5. status must be "pass" or "remediate"
 *  6. findings must be an array
 *  7. pass  → findings MAY be empty (no additional checks)
 *  8. remediate → every finding MUST have a non-empty required_fix
 *  9. Each finding must have a non-empty id and reason
 */
export function parseVerdict(raw: Record<string, unknown>, expectedContext: VerdictContext): ComplianceVerdict {
	const errors: VerdictValidationErrorInfo[] = [];

	// ── Schema version ──
	if (raw.schema_version !== VERDICT_SCHEMA_VERSION) {
		errors.push({
			field: "schema_version",
			message: `expected ${VERDICT_SCHEMA_VERSION}, got ${JSON.stringify(raw.schema_version)}`,
		});
	}

	// ── task_id ──
	const taskId = raw.task_id;
	if (typeof taskId !== "string" || taskId.length === 0) {
		errors.push({ field: "task_id", message: "must be a non-empty string" });
	} else if (taskId !== expectedContext.taskId) {
		errors.push({
			field: "task_id",
			message: `expected "${expectedContext.taskId}", got "${taskId}"`,
		});
	}

	// ── contract_hash ──
	const contractHash = raw.contract_hash;
	if (typeof contractHash !== "string" || !contractHash.startsWith("sha256:")) {
		errors.push({
			field: "contract_hash",
			message: "must be a valid SHA256Hash (sha256:...)",
		});
	} else if (contractHash !== expectedContext.contractHash) {
		errors.push({
			field: "contract_hash",
			message: `expected "${expectedContext.contractHash}", got "${contractHash}"`,
		});
	}

	// ── attempt ──
	const attempt = raw.attempt;
	if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
		errors.push({
			field: "attempt",
			message: `must be a positive integer, got ${JSON.stringify(attempt)}`,
		});
	} else if (attempt !== expectedContext.attempt) {
		errors.push({
			field: "attempt",
			message: `expected ${expectedContext.attempt}, got ${attempt}`,
		});
	}

	// ── status ──
	const status = raw.status;
	if (status !== "pass" && status !== "remediate") {
		errors.push({
			field: "status",
			message: `must be "pass" or "remediate", got ${JSON.stringify(status)}`,
		});
	}

	// ── findings ──
	const findings = raw.findings;
	if (!Array.isArray(findings)) {
		errors.push({ field: "findings", message: "must be an array" });
	} else {
		for (let i = 0; i < findings.length; i++) {
			const f = findings[i];
			if (typeof f !== "object" || f === null) {
				errors.push({
					field: `findings[${i}]`,
					message: "must be an object",
				});
				continue;
			}

			const finding = f as Record<string, unknown>;

			if (typeof finding.id !== "string" || finding.id.length === 0) {
				errors.push({
					field: `findings[${i}].id`,
					message: "must be a non-empty string",
				});
			}

			if (typeof finding.reason !== "string" || finding.reason.length === 0) {
				errors.push({
					field: `findings[${i}].reason`,
					message: "must be a non-empty string",
				});
			}

			// findings[].evidence_refs is optional but must be an array if present
			if (
				finding.evidence_refs !== undefined &&
				(!Array.isArray(finding.evidence_refs) || !finding.evidence_refs.every((r: unknown) => typeof r === "string"))
			) {
				errors.push({
					field: `findings[${i}].evidence_refs`,
					message: "must be an array of strings if present",
				});
			}
		}

		// status-specific rules
		if (status === "remediate") {
			if (findings.length === 0) {
				errors.push({
					field: "findings",
					message: "remediate verdict must include at least one finding with required_fix",
				});
			} else {
				for (let i = 0; i < findings.length; i++) {
					const f = findings[i] as Record<string, unknown>;
					const requiredFix = f.required_fix;
					if (typeof requiredFix !== "string" || requiredFix.length === 0) {
						errors.push({
							field: `findings[${i}].required_fix`,
							message: "required_fix must be a non-empty string for remediate verdict",
						});
					}
				}
			}
		}

		// pass verdict must not contain findings with required_fix
		if (status === "pass") {
			for (let i = 0; i < findings.length; i++) {
				const f = findings[i] as Record<string, unknown>;
				const requiredFix = f.required_fix;
				if (typeof requiredFix === "string" && requiredFix.length > 0) {
					errors.push({
						field: `findings[${i}].required_fix`,
						message: "pass verdict cannot contain an open required_fix",
					});
				}
			}
		}
	}

	if (errors.length > 0) {
		throw new VerdictValidationError(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
	}

	// After validation, narrow the raw object — findings meet the
	// structural rules verified above.
	return raw as unknown as ComplianceVerdict;
}

// ─── Error type ──────────────────────────────────────────────────────

/**
 * Error thrown when a ComplianceVerdict fails validation.
 */
export class VerdictValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "VerdictValidationError";
	}
}
