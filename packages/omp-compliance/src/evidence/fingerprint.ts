/**
 * Worktree fingerprint computation for stalled detection.
 *
 * Produces a SHA-256 digest of the combined worktree state:
 *   sha256(worktree_diff_hash + normalized_findings + verification_result_hash + contract_hash)
 *
 * Same inputs always produce the same fingerprint.
 * Different inputs produce different fingerprints.
 */

import { createHash } from "node:crypto";

/**
 * Compute a composite fingerprint from worktree and task state.
 *
 * Combines four inputs into a single SHA-256 hex digest:
 * - worktreeDiffHash — diff of the git worktree
 * - normalizedFindings — normalized lint/test findings
 * - verificationResultHash — hash of verification outputs
 * - contractHash — SHA-256 of the compliance contract
 */
export function computeFingerprint(
	worktreeDiffHash: string,
	normalizedFindings: string,
	verificationResultHash: string,
	contractHash: string,
): string {
	const safeJoin = (parts: string[]): string => parts.map((p) => `${p.length}:${p}`).join("|");
	const combined = safeJoin([worktreeDiffHash, normalizedFindings, verificationResultHash, contractHash]);
	return createHash("sha256").update(combined, "utf-8").digest("hex");
}
