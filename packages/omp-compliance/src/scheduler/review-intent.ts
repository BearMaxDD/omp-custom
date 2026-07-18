import { types as utilTypes } from "node:util";

export const REVIEW_TRIGGER_PRIORITIES = Object.freeze({
	compliance_review: 100,
	manual_review: 80,
	brainstorm_review: 80,
	git_pre_push: 70,
	impact_analysis: 60,
	file_change: 40,
	scheduled: 20,
} as const);

export type ReviewTrigger = keyof typeof REVIEW_TRIGGER_PRIORITIES;
export type ReviewIntentStatus = "queued" | "in_flight" | "stalled" | "completed";

export interface ReviewIntentInput {
	readonly trigger: ReviewTrigger;
	readonly priority: number;
	readonly projectId: string;
	readonly taskId?: string;
	readonly topicId?: string;
	readonly contractHash: string;
	readonly evidenceRevision: string;
	readonly gitHead: string;
	readonly diffHash: string;
	readonly taskAttempt?: number;
	readonly force?: boolean;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReviewIntent extends ReviewIntentInput {
	readonly baseDedupeKey: string;
	readonly forceNonce?: string;
	readonly dedupeKey: string;
	readonly reviewId: string;
	readonly status: ReviewIntentStatus;
	readonly attempt: number;
	readonly notBefore: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly sequence: number;
}

export const REVIEW_INTENT_MAX_STRING_LENGTH = 256;
export const REVIEW_INTENT_MAX_METADATA_BYTES = 32 * 1024;
export const REVIEW_INTENT_MAX_METADATA_DEPTH = 8;
export const REVIEW_INTENT_MAX_METADATA_NODES = 512;
export const REVIEW_INTENT_MAX_METADATA_KEYS = 1_024;

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

interface MetadataBudget {
	nodes: number;
	keys: number;
	readonly seen: WeakSet<object>;
}

function cloneMetadataValue(value: unknown, depth: number, budget: MetadataBudget): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("metadata contains a non-finite number");
		return value;
	}
	if (typeof value !== "object") throw new Error("metadata contains an unsupported value");
	if (utilTypes.isProxy(value)) throw new Error("metadata must not contain Proxy values");
	if (depth > REVIEW_INTENT_MAX_METADATA_DEPTH) throw new Error("metadata exceeds maximum depth");
	if (budget.seen.has(value)) throw new Error("metadata must not contain cycles");
	budget.seen.add(value);
	budget.nodes++;
	if (budget.nodes > REVIEW_INTENT_MAX_METADATA_NODES) throw new Error("metadata exceeds node limit");

	const prototype = Object.getPrototypeOf(value);
	const array = Array.isArray(value);
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
		throw new Error("metadata must contain only plain objects and arrays");
	}
	if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("metadata must not contain symbol keys");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors).filter((key) => key !== "length");
	budget.keys += keys.length;
	if (budget.keys > REVIEW_INTENT_MAX_METADATA_KEYS) throw new Error("metadata exceeds key limit");

	if (array) {
		if (value.length > REVIEW_INTENT_MAX_METADATA_KEYS || keys.length !== value.length) {
			throw new Error("metadata arrays must be dense and bounded");
		}
		const output: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || "get" in descriptor || "set" in descriptor) {
				throw new Error("metadata must not contain accessors");
			}
			output.push(cloneMetadataValue(descriptor.value, depth + 1, budget));
		}
		return Object.freeze(output);
	}

	const output: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor || "get" in descriptor || "set" in descriptor) {
			throw new Error("metadata must not contain accessors");
		}
		Object.defineProperty(output, key, {
			value: cloneMetadataValue(descriptor.value, depth + 1, budget),
			enumerable: true,
			configurable: false,
			writable: false,
		});
	}
	return Object.freeze(output);
}

function sanitizeMetadata(metadata: ReviewIntentInput["metadata"]): Readonly<Record<string, unknown>> | undefined {
	if (metadata === undefined) return undefined;
	let cloned: unknown;
	try {
		cloned = cloneMetadataValue(metadata, 0, { nodes: 0, keys: 0, seen: new WeakSet() });
	} catch {
		throw new Error("metadata must contain bounded plain JSON values");
	}
	if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
		throw new Error("metadata must be a JSON object");
	}
	const serialized = JSON.stringify(cloned);
	if (new TextEncoder().encode(serialized).byteLength > REVIEW_INTENT_MAX_METADATA_BYTES) {
		throw new Error(`metadata exceeds ${REVIEW_INTENT_MAX_METADATA_BYTES} bytes`);
	}
	return cloned as Readonly<Record<string, unknown>>;
}

export function normalizeReviewIntentInput(input: ReviewIntentInput): ReviewIntentInput {
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		utilTypes.isProxy(input) ||
		(Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
		Object.getOwnPropertySymbols(input).length > 0
	) {
		throw new Error("review intent must be a plain object");
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) {
		throw new Error("review intent must be a plain object without accessors");
	}
	const value = <K extends keyof ReviewIntentInput>(key: K): ReviewIntentInput[K] | undefined =>
		descriptors[key]?.value as ReviewIntentInput[K] | undefined;
	const trigger = value("trigger");
	if (typeof trigger !== "string" || !Object.hasOwn(REVIEW_TRIGGER_PRIORITIES, trigger)) {
		throw new Error("trigger is not supported");
	}
	const expectedPriority = REVIEW_TRIGGER_PRIORITIES[trigger as ReviewTrigger];
	if (value("priority") !== expectedPriority) {
		throw new Error(`priority for ${trigger} must be ${expectedPriority}`);
	}
	const force = value("force");
	if (force !== undefined && typeof force !== "boolean") throw new Error("force must be boolean");
	if (force && trigger !== "manual_review") throw new Error("force is only valid for manual_review");
	const taskAttempt = value("taskAttempt");
	if (taskAttempt !== undefined && (!Number.isSafeInteger(taskAttempt) || (taskAttempt as number) < 1)) {
		throw new Error("taskAttempt must be a positive safe integer");
	}
	return Object.freeze({
		trigger: trigger as ReviewTrigger,
		priority: expectedPriority,
		projectId: boundedString("projectId", value("projectId"), true),
		taskId: boundedString("taskId", value("taskId"), false),
		topicId: boundedString("topicId", value("topicId"), false),
		contractHash: boundedString("contractHash", value("contractHash"), true),
		evidenceRevision: boundedString("evidenceRevision", value("evidenceRevision"), true),
		gitHead: boundedString("gitHead", value("gitHead"), true),
		diffHash: boundedString("diffHash", value("diffHash"), true),
		taskAttempt: taskAttempt as number | undefined,
		force: force === true ? true : undefined,
		metadata: sanitizeMetadata(value("metadata")),
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
		left.diffHash === right.diffHash &&
		left.taskAttempt === right.taskAttempt
	);
}
