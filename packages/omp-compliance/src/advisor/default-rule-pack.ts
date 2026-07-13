/**
 * Default Rule Pack — production rules the Advisor follows when
 * evaluating a compliance task.
 *
 * Rules are rendered as human-readable text. The Advisor reads them
 * in its system prompt and MUST comply.
 *
 * Key semantic rules:
 *  - "pass" means the task satisfies the TDD contract; it does NOT
 *    mean every command succeeded or every tool returned 0.
 *  - Code tasks missing required evidence (codebase MCP queries,
 *    subagent delegation records) MUST be "remediate".
 *  - Advisor tool usage is restricted to: read, grep, glob, advise,
 *    compliance_verdict.
 *
 * This module NEVER interprets the rules itself — it only renders them
 * for the Advisor's consumption.
 */

import type { ComplianceExecutionPolicy } from "../contract/types";

// ─── Tool Restriction Rules ──────────────────────────────────────────

/**
 * List of tools the Advisor is restricted to using.
 * These are the only tools available during the review.
 */
export const ADVISOR_ALLOWED_TOOLS = ["read", "grep", "glob", "advise", "compliance_verdict"] as const;

// ─── Rule Definitions ────────────────────────────────────────────────

/**
 * Built-in rules that apply to all compliance tasks regardless of
 * policy. These cover the fundamental semantics of the compliance
 * system.
 */
const GLOBAL_RULES: string[] = [
	// Pass semantics
	`RULE: pass-meaning
"pass" means the task implementation satisfies the requirements in
the TDD contract. It does NOT mean every command exited 0 — a test
that proved a negative (e.g., confirming a file does not exist)
may have a non-zero exit code and still be compliant. Use the
verification_summary evidence to judge intent.`,

	// Remediate requirements
	`RULE: remediate-requires-fix
When the verdict is "remediate", every finding MUST include a
non-empty "required_fix" describing exactly what the agent must
change. Findings without a required_fix are protocol errors and
MUST be rejected.`,

	// Idempotency
	`RULE: idempotent-verdict
A "pass" verdict is final. A later "remediate" for the same
(task_id, contract_hash, attempt) MUST be rejected. A "remediate"
MUST NOT roll back a completed task.`,

	// Schema compliance
	`RULE: schema-compliance
The verdict MUST have schema_version=1, a non-empty task_id matching
the context, a valid sha256:... contract_hash matching the context,
and a positive integer attempt matching the context. Violations are
protocol errors.`,

	// Tool restrictions
	`RULE: tool-restrictions
The Advisor MAY only use these tools: read, grep, glob, advise,
compliance_verdict. Any other tool call will be rejected.`,
];

/**
 * Code-task rules — apply when policy.taskKind === "code".
 *
 * These rules enforce that code tasks provide the evidence the
 * compliance system expects: codebase MCP queries and subagent
 * delegation records.
 */
const CODE_TASK_RULES: string[] = [
	`RULE: requiresCodebaseMcp
Code tasks require codebase_memory_evidence in the completion context.
If codebase_memory_evidence shows indexReady=false or queries is
empty, the Advisor MUST issue "remediate" with a finding describing
the missing codebase context.`,

	`RULE: requiresSubagentDelegation
Code tasks require subagent_delegation_evidence in the completion
context. If subagent_delegation_evidence shows "none" or incomplete
delegation records when the task scope requires multi-file changes,
the Advisor MUST issue "remediate" with a finding describing the
missing delegation.`,

	`RULE: requiresVerification
Code tasks should include verification evidence. If
verification_summary shows "none" and the TDD contract lists
verification steps, the Advisor SHOULD issue "remediate".`,

	`RULE: contractChangedPaths
Code tasks should have a non-trivial diffFingerprint in changed_paths.
An empty or unchanged diffFingerprint suggests no code was written.
The Advisor SHOULD flag this as a finding.`,
];

/**
 * Non-code task rules — apply when policy.taskKind === "non_code".
 *
 * Non-code tasks (documentation, design, review) have lighter
 * evidence requirements.
 */
const NON_CODE_TASK_RULES: string[] = [
	`RULE: nonCodeEvidence
Non-code tasks are exempt from codebase MCP and subagent delegation
requirements. The Advisor MUST evaluate whether the completion claim
plausibly satisfies the TDD contract scope using only the
contract_summary, completion_claim, and verification_summary.`,

	`RULE: nonCodeVerification
Non-code tasks should include verification evidence for any completion
criteria. If verification_summary shows "none" and the contract lists
completion criteria, the Advisor SHOULD request verification.`,
];

// ─── Render ──────────────────────────────────────────────────────────

/**
 * Render the full set of compliance rules as a deterministic string
 * for inclusion in the Advisor's system prompt.
 *
 * @param policy — the execution policy for the current task
 * @returns A string with all applicable rules.
 */
export function renderCompletionRules(policy: ComplianceExecutionPolicy): string {
	const parts: string[] = ["# Compliance Review Rules", "", ...GLOBAL_RULES, ""];

	if (policy.taskKind === "code") {
		parts.push("# Code Task Rules");
		parts.push("");
		parts.push(...CODE_TASK_RULES);
		parts.push("");
	}

	if (policy.taskKind === "non_code") {
		parts.push("# Non-Code Task Rules");
		parts.push("");
		parts.push(...NON_CODE_TASK_RULES);
		parts.push("");
	}

	parts.push("# Allowed Tools");
	parts.push("");
	parts.push(ADVISOR_ALLOWED_TOOLS.map((t) => `  - ${t}`).join("\n"));

	return parts.join("\n");
}
