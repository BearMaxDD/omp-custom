/**
 * Execution policy extraction from TDD markdown.
 *
 * Parses YAML front matter for explicit task-kind overrides and
 * produces a ComplianceExecutionPolicy. Non-code tasks can declare
 * an exemption from codebase MCP and subagent delegation requirements.
 *
 * The policy is always derived from the document and never silently
 * skipped — a non-code exemption is auditable in the metadata.
 */

import type { ComplianceExecutionPolicy } from "./types";

/** Default code-task policy. */
const CODE_DEFAULT: ComplianceExecutionPolicy = {
	taskKind: "code",
	requiresCodebaseMcp: true,
	requiresSubagentDelegation: true,
};

/** Non-code exempt policy. */
const NON_CODE_EXEMPT: ComplianceExecutionPolicy = {
	taskKind: "non_code",
	requiresCodebaseMcp: false,
	requiresSubagentDelegation: false,
};

/** Regex to capture YAML front matter between `---` delimiters. */
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/m;

/**
 * Parse YAML front matter values by key.
 *
 * Simple key-value parser supporting `key: value` and `key: value`
 * patterns. Recognises `true` and `false` boolean values.
 */
function parseFrontMatterValue(frontMatter: string, key: string): string | boolean | undefined {
	const lowerKey = key.toLowerCase();
	const lowerFM = frontMatter.toLowerCase();

	// Build a regex matching `key: value` (case-insensitive, via lowered text)
	const escapedKey = lowerKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^${escapedKey}\\s*[:=]\\s*(.+)$`, "m");
	const match = lowerFM.match(pattern);
	if (!match) return undefined;

	const value = match[1].trim();
	if (value === "true") return true;
	if (value === "false") return false;
	return value;
}

/**
 * Extract an execution policy from the given markdown text.
 *
 * Examines the document for YAML front matter containing task-kind
 * metadata. Returns the default code-task policy when no metadata
 * is present or when the metadata does not declare an exemption.
 */
export function extractExecutionPolicy(markdown: string): ComplianceExecutionPolicy {
	if (!markdown.trim()) {
		return CODE_DEFAULT;
	}

	const frontMatch = FRONT_MATTER_RE.exec(markdown);
	if (!frontMatch) {
		return CODE_DEFAULT;
	}

	const frontMatter = frontMatch[1];
	const taskKind = parseFrontMatterValue(frontMatter, "taskKind");

	if (taskKind === "non_code") {
		return NON_CODE_EXEMPT;
	}

	return CODE_DEFAULT;
}
