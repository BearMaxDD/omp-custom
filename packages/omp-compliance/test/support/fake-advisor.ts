/**
 * Fake Advisor — produces ComplianceVerdict-compatible verdict objects.
 *
 * All verdicts MUST be validatable by parseVerdict() in verdict-schema.ts
 * and MUST reach the Gate through the official acceptVerdict sink
 * (verdict-sink.ts). The verdict is a plain Record<string, unknown> that
 * matches the ComplianceVerdict schema; the schema module validates it
 * before the sink accepts it.
 *
 * NEVER produces pass verdicts based on fixture-local rules — only
 * produces structured verdicts that match the schema. The fake replaces
 * what the real Advisor LLM would produce, not the gate logic.
 *
 * Each verdict includes:
 *   - schema_version: 1
 *   - task_id from context
 *   - contract_hash from context
 *   - attempt from context
 *   - status: "pass" | "remediate"
 *   - findings: array of structured findings
 *     - For "remediate": every finding MUST include required_fix
 *     - For "pass": findings MAY be empty
 *
 * Usage pattern:
 *   const context: VerdictContext = { taskId, contractHash, attempt };
 *   const verdict = fakeAdvisor.remediateVerdict(context, findings);
 *   await runtime.acceptVerdict(verdict);
 */

import type { VerdictContext } from "../../src/advisor/verdict-schema";
import type { SHA256Hash } from "../../src/contract/types";

/** A single finding for a remediate verdict. */
export interface FakeFinding {
	id: string;
	reason: string;
	requiredFix: string;
	category?: "code" | "test" | "documentation" | "process";
	severity?: "error" | "warning" | "info";
	evidenceRefs?: string[];
}

/** Pre-built scenario verdict context (from runtime after start). */
export interface ScenarioContext {
	taskId: string;
	contractHash: SHA256Hash;
	attempt: number;
}

function strictFields(context: VerdictContext): Record<string, unknown> {
	return {
		review_id: context.reviewId,
		project_id: context.projectId,
		evidence_revision: context.evidenceRevision,
		git_head: context.gitHead,
		diff_hash: context.diffHash,
		trigger: context.trigger,
	};
}

export class FakeAdvisor {
	/**
	 * Create a "remediate" verdict.
	 *
	 * Each finding MUST include required_fix — parseVerdict enforces this.
	 * category, severity, and evidenceRefs are optional enrichments.
	 */
	remediateVerdict(context: VerdictContext, findings: FakeFinding[]): Record<string, unknown> {
		return {
			schema_version: 1,
			...strictFields(context),
			task_id: context.taskId,
			contract_hash: context.contractHash,
			attempt: context.attempt,
			status: "remediate",
			findings: findings.map((f) => ({
				id: f.id,
				reason: f.reason,
				category: f.category,
				severity: f.severity,
				required_fix: f.requiredFix,
				evidence_refs: f.evidenceRefs ?? [],
			})),
		};
	}

	/**
	 * Create a "pass" verdict.
	 *
	 * When summary is provided, a single finding with that reason is
	 * included. Empty findings array is also valid for "pass".
	 */
	passVerdict(context: VerdictContext, summary?: string): Record<string, unknown> {
		return {
			schema_version: 1,
			...strictFields(context),
			task_id: context.taskId,
			contract_hash: context.contractHash,
			attempt: context.attempt,
			status: "pass",
			findings: summary ? [{ id: "pass", reason: summary, required_fix: "" }] : [],
		};
	}

	/**
	 * Create a verdict with an invalid schema (for protocol error tests).
	 * Missing required fields will be rejected by parseVerdict.
	 */
	invalidVerdict(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
		return {
			schema_version: 1,
			...overrides,
		};
	}

	/**
	 * Extract the VerdictContext from a runtime's current task state.
	 * Convenience helper for test code.
	 */
	static contextFromRuntime(runtime: {
		currentTaskState: {
			taskId: string;
			projectId: string;
			contractHash: SHA256Hash;
			evidenceRevision: string;
			gitHead: string;
			diffHash: string;
			activeReviewId?: string;
			attempt: number;
		} | null;
	}): VerdictContext {
		const state = runtime.currentTaskState;
		if (!state) {
			throw new Error("No active task state available for context extraction");
		}
		if (!state.activeReviewId) {
			throw new Error("No active Advisor review available for context extraction");
		}
		return {
			taskId: state.taskId,
			reviewId: state.activeReviewId,
			projectId: state.projectId,
			contractHash: state.contractHash,
			evidenceRevision: state.evidenceRevision,
			gitHead: state.gitHead,
			diffHash: state.diffHash,
			trigger: "compliance_review",
			attempt: state.attempt,
		};
	}
}
