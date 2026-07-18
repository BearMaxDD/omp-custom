export type ReviewIntentStatus = "queued" | "in_flight" | "stalled" | "completed";

export interface ReviewIntentInput {
	readonly trigger: string;
	readonly priority: number;
	readonly projectId: string;
	readonly taskId?: string;
	readonly topicId?: string;
	readonly contractHash: string;
	readonly evidenceRevision: string;
	readonly gitHead: string;
	readonly diffHash: string;
	readonly forceNonce?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReviewIntent extends ReviewIntentInput {
	readonly dedupeKey: string;
	readonly reviewId: string;
	readonly status: ReviewIntentStatus;
	readonly attempt: number;
	readonly notBefore: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export const REVIEW_INTENT_MAX_STRING_LENGTH = 256;
export const REVIEW_INTENT_MAX_METADATA_BYTES = 32 * 1024;

function boundedString(name: string, value: unknown, required: true): string;
function boundedString(name: string, value: unknown, required: false): string | undefined;
function boundedString(name: string, value: unknown, required: boolean): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	if (value.length > REVIEW_INTENT_MAX_STRING_LENGTH) {
		throw new Error(`${name} exceeds ${REVIEW_INTENT_MAX_STRING_LENGTH} characters`);
	}
	return value;
}

function sanitizeMetadata(metadata: ReviewIntentInput["metadata"]): Readonly<Record<string, unknown>> | undefined {
	if (metadata === undefined) return undefined;
	if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
		throw new Error("metadata must be a JSON object");
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(metadata, (_key, value: unknown) => {
			if (
				typeof value === "bigint" ||
				typeof value === "function" ||
				typeof value === "symbol" ||
				typeof value === "undefined" ||
				(typeof value === "number" && !Number.isFinite(value))
			) {
				throw new Error("unsupported metadata value");
			}
			return value;
		});
	} catch {
		throw new Error("metadata must contain bounded JSON values");
	}
	if (new TextEncoder().encode(serialized).byteLength > REVIEW_INTENT_MAX_METADATA_BYTES) {
		throw new Error(`metadata exceeds ${REVIEW_INTENT_MAX_METADATA_BYTES} bytes`);
	}
	return Object.freeze(JSON.parse(serialized) as Record<string, unknown>);
}

export function normalizeReviewIntentInput(input: ReviewIntentInput): ReviewIntentInput {
	if (!Number.isInteger(input.priority) || input.priority < -1_000 || input.priority > 1_000) {
		throw new Error("priority must be an integer between -1000 and 1000");
	}
	return Object.freeze({
		trigger: boundedString("trigger", input.trigger, true),
		priority: input.priority,
		projectId: boundedString("projectId", input.projectId, true),
		taskId: boundedString("taskId", input.taskId, false),
		topicId: boundedString("topicId", input.topicId, false),
		contractHash: boundedString("contractHash", input.contractHash, true),
		evidenceRevision: boundedString("evidenceRevision", input.evidenceRevision, true),
		gitHead: boundedString("gitHead", input.gitHead, true),
		diffHash: boundedString("diffHash", input.diffHash, true),
		forceNonce: boundedString("forceNonce", input.forceNonce, false),
		metadata: sanitizeMetadata(input.metadata),
	});
}

export function sameReviewScope(left: ReviewIntentInput, right: ReviewIntentInput): boolean {
	return (
		left.projectId === right.projectId &&
		left.taskId === right.taskId &&
		left.topicId === right.topicId &&
		left.contractHash === right.contractHash &&
		left.evidenceRevision === right.evidenceRevision &&
		left.gitHead === right.gitHead &&
		left.diffHash === right.diffHash
	);
}
