import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { buildReviewDedupeKey } from "../scheduler/dedupe-key";

const MAX_STRING = 256;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;
const ALLOWED_KEYS = new Set([
	"taskId",
	"projectId",
	"contractHash",
	"evidenceRevision",
	"gitHead",
	"diffHash",
	"advisorPayloadHash",
	"attempt",
	"trigger",
	"createdAt",
]);

export interface ReviewEnvelopeInput {
	readonly taskId: string;
	readonly projectId: string;
	readonly contractHash: string;
	readonly evidenceRevision: string;
	readonly gitHead: string;
	readonly diffHash: string;
	readonly advisorPayloadHash: string;
	readonly attempt: number;
	readonly trigger: "compliance_review";
	readonly createdAt: string;
}

export interface ReviewEnvelope extends Omit<ReviewEnvelopeInput, "contractHash" | "evidenceRevision" | "diffHash"> {
	readonly contractHash: `sha256:${string}`;
	readonly evidenceRevision: `sha256:${string}`;
	readonly diffHash: `sha256:${string}`;
	readonly advisorPayloadHash: `sha256:${string}`;
	readonly reviewId: string;
	readonly envelopeHash: `sha256:${string}`;
}

export interface AdvisorPayloadBindingInput {
	readonly sessionId: string;
	readonly taskId: string;
	readonly projectId: string;
	readonly contractHash: string;
	readonly evidenceRevision: string;
	readonly gitHead: string;
	readonly diffHash: string;
	readonly trigger: "compliance_review";
	readonly attempt: number;
	readonly context: string;
	readonly rules: string;
	readonly createdAt: string;
}

export function computeAdvisorPayloadHash(input: AdvisorPayloadBindingInput): `sha256:${string}` {
	const canonical = JSON.stringify([
		input.sessionId,
		input.taskId,
		input.projectId,
		input.contractHash,
		input.evidenceRevision,
		input.gitHead,
		input.diffHash,
		input.trigger,
		input.attempt,
		input.context,
		input.rules,
		input.createdAt,
	]);
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function plainDescriptors(input: unknown): PropertyDescriptorMap {
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		utilTypes.isProxy(input) ||
		(Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
		Object.getOwnPropertySymbols(input).length > 0
	) {
		throw new TypeError("review envelope must be a plain data object");
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.values(descriptors).some((item) => "get" in item || "set" in item)) {
		throw new TypeError("review envelope must not contain accessors");
	}
	for (const key of Object.keys(descriptors))
		if (!ALLOWED_KEYS.has(key)) throw new TypeError(`unknown envelope field: ${key}`);
	return descriptors;
}

function text(descriptors: PropertyDescriptorMap, key: keyof ReviewEnvelopeInput): string {
	const value = descriptors[key]?.value;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING) {
		throw new TypeError(`${key} must be a bounded non-empty string`);
	}
	return value;
}

export function createReviewEnvelope(input: ReviewEnvelopeInput, reviewAttempt = 1): ReviewEnvelope {
	const fields = plainDescriptors(input);
	const normalized: ReviewEnvelopeInput = {
		taskId: text(fields, "taskId"),
		projectId: text(fields, "projectId"),
		contractHash: text(fields, "contractHash"),
		evidenceRevision: text(fields, "evidenceRevision"),
		gitHead: text(fields, "gitHead").toLowerCase(),
		diffHash: text(fields, "diffHash"),
		advisorPayloadHash: text(fields, "advisorPayloadHash"),
		attempt: fields.attempt?.value,
		trigger: fields.trigger?.value,
		createdAt: text(fields, "createdAt"),
	};
	if (
		!SHA256.test(normalized.contractHash) ||
		!SHA256.test(normalized.evidenceRevision) ||
		!SHA256.test(normalized.diffHash) ||
		!SHA256.test(normalized.advisorPayloadHash)
	) {
		throw new TypeError("review envelope hashes must be canonical sha256 values");
	}
	if (!GIT_HEAD.test(normalized.gitHead)) throw new TypeError("review envelope gitHead is invalid");
	if (!Number.isSafeInteger(normalized.attempt) || normalized.attempt < 1)
		throw new TypeError("review envelope attempt is invalid");
	if (!Number.isSafeInteger(reviewAttempt) || reviewAttempt < 1)
		throw new TypeError("review scheduler attempt is invalid");
	if (normalized.trigger !== "compliance_review") throw new TypeError("review envelope trigger is invalid");
	if (new Date(normalized.createdAt).toISOString() !== normalized.createdAt)
		throw new TypeError("review envelope createdAt is invalid");
	const canonical = JSON.stringify([
		normalized.taskId,
		normalized.projectId,
		normalized.contractHash,
		normalized.evidenceRevision,
		normalized.gitHead,
		normalized.diffHash,
		normalized.advisorPayloadHash,
		normalized.attempt,
		normalized.trigger,
		normalized.createdAt,
		reviewAttempt,
	]);
	const digest = createHash("sha256").update(canonical).digest("hex");
	const dedupeKey = buildReviewDedupeKey({
		trigger: "compliance_review",
		priority: 100,
		projectId: normalized.projectId,
		taskId: normalized.taskId,
		contractHash: normalized.contractHash,
		evidenceRevision: normalized.evidenceRevision,
		gitHead: normalized.gitHead,
		diffHash: normalized.diffHash,
		taskAttempt: normalized.attempt,
	});
	return Object.freeze({
		...normalized,
		contractHash: normalized.contractHash as `sha256:${string}`,
		evidenceRevision: normalized.evidenceRevision as `sha256:${string}`,
		diffHash: normalized.diffHash as `sha256:${string}`,
		advisorPayloadHash: normalized.advisorPayloadHash as `sha256:${string}`,
		reviewId: `review:${dedupeKey.slice("sha256:".length)}:${reviewAttempt}`,
		envelopeHash: `sha256:${digest}`,
	});
}
