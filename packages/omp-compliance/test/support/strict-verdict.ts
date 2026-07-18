import type { VerdictContext } from "../../src/advisor/verdict-schema";
import type { SHA256Hash } from "../../src/contract/types";

const TEST_PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_EVIDENCE_REVISION = `sha256:${"b".repeat(64)}`;
const TEST_GIT_HEAD = "c".repeat(40);
const TEST_DIFF_HASH = `sha256:${"d".repeat(64)}`;

export function strictVerdictContext(
	taskId: string,
	contractHash: SHA256Hash,
	attempt = 1,
	overrides: Partial<VerdictContext> = {},
): VerdictContext {
	return {
		reviewId: `review:${"1".repeat(64)}:${attempt}`,
		taskId,
		projectId: TEST_PROJECT_ID,
		contractHash,
		evidenceRevision: TEST_EVIDENCE_REVISION,
		gitHead: TEST_GIT_HEAD,
		diffHash: TEST_DIFF_HASH,
		trigger: "compliance_review",
		attempt,
		...overrides,
	};
}

export function strictVerdictFields(context: VerdictContext): Record<string, unknown> {
	return {
		review_id: context.reviewId,
		project_id: context.projectId,
		evidence_revision: context.evidenceRevision,
		git_head: context.gitHead,
		diff_hash: context.diffHash,
		trigger: context.trigger,
	};
}
