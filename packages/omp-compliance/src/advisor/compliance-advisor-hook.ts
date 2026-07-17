import type { AdvisorBeforeRunEvent, AdvisorRunAugmentation } from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
/**
 * Compliance Advisor Hook — injects review context and the
 * `compliance_verdict` tool into a dedicated Advisor run.
 *
 * The hook matches a `compliance_review` event against an envelope in
 * the registry. On match it returns:
 *  - additionalSystemContext: [rules, context] from the envelope
 *  - additionalTools: one immutable compliance_verdict tool
 *  - metadata: { complianceReviewId }
 *
 * The tool validates that the verdict's identity fields (task_id,
 * contract_hash, attempt) match the envelope, then delegates to
 * `runtime.acceptVerdict()`. The envelope is consumed only on success.
 */
import type { ComplianceReviewEnvelope, ComplianceReviewRegistry } from "./review-envelope";

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Create an advisor_before_run handler that injects compliance review
 * context and a dedicated verdict tool for matching events.
 */
export function createComplianceAdvisorHook(
	registry: ComplianceReviewRegistry,
	runtime: {
		acceptVerdict: (verdict: Record<string, unknown>) => Promise<{ accepted: boolean; reason?: string }>;
	},
): (event: AdvisorBeforeRunEvent) => AdvisorRunAugmentation | undefined {
	return (event: AdvisorBeforeRunEvent): AdvisorRunAugmentation | undefined => {
		if (event.trigger !== "compliance_review") {
			return undefined;
		}

		const reviewId = event.reviewId;

		const envelope = registry.get(reviewId);
		if (!envelope || !matchesEnvelope(event, envelope)) {
			return undefined;
		}

		return {
			additionalSystemContext: `${envelope.rules}\n\n${envelope.context}`,
			additionalTools: [createComplianceVerdictTool(envelope, runtime, registry)],
			metadata: Object.freeze({ complianceReviewId: envelope.reviewId }),
		};
	};
}

// ─── Tool factory ───────────────────────────────────────────────────

/**
 * Create the `compliance_verdict` tool bound to a specific envelope,
 * runtime instance, and registry.
 *
 * Validation order:
 *  1. Identity fields (attempt, task_id, contract_hash) must match the
 *     envelope — mismatches throw before touching the runtime.
 *  2. On match, runtime.acceptVerdict() handles full schema validation.
 *  3. On success the envelope is consumed (at-most-once).
 */
export function createComplianceVerdictTool(
	envelope: ComplianceReviewEnvelope,
	runtime: {
		acceptVerdict: (verdict: Record<string, unknown>) => Promise<{ accepted: boolean; reason?: string }>;
	},
	registry: ComplianceReviewRegistry,
): ToolDefinition {
	return {
		name: "compliance_verdict",
		label: "Compliance Verdict",
		description: "Submit a compliance verdict after reviewing the task completion",
		loadMode: "essential",
		approval: "write",
		parameters: {
			type: "object",
			properties: {
				schema_version: { type: "number", const: 1 },
				task_id: { type: "string" },
				contract_hash: { type: "string" },
				attempt: { type: "number" },
				status: { type: "string", enum: ["pass", "remediate"] },
				findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							reason: { type: "string" },
							required_fix: { type: "string" },
							evidence_refs: { type: "array", items: { type: "string" } },
						},
						required: ["id", "reason"],
					},
				},
			},
			required: ["schema_version", "task_id", "contract_hash", "attempt", "status", "findings"],
		},
		execute: async (_toolCallId: string, params: Record<string, unknown>) => {
			validateVerdictIdentity(params, envelope);
			const result = await runtime.acceptVerdict(params);
			if (!result.accepted) {
				return {
					content: [{ type: "text" as const, text: `Verdict rejected: ${result.reason ?? "unknown reason"}` }],
					details: result,
					isError: true,
				};
			}
			registry.consume(envelope.reviewId);
			return {
				content: [{ type: "text" as const, text: "Compliance verdict accepted." }],
				details: result,
			};
		},
	};
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Check that the event metadata matches the envelope identity fields.
 */
function matchesEnvelope(event: AdvisorBeforeRunEvent, envelope: ComplianceReviewEnvelope): boolean {
	const meta = event.metadata;
	if (!meta) return false;

	const metaTaskId = typeof meta.taskId === "string" ? meta.taskId : "";
	const metaContractHash = typeof meta.contractHash === "string" ? meta.contractHash : "";
	const metaAttempt = typeof meta.attempt === "number" ? meta.attempt : -1;

	return (
		metaTaskId === envelope.taskId && metaContractHash === envelope.contractHash && metaAttempt === envelope.attempt
	);
}

/**
 * Validate that the verdict's identity fields match the envelope.
 *
 * Throws on mismatch so the agent receives a clear error rather than
 * silently routing a verdict to the wrong task.
 */
function validateVerdictIdentity(params: Record<string, unknown>, envelope: ComplianceReviewEnvelope): void {
	if (params.attempt !== envelope.attempt) {
		throw new Error(
			`Verdict attempt (${String(params.attempt)}) does not match envelope attempt (${envelope.attempt})`,
		);
	}
	if (params.task_id !== envelope.taskId) {
		throw new Error(`Verdict task_id (${String(params.task_id)}) does not match envelope task_id (${envelope.taskId})`);
	}
	if (params.contract_hash !== envelope.contractHash) {
		throw new Error(
			`Verdict contract_hash (${String(params.contract_hash)}) does not match envelope contract_hash (${envelope.contractHash})`,
		);
	}
}
