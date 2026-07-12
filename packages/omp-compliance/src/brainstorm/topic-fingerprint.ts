/**
 * Topic Input Normalization and Stable Fingerprint.
 *
 * normalizeTopicInput: validates and normalizes a raw brainstorm topic
 * input — trims strings, deduplicates and sorts lists, enforces length
 * limits, and throws on non-substantive (blank/whitespace-only) fields.
 *
 * computeTopicFingerprint: produces a deterministic SHA-256 hex digest
 * of the normalized input combined with a sorted, deduplicated list of
 * codebase references. Same input + references always produces the same
 * fingerprint; list order and surrounding whitespace do not matter.
 */

import { createHash } from "node:crypto";
import type { BrainstormTopicKind, BrainstormTopicReadyInput } from "./types";

// ─── Field Limits ────────────────────────────────────────────────────

/** Maximum length for the title field. */
const MAX_TITLE = 200;
/** Maximum length for the candidate decision field. */
const MAX_CANDIDATE = 4_000;
/** Maximum length for the discussion summary field. */
const MAX_SUMMARY = 8_000;
/** Maximum number of items per list field (constraints, success criteria, etc.). */
const MAX_LIST_ITEMS = 30;

// ─── Normalization ───────────────────────────────────────────────────

/**
 * Normalize a raw brainstorm topic input for fingerprinting and storage.
 *
 * Processing:
 * 1. Trims all string fields.
 * 2. Trims, deduplicates, and sorts all array fields.
 * 3. Enforces field-specific length limits.
 * 4. Throws on essential fields that are empty or whitespace-only after
 *    trimming (`topicKind`, `title`, `candidateDecision`, `discussionSummary`).
 *
 * @param raw - Partial input; `topicKind` and `codebaseRelevance` must be valid members.
 * @returns A fully normalized `BrainstormTopicReadyInput`.
 * @throws {Error} When a required non-list field is empty/whitespace-only
 *   after trimming. The error message includes the field name.
 */
export function normalizeTopicInput(
	raw: Omit<BrainstormTopicReadyInput, "topicKind" | "codebaseRelevance"> & {
		topicKind: string;
		codebaseRelevance: string;
	},
): BrainstormTopicReadyInput {
	// Validate enum-like fields
	assertValidKind(raw.topicKind);
	assertValidRelevance(raw.codebaseRelevance);

	const topicKind = raw.topicKind as BrainstormTopicKind;
	const codebaseRelevance = raw.codebaseRelevance as BrainstormTopicReadyInput["codebaseRelevance"];

	const title = trimOrThrow(raw.title, "title", MAX_TITLE);
	const candidateDecision = trimOrThrow(raw.candidateDecision, "candidateDecision", MAX_CANDIDATE);
	const discussionSummary = trimOrThrow(raw.discussionSummary, "discussionSummary", MAX_SUMMARY);

	const constraints = normalizeList(raw.constraints, MAX_LIST_ITEMS);
	const successCriteria = normalizeList(raw.successCriteria, MAX_LIST_ITEMS);
	const unresolvedQuestions = normalizeList(raw.unresolvedQuestions, MAX_LIST_ITEMS);

	return {
		topicKind,
		title,
		candidateDecision,
		constraints,
		successCriteria,
		unresolvedQuestions,
		codebaseRelevance,
		discussionSummary,
	};
}

// ─── Fingerprint ─────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 fingerprint for a brainstorm topic.
 *
 * The fingerprint is derived from the normalized input (as produced by
 * `normalizeTopicInput`) combined with a sorted, deduplicated list of
 * codebase references. This means:
 * - List ordering and whitespace around items do NOT change the fingerprint.
 * - Adding, removing, or changing a substantive field DOES change it.
 * - Codebase references are sorted and deduplicated for stability.
 *
 * @param input - A normalized `BrainstormTopicReadyInput`.
 * @param codebaseReferences - Raw codebase reference strings (e.g.
 *   codebase-memory query results). They are sorted and deduplicated internally.
 * @returns A `sha256:<hex>` string suitable for duplicate detection.
 */
export function computeTopicFingerprint(
	input: Parameters<typeof normalizeTopicInput>[0],
	codebaseReferences: string[],
): `sha256:${string}` {
	const normalized = normalizeTopicInput(input);
	const hash = createHash("sha256");

	// Hash the input fields in a stable order
	hash.update(normalized.topicKind);
	hash.update("\0");
	hash.update(normalized.title);
	hash.update("\0");
	hash.update(normalized.candidateDecision);
	hash.update("\0");
	hash.update(normalized.discussionSummary);
	hash.update("\0");
	hash.update(normalized.codebaseRelevance);
	hash.update("\0");

	// Lists are already normalized (sorted, deduped) by normalizeTopicInput
	for (const item of normalized.constraints) {
		hash.update(item);
		hash.update("\0");
	}
	hash.update("\0");
	for (const item of normalized.successCriteria) {
		hash.update(item);
		hash.update("\0");
	}
	hash.update("\0");
	for (const item of normalized.unresolvedQuestions) {
		hash.update(item);
		hash.update("\0");
	}

	// Sort and deduplicate codebase references for stability
	const sortedRefs = [...new Set(codebaseReferences)].sort();
	for (const ref of sortedRefs) {
		hash.update(ref);
		hash.update("\0");
	}

	return `sha256:${hash.digest("hex")}`;
}

// ─── Private Helpers ─────────────────────────────────────────────────

/** Known valid topic kinds. */
const VALID_KINDS: readonly string[] = [
	"architecture",
	"api_design",
	"workflow",
	"tool_selection",
	"refactoring",
	"other",
];

/** Assert that the topic kind is valid. */
function assertValidKind(kind: string): void {
	if (!VALID_KINDS.includes(kind)) {
		throw new Error(`Invalid topicKind: "${kind}"`);
	}
}

/** Known valid codebase relevance values. */
const VALID_RELEVANCE: readonly string[] = ["required", "optional", "none"];

/** Assert that the codebase relevance value is valid. */
function assertValidRelevance(relevance: string): void {
	if (!VALID_RELEVANCE.includes(relevance)) {
		throw new Error(`Invalid codebaseRelevance: "${relevance}"`);
	}
}

/**
 * Trim a string value, throwing if the result is empty.
 * Enforces the given max length.
 */
function trimOrThrow(value: string, fieldName: string, maxLength: number): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`brainstorm ${fieldName} must not be empty or whitespace-only`);
	}
	if (trimmed.length > maxLength) {
		throw new Error(`brainstorm ${fieldName} exceeds maximum length of ${maxLength} characters`);
	}
	return trimmed;
}

/**
 * Normalize a list: trim each item, remove duplicates, sort, and cap
 * at the given maximum number of items.
 */
function normalizeList(items: string[], maxItems: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const item of items) {
		const trimmed = item.trim();
		if (trimmed.length > 0 && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}

	result.sort();
	return result.slice(0, maxItems);
}
