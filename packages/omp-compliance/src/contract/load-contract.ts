/**
 * Compliance contract loading, hashing, and revision comparison.
 *
 * Loads a TDD markdown file, validates path safety within the repo
 * root, computes a SHA-256 hash of the source text, extracts a
 * limited-content summary, and determines the execution policy.
 *
 * Path safety rules:
 * - Absolute paths must be inside the repo root.
 * - Symlinks that escape the repo root are rejected.
 * - Non-existent files are rejected.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { extractExecutionPolicy } from "./execution-policy";
import { extractContractSummary } from "./markdown-summary";
import type { ComplianceContract, ContractChange, SHA256Hash } from "./types";
import { ContractLoadError } from "./types";

/**
 * Load a compliance contract from a TDD markdown file.
 *
 * @param filePath - Path to the TDD markdown file (absolute or relative).
 * @param repoRoot - Absolute path to the repository root.
 * @returns A fully resolved ComplianceContract.
 * @throws {ContractLoadError} If the file is missing, outside the repo
 *   root, or a symlink escapes the repo root.
 */
export function loadComplianceContract(filePath: string, repoRoot: string): ComplianceContract {
	const resolvedPath = resolve(filePath);
	const resolvedRoot = resolve(repoRoot);

	// 1. Check file exists
	if (!existsSync(resolvedPath)) {
		throw new ContractLoadError(`TDD contract file not found: ${resolvedPath}`, resolvedPath);
	}

	// 2. Resolve symlinks; reject if outside repo root
	let realPath: string;
	try {
		realPath = realpathSync(resolvedPath);
	} catch {
		realPath = resolvedPath;
	}

	const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
	if (!realPath.startsWith(rootPrefix) && realPath !== resolvedRoot) {
		throw new ContractLoadError(
			`TDD contract path escapes repo root: ${realPath} is outside ${resolvedRoot}`,
			resolvedPath,
		);
	}

	// 3. Read the source text
	const sourceText = readFileSync(realPath, "utf-8");

	// 4. Compute SHA-256 hash
	const contractHash = computeContractHash(sourceText);

	// 5. Extract summary
	const { summary, summaryStatus } = extractContractSummary(sourceText);

	// 6. Determine execution policy
	const policy = extractExecutionPolicy(sourceText);

	// 7. Derive task ID from filename stem and normalise relative path
	const tddPath = relative(resolvedRoot, realPath);
	const taskId = deriveTaskId(tddPath);

	return {
		taskId,
		tddPath,
		contractHash,
		sourceText,
		summary,
		summaryStatus,
		policy,
	};
}

/**
 * Compute SHA-256 hash of a text string.
 *
 * Returns a branded `sha256:hex` string for cryptographic identity
 * of the contract source.
 */
function computeContractHash(text: string): SHA256Hash {
	const hash = createHash("sha256");
	hash.update(text, "utf-8");
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Derive a task ID from the contract file path.
 *
 * Uses the filename stem (without extension and directory) as the
 * task identifier.
 */
function deriveTaskId(tddPath: string): string {
	const parts = tddPath.replace(/\\/g, "/").split("/");
	const filename = parts[parts.length - 1] ?? tddPath;
	const dotIdx = filename.lastIndexOf(".");
	return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

/**
 * Compare two contract revisions and describe the differences.
 *
 * Returns a ContractChange with the old and new hashes, the list of
 * changed sections, and a human-readable summary. Does NOT mutate
 * either contract — the caller is responsible for not silently
 * replacing a previous hash.
 */
export function compareContractRevision(original: ComplianceContract, updated: ComplianceContract): ContractChange {
	const contentChanged = original.contractHash !== updated.contractHash;
	const sectionsCompared = ["goal", "scope", "files", "tests", "verification", "completionCriteria"] as const;

	const changedSections: string[] = [];

	if (contentChanged) {
		const origSummary = original.summary;
		const updSummary = updated.summary;

		for (const section of sectionsCompared) {
			let changed = false;
			if (section === "goal") {
				changed = origSummary.goal !== updSummary.goal;
			} else {
				const arrOrig = origSummary[section];
				const arrUpd = updSummary[section];
				changed = arrOrig.length !== arrUpd.length || arrOrig.some((v, i) => v !== arrUpd[i]);
			}
			if (changed) {
				changedSections.push(section);
			}
		}

		if (changedSections.length === 0 && contentChanged) {
			changedSections.push("source_text_unlisted_sections");
		}
	}

	const summaryChanged = changedSections.length > 0;

	const changeSummary = contentChanged
		? `Content changed: ${changedSections.length === 0 ? "non-summary sections" : changedSections.join(", ")} (${original.contractHash.slice(0, 12)}... → ${updated.contractHash.slice(0, 12)}...)`
		: "No changes";

	return {
		oldHash: original.contractHash,
		newHash: updated.contractHash,
		changedSections,
		summaryChanged,
		contentChanged,
		changeSummary,
	};
}
