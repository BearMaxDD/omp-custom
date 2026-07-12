/**
 * Advisor rules and read-only tool name definitions for brainstorm topic review.
 *
 * These are injected into the Advisor context when a brainstorm_review
 * trigger fires, guiding the Advisor to act as an independent reviewer
 * rather than a compliance gate.
 */

// ─── Read-Only Codebase Tool Suffixes ──────────────────────────────

/**
 * Suffixes of read-only codebase-memory tools that the advisor MAY use.
 * `index_repository` is deliberately excluded — it is a write operation.
 */
const READ_ONLY_CODEBASE_SUFFIXES = [
	"index_status",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
] as const;

/**
 * Static set of read-only codebase tool names for the advisor.
 */
export const BRAINSTORM_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>(READ_ONLY_CODEBASE_SUFFIXES);

/**
 * Check whether a tool name is a recognised read-only codebase tool.
 */
export function isCodebaseReadOnlyName(name: string): boolean {
	return BRAINSTORM_READ_ONLY_TOOL_NAMES.has(name);
}

// ─── Advisor Rules ─────────────────────────────────────────────────

/**
 * System prompt rules injected when the advisor runs a brainstorm review.
 *
 * These instruct the advisor to:
 * 1. Independently review the candidate decision — do not just restate it
 * 2. Prioritise counterexamples, missed constraints, migration/contract risks, alternatives
 * 3. Verify code-related claims against actual codebase evidence
 * 4. Use `insufficient_evidence` when the topic lacks detail
 * 5. Submit the structured review via the `brainstorm_review` tool
 * 6. Let the user make the final decision — do not block or approve
 */
export const BRAINSTORM_REVIEW_RULES = `\
<brainstorm-review-rules>
You are acting as an independent reviewer on a brainstorm topic.
Your task is to evaluate the candidate decision critically.

Rules:
1. Independently examine the candidate decision. Do not just restate the user's position or the main agent's conclusion — identify gaps, risks, and alternatives.
2. Prioritise pointing out concrete counterexamples, overlooked constraints, migration/contract risks, and viable alternative approaches.
3. For code-related topics, verify claims against actual codebase evidence using read-only tools. Do not assume code structure.
4. Use "insufficient_evidence" status when the topic input lacks the necessary detail or evidence to form a confident review. Explain what is missing.
5. Submit your structured review using the "brainstorm_review" tool. You may also use "advise" for supplementary natural-language notes, but "advise" does not replace the structured review.
6. You do NOT make the final decision. The user decides. Your role is to inform that decision with an independent analysis.

Allowed tools: read (files), grep (regex search), glob (pattern matching), advise (natural-language notes), the dynamically available codebase read-only tools, and brainstorm_review (submitting your structured review).
</brainstorm-review-rules>`;

/**
 * Static list of always-allowed advisor tool names for brainstorm review.
 * Read (file content), grep (regex search), glob (pattern matching), advise (note).
 */
export const BRAINSTORM_BASE_TOOL_NAMES: readonly string[] = ["read", "grep", "glob", "advise"];
