import { createHash } from "node:crypto";
import type { ReviewIntentInput } from "./review-intent";

function sha256(identity: readonly unknown[]): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function buildReviewDedupeKey(input: ReviewIntentInput): string {
	return sha256([
		input.trigger,
		input.projectId,
		input.taskId ?? null,
		input.topicId ?? null,
		input.contractHash,
		input.evidenceRevision,
		input.gitHead,
		input.diffHash,
	]);
}

export function buildForcedReviewDedupeKey(baseDedupeKey: string, nonce: string): string {
	return sha256([baseDedupeKey, nonce]);
}
