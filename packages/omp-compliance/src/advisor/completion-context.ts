/**
 * Completion Context — assembles an XML-formatted compliance-task
 * summary for the Advisor.
 *
 * The output is a single <compliance-task> block with strict length
 * caps, redacted values, and deterministic ordering so the Advisor
 * can make a consistent verdict without extraneous noise.
 *
 * Input: a CompletionSnapshot (facts-only record from completion-gate)
 *        plus the execution policy for tool-restriction rules.
 */

import type { SHA256Hash } from "../contract/types";
import type { ComplianceExecutionPolicy } from "../contract/types";
import type { CompletionSnapshot } from "../runtime/completion-gate";

// ─── Length Constraints ──────────────────────────────────────────────

/** Max characters for the entire XML payload. */
const MAX_XML_LENGTH = 8_000;

/** Max lines in any multi-value field. */
const MAX_LINES_PER_FIELD = 50;

/** Max characters per individual line. */
const MAX_CHARS_PER_LINE = 200;

/** Max remediation items to include. */
const MAX_REMEDIATION_ITEMS = 20;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build an XML <compliance-task> block from the completion snapshot
 * and execution policy.
 *
 * Fields are sorted deterministically and truncated to the maximum
 * payload size. Private/temp directory paths are redacted to
 * /private/.... Redundant whitespace is stripped.
 *
 * @param snapshot — composite completion snapshot
 * @param policy   — execution policy for this task
 * @returns XML string wrapped in <compliance-task>...</compliance-task>
 */
export function buildCompletionContext(snapshot: CompletionSnapshot, policy: ComplianceExecutionPolicy): string {
	const lines: string[] = [];

	// 1. task_id
	lines.push(`<task_id>${xmlEscape(snapshot.taskId)}</task_id>`);

	// 2. tdd_path
	lines.push(`<tdd_path>${xmlEscape(snapshot.contract.tddPath)}</tdd_path>`);

	// 3. contract_hash
	lines.push(`<contract_hash>${xmlEscape(snapshot.contract.hash)}</contract_hash>`);

	// 4. execution_policy
	lines.push(`<execution_policy>${renderPolicy(policy)}</execution_policy>`);

	// 5. contract_summary (deterministic field ordering)
	lines.push(`<contract_summary>${renderContractSummary(snapshot)}</contract_summary>`);

	// 6. changed_paths (from diffFingerprint — a proxy for changed files)
	lines.push(`<changed_paths>${xmlEscape(snapshot.diffFingerprint)}</changed_paths>`);

	// 7. verification_summary
	lines.push(`<verification_summary>${renderVerificationSummary(snapshot)}</verification_summary>`);

	// 8. codebase_memory_evidence
	lines.push(`<codebase_memory_evidence>${renderCodebaseMemory(snapshot)}</codebase_memory_evidence>`);

	// 9. subagent_delegation_evidence
	lines.push(`<subagent_delegation_evidence>${renderDelegationEvidence(snapshot)}</subagent_delegation_evidence>`);

	// 10. prior_remediation
	lines.push(`<prior_remediation>${renderPriorRemediation(snapshot)}</prior_remediation>`);

	// 11. completion_claim
	lines.push(
		`<completion_claim>${xmlEscape(truncateLine(snapshot.agentClaim.summary, MAX_CHARS_PER_LINE))}</completion_claim>`,
	);

	let xml = `<compliance-task>\n${lines.join("\n")}\n</compliance-task>`;

	// Enforce total length limit
	if (xml.length > MAX_XML_LENGTH) {
		xml = `${xml.slice(0, MAX_XML_LENGTH - 40)}\n...\n</compliance-task>`;
	}

	return xml;
}

// ─── Helper: execution policy ───────────────────────────────────────

function renderPolicy(policy: ComplianceExecutionPolicy): string {
	const parts: string[] = [];
	parts.push(`taskKind=${policy.taskKind}`);
	parts.push(`requiresCodebaseMcp=${String(policy.requiresCodebaseMcp)}`);
	parts.push(`requiresSubagentDelegation=${String(policy.requiresSubagentDelegation)}`);
	return parts.join(", ");
}

// ─── Helper: contract summary ────────────────────────────────────────

function renderContractSummary(snapshot: CompletionSnapshot): string {
	const lines: string[] = [];
	const s = snapshot.contract.summary;

	if (s.goal) {
		lines.push(`goal: ${truncateLine(s.goal, MAX_CHARS_PER_LINE)}`);
	}

	if (s.scope.length > 0) {
		const scope = truncateLines(s.scope, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		lines.push("scope:");
		for (const item of scope) {
			lines.push(`  - ${item}`);
		}
	}

	if (s.files.length > 0) {
		const files = truncateLines(s.files, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		lines.push("files:");
		for (const f of files) {
			lines.push(`  - ${redactPath(f)}`);
		}
	}

	if (s.tests.length > 0) {
		const tests = truncateLines(s.tests, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		lines.push("tests:");
		for (const t of tests) {
			lines.push(`  - ${t}`);
		}
	}

	if (s.verification.length > 0) {
		const verif = truncateLines(s.verification, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		lines.push("verification:");
		for (const v of verif) {
			lines.push(`  - ${v}`);
		}
	}

	if (s.completionCriteria.length > 0) {
		const crit = truncateLines(s.completionCriteria, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		lines.push("completionCriteria:");
		for (const c of crit) {
			lines.push(`  - ${c}`);
		}
	}

	return lines.join(" | ");
}

// ─── Helper: verification summary ────────────────────────────────────

function renderVerificationSummary(snapshot: CompletionSnapshot): string {
	const verifications = snapshot.verifications;
	if (verifications.length === 0) {
		return "none";
	}

	const items = verifications.map((v) => {
		const cmd = truncateLine(v.command, MAX_CHARS_PER_LINE);
		const status = v.passed ? "passed" : `failed(exit=${v.exitCode})`;
		return `[${status}] ${cmd}`;
	});

	return items.join(" | ");
}

// ─── Helper: codebase memory ─────────────────────────────────────────

function renderCodebaseMemory(snapshot: CompletionSnapshot): string {
	const cb = snapshot.codebaseMemory;
	const parts: string[] = [];

	parts.push(`indexReady=${String(cb.indexReady)}`);

	if (cb.queries.length > 0) {
		const queries = truncateLines(cb.queries, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		parts.push(`queries=${queries.join(", ")}`);
	}

	if (cb.references.length > 0) {
		const refs = truncateLines(cb.references, MAX_LINES_PER_FIELD, MAX_CHARS_PER_LINE);
		parts.push(`references=${refs.join(", ")}`);
	}

	return parts.join(" | ");
}

// ─── Helper: subagent delegation ─────────────────────────────────────

function renderDelegationEvidence(snapshot: CompletionSnapshot): string {
	const delegations = snapshot.delegations;
	if (delegations.length === 0) {
		return "none";
	}

	const items = delegations.map((d) => {
		const id = d.agentId ? truncateLine(d.agentId, 40) : "?";
		const summary = d.taskSummary ? truncateLine(d.taskSummary, MAX_CHARS_PER_LINE) : "?";
		return `${id}: ${summary}`;
	});

	return items.join(" | ");
}

// ─── Helper: prior remediation ──────────────────────────────────────

function renderPriorRemediation(snapshot: CompletionSnapshot): string {
	const all = [...snapshot.remediation.open, ...snapshot.remediation.closed];
	const items = all.slice(0, MAX_REMEDIATION_ITEMS);

	if (items.length === 0) {
		return "none";
	}

	return items
		.map((r) => {
			const fix = truncateLine(r.requiredFix, MAX_CHARS_PER_LINE);
			return `[${r.id}] ${fix}`;
		})
		.join(" | ");
}

// ─── Utility helpers ─────────────────────────────────────────────────

/** Escape text for XML content (angle brackets and ampersand). */
function xmlEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Truncate a line to at most `maxLen` characters.
 * Appends "…" when truncated.
 */
function truncateLine(line: string, maxLen: number): string {
	if (line.length <= maxLen) return line;
	return `${line.slice(0, maxLen - 1)}\u2026`;
}

/**
 * Truncate an array of lines to at most `maxLines` items,
 * each at most `maxLineLen` characters.
 */
function truncateLines(items: string[], maxLines: number, maxLineLen: number): string[] {
	return items.slice(0, maxLines).map((l) => truncateLine(l, maxLineLen));
}

/** Redact private/temp paths for the context payload. */
function redactPath(path: string): string {
	// Replace common private/temp patterns
	return path.replace(/\/private\/(?:var\/)?tmp\//g, "/private/....").replace(/^\/tmp\//, "/..../");
}
