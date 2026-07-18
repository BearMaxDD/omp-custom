import { createHash } from "node:crypto";
import type { ReviewIntentInput } from "./review-intent";

export function buildReviewDedupeKey(input: ReviewIntentInput): string {
	const identity = [
		input.trigger,
		input.projectId,
		input.taskId ?? null,
		input.topicId ?? null,
		input.contractHash,
		input.evidenceRevision,
		input.gitHead,
		input.diffHash,
		input.forceNonce ?? null,
	];
	return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
