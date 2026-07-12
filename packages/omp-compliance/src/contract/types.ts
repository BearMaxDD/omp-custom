/**
 * Core type definitions for TDD Compliance Contract parsing.
 *
 * A ComplianceContract captures a parsed TDD specification with its
 * cryptographic hash, limited-content summary, and execution policy.
 * The original source text is always preserved as the authoritative
 * contract — an incomplete summary is never a local failure verdict.
 */

/** SHA-256 hex digest branded as a template literal type. */
export type SHA256Hash = `sha256:${string}`;

/** A limited-content summary extracted from the TDD markdown. */
export interface ContractSummary {
	/** The top-level goal or objective extracted from the TDD. */
	goal?: string;
	/** Lines from the scope section. */
	scope: string[];
	/** Files referenced in the TDD. */
	files: string[];
	/** Tests enumerated in the TDD. */
	tests: string[];
	/** Verification steps listed in the TDD. */
	verification: string[];
	/** Completion criteria from the TDD. */
	completionCriteria: string[];
}

/** Execution policy derived from the TDD content and metadata. */
export interface ComplianceExecutionPolicy {
	/** Whether this is a code-generation or non-code task. */
	taskKind: "code" | "non_code";
	/** Whether the agent may read the codebase during execution. */
	requiresCodebaseMcp: boolean;
	/** Whether the agent may delegate work to subagents. */
	requiresSubagentDelegation: boolean;
}

/** A fully resolved compliance contract. */
export interface ComplianceContract {
	/** Derived identifier (typically the filename stem). */
	taskId: string;
	/** Normalised relative path from repo root. */
	tddPath: string;
	/** SHA-256 hash of the full source text. */
	contractHash: SHA256Hash;
	/** The original source text — always the authoritative contract. */
	sourceText: string;
	/** The extracted limited-content summary. */
	summary: ContractSummary;
	/** Whether the summary extraction was complete or partial. */
	summaryStatus: "complete" | "incomplete";
	/** The execution policy for this contract. */
	policy: ComplianceExecutionPolicy;
}

/** Describes the difference between two contract revisions. */
export interface ContractChange {
	/** Hash of the earlier revision. */
	oldHash: SHA256Hash;
	/** Hash of the later revision. */
	newHash: SHA256Hash;
	/** Names of sections whose content differs. */
	changedSections: string[];
	/** Whether the summary text changed (within extracted limits). */
	summaryChanged: boolean;
	/** Whether the raw source text changed. */
	contentChanged: boolean;
	/** A human-readable summary of what changed. */
	changeSummary: string;
}

/**
 * Error thrown when a compliance contract cannot be loaded.
 *
 * Covers file-not-found, path-outside-repo-root, and symlink-escape
 * scenarios so callers can distinguish load failures from parse failures.
 */
export class ContractLoadError extends Error {
	/** The file path that caused the error. */
	public readonly filePath: string;

	constructor(message: string, filePath: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ContractLoadError";
		this.filePath = filePath;
	}
}
