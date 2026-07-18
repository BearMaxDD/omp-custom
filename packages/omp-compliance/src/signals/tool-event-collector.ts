/**
 * Tool Event Collector.
 *
 * Listens on the extension's tool_call / tool_result events and stores
 * a correlated, append-only log of every tool interaction for compliance
 * evidence gathering.
 *
 * The collector does NOT intercept or block any tool execution — all
 * handlers return undefined.
 *
 * Correlation:
 *   tool_call events are recorded with a toolCallId.
 *   tool_result events carry the same toolCallId and are matched when
 *   producing the snapshot. Canonical results without a matching call are dropped.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type InvalidXdevReason, classifyToolCallEvent, classifyToolResultEvent } from "../xdev/event-unwrapper";
import type { CanonicalToolIdentity } from "../xdev/tool-identity";
import { normalizeCodebaseMemory } from "./codebase-memory";
import { normalizeTaskDelegation } from "./task-delegation";
import type { EvidenceSnapshot, ToolCallRecord, ToolResultRecord } from "./types";
import { collectVerifications } from "./verification";

interface LegacySyntheticToolCallEvent {
	toolName?: unknown;
	toolCallId?: unknown;
	serverName?: unknown;
	params?: Record<string, unknown>;
	timestamp?: unknown;
	parentToolCallId?: unknown;
	outerToolCallId?: unknown;
}

interface LegacySyntheticToolResultEvent {
	toolName?: unknown;
	toolCallId?: unknown;
	isError?: unknown;
	error?: unknown;
	success?: unknown;
	resultRef?: unknown;
	content?: unknown;
	output?: unknown;
	result?: unknown;
	timestamp?: unknown;
}

function isOfficialToolCallEvent(event: ToolCallEvent | LegacySyntheticToolCallEvent): event is ToolCallEvent {
	return "type" in event && event.type === "tool_call";
}

function isOfficialToolResultEvent(event: ToolResultEvent | LegacySyntheticToolResultEvent): event is ToolResultEvent {
	return "type" in event && event.type === "tool_result";
}

class RetiredCallBloom {
	private static readonly BYTE_SIZE = 1024 * 1024;
	private static readonly HASH_COUNT = 7;
	private readonly bits = new Uint8Array(RetiredCallBloom.BYTE_SIZE);

	add(value: string): void {
		for (const bit of this.hashes(value)) this.bits[bit >>> 3] |= 1 << (bit & 7);
	}

	has(value: string): boolean {
		for (const bit of this.hashes(value)) {
			if ((this.bits[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
		}
		return true;
	}

	private hashes(value: string): number[] {
		let first = 0x811c9dc5;
		let second = 0x9e3779b9;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			first = Math.imul(first ^ code, 0x01000193) >>> 0;
			second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
		}
		second |= 1;
		const bitCount = RetiredCallBloom.BYTE_SIZE * 8;
		return Array.from(
			{ length: RetiredCallBloom.HASH_COUNT },
			(_, index) => (first + Math.imul(index, second)) >>> 0,
		).map((hash) => hash % bitCount);
	}
}

const DETAILS_MAX_BYTES = 16 * 1024;
const DETAILS_MAX_DEPTH = 4;
const DETAILS_MAX_KEYS = 64;
const DETAILS_MAX_ARRAY = 32;
const DETAILS_MAX_STRING = 2 * 1024;
const IDENTIFIER_MAX_BYTES = 256;
const TOOL_NAME_MAX_BYTES = 256;
const SERVER_NAME_MAX_BYTES = 128;
const CWD_MAX_BYTES = 1024;
const SESSION_ID_MAX_BYTES = 256;
const RESULT_REF_MAX_BYTES = 2 * 1024;
const FAILURE_SCAN_MAX_DEPTH = 32;
const FAILURE_SCAN_MAX_NODES = 4096;
const FAILURE_SCAN_MAX_KEYS = 8192;
const DETAILS_PRIORITY_KEYS = [
	"results",
	"async",
	"id",
	"agentId",
	"agent",
	"task",
	"assignment",
	"description",
	"exitCode",
	"exit",
	"code",
	"aborted",
	"cancelled",
	"durationMs",
	"duration",
	"artifacts",
	"outputs",
	"output",
	"outputPath",
	"patchPath",
	"branchName",
];

function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedHashedString(value: string, maxBytes: number, label: string): string {
	if (utf8Length(value) <= maxBytes) return value;
	return `${label}:sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedUtf8(value: string, maxBytes: number, label: string): string {
	if (utf8Length(value) <= maxBytes) return value;
	const digest = createHash("sha256").update(value, "utf8").digest("hex");
	const marker = `...[${label}:sha256:${digest}]`;
	const prefixBudget = maxBytes - utf8Length(marker);
	let prefix = "";
	let used = 0;
	for (const character of value) {
		const bytes = utf8Length(character);
		if (used + bytes > prefixBudget) break;
		prefix += character;
		used += bytes;
	}
	return `${prefix}${marker}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
	let prefix = "";
	let used = 0;
	for (const character of value) {
		const bytes = utf8Length(character);
		if (used + bytes > maxBytes) break;
		prefix += character;
		used += bytes;
	}
	return prefix;
}

function boundedTextContent(content: ReadonlyArray<{ type: string; text?: string }>, maxBytes: number): string {
	const hash = createHash("sha256");
	let prefix = "";
	let prefixBytes = 0;
	let totalBytes = 0;
	let sawText = false;

	for (const item of content) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		for (const fragment of [sawText ? "\n" : "", item.text]) {
			if (!fragment) continue;
			hash.update(fragment, "utf8");
			const bytes = utf8Length(fragment);
			totalBytes += bytes;
			if (prefixBytes < maxBytes) {
				const retained = utf8Prefix(fragment, maxBytes - prefixBytes);
				prefix += retained;
				prefixBytes += utf8Length(retained);
			}
		}
		sawText = true;
	}

	if (!sawText || totalBytes <= maxBytes) return prefix;
	const marker = `...[result:sha256:${hash.digest("hex")}]`;
	return `${utf8Prefix(prefix, maxBytes - utf8Length(marker))}${marker}`;
}

function boundedIdentifier(value: string): string {
	return boundedHashedString(value, IDENTIFIER_MAX_BYTES, "id");
}

function boundedToolName(value: string): string {
	return boundedHashedString(value, TOOL_NAME_MAX_BYTES, "tool");
}

function boundedServerName(value: string): string {
	return boundedHashedString(value, SERVER_NAME_MAX_BYTES, "server");
}

interface SanitizeState {
	valueTruncated: boolean;
	incomplete: boolean;
}

interface DetailSummary {
	details?: Record<string, unknown>;
	truncated: boolean;
	failure: boolean;
}

function boundedStorageKey(value: string, state: SanitizeState): string {
	if (utf8Length(value) <= IDENTIFIER_MAX_BYTES) return value;
	state.incomplete = true;
	return `key:sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedJsonString(value: string, maxBytes: number, state: SanitizeState): string | null {
	const capped = value.slice(0, DETAILS_MAX_STRING);
	if (capped !== value) state.valueTruncated = true;
	let serialized = JSON.stringify(capped);
	if (utf8Length(serialized) <= maxBytes) return serialized;
	state.valueTruncated = true;
	let low = 0;
	let high = capped.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = JSON.stringify(capped.slice(0, middle));
		if (utf8Length(candidate) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	serialized = JSON.stringify(capped.slice(0, low));
	return utf8Length(serialized) <= maxBytes ? serialized : null;
}

function orderedDetailKeys(value: object, state: SanitizeState): string[] {
	const priority = new Map(DETAILS_PRIORITY_KEYS.map((key, index) => [key, index]));
	const keys: string[] = [];
	for (const key of DETAILS_PRIORITY_KEYS) {
		if (Object.hasOwn(value, key)) keys.push(key);
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key) || priority.has(key)) continue;
		if (keys.length >= DETAILS_MAX_KEYS) {
			state.incomplete = true;
			break;
		}
		keys.push(key);
	}
	if (keys.length > DETAILS_MAX_KEYS) {
		state.incomplete = true;
		return keys.slice(0, DETAILS_MAX_KEYS);
	}
	return keys;
}

function sanitizeDetailJson(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
	maxBytes: number,
	state: SanitizeState,
): string | null {
	if (value === null) return maxBytes >= 4 ? "null" : null;
	if (typeof value === "string") return boundedJsonString(value, maxBytes, state);
	if (typeof value === "boolean") {
		const serialized = String(value);
		return utf8Length(serialized) <= maxBytes ? serialized : null;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) state.incomplete = true;
		const serialized = Number.isFinite(value) ? String(value) : JSON.stringify("[Unsupported:number]");
		return utf8Length(serialized) <= maxBytes ? serialized : null;
	}
	if (typeof value !== "object") {
		state.incomplete = true;
		return boundedJsonString(`[Unsupported:${typeof value}]`, maxBytes, state);
	}
	if (utilTypes.isProxy(value)) {
		state.incomplete = true;
		return boundedJsonString("[Proxy]", maxBytes, state);
	}
	if (ancestors.has(value)) {
		state.incomplete = true;
		return boundedJsonString("[Circular]", maxBytes, state);
	}
	if (depth >= DETAILS_MAX_DEPTH) {
		state.incomplete = true;
		return boundedJsonString("[MaxDepth]", maxBytes, state);
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (maxBytes < 2) return null;
			if (value.length > DETAILS_MAX_ARRAY) state.incomplete = true;
			const parts: string[] = [];
			let used = 2;
			const retainedLength = Math.min(value.length, DETAILS_MAX_ARRAY);
			for (let index = 0; index < retainedLength; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					state.incomplete = true;
					break;
				}
				const separatorBytes = parts.length === 0 ? 0 : 1;
				const child = sanitizeDetailJson(
					descriptor.value,
					depth + 1,
					ancestors,
					maxBytes - used - separatorBytes,
					state,
				);
				if (child === null) {
					state.incomplete = true;
					break;
				}
				parts.push(child);
				used += separatorBytes + utf8Length(child);
			}
			return `[${parts.join(",")}]`;
		}

		if (maxBytes < 2) return null;
		const parts: string[] = [];
		let used = 2;
		for (const key of orderedDetailKeys(value, state)) {
			const storedKey = boundedStorageKey(key, state);
			const keyJson = JSON.stringify(storedKey);
			const separatorBytes = parts.length === 0 ? 0 : 1;
			const overhead = separatorBytes + utf8Length(keyJson) + 1;
			if (used + overhead >= maxBytes) {
				state.incomplete = true;
				break;
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			let child: string | null;
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				state.incomplete = true;
				child = boundedJsonString("[Unreadable]", maxBytes - used - overhead, state);
			} else {
				child = sanitizeDetailJson(descriptor.value, depth + 1, ancestors, maxBytes - used - overhead, state);
			}
			if (child === null) {
				state.incomplete = true;
				continue;
			}
			parts.push(`${keyJson}:${child}`);
			used += overhead + utf8Length(child);
		}
		return `{${parts.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

function boundedStructuredRef(value: unknown, maxBytes: number): string {
	const state: SanitizeState = { valueTruncated: false, incomplete: false };
	try {
		return sanitizeDetailJson(value, 0, new Set(), maxBytes, state) ?? "[unserializable]";
	} catch {
		return "[unserializable]";
	}
}

interface FailureScanState {
	remainingNodes: number;
	remainingKeys: number;
	incomplete: boolean;
}

function summarizeFailures(
	value: unknown,
	depth = 0,
	ancestors: Set<object> = new Set(),
	state: FailureScanState = {
		remainingNodes: FAILURE_SCAN_MAX_NODES,
		remainingKeys: FAILURE_SCAN_MAX_KEYS,
		incomplete: false,
	},
): { failure: boolean; incomplete: boolean } {
	if (typeof value !== "object" || value === null) return { failure: false, incomplete: false };
	if (utilTypes.isProxy(value)) {
		state.incomplete = true;
		return { failure: false, incomplete: true };
	}
	if (ancestors.has(value) || depth >= FAILURE_SCAN_MAX_DEPTH) {
		state.incomplete = true;
		return { failure: false, incomplete: true };
	}
	if (state.remainingNodes <= 0) {
		state.incomplete = true;
		return { failure: false, incomplete: true };
	}
	state.remainingNodes--;
	ancestors.add(value);
	let failure = false;
	try {
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (state.remainingKeys <= 0) {
				state.incomplete = true;
				break;
			}
			state.remainingKeys--;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				state.incomplete = true;
				continue;
			}
			const child = descriptor.value;
			if (["exitCode", "exit", "code"].includes(key)) {
				const exitCode =
					typeof child === "number"
						? child
						: typeof child === "string" && child.trim() !== ""
							? Number(child)
							: Number.NaN;
				if (Number.isFinite(exitCode) && exitCode !== 0) failure = true;
			}
			if (["status", "state"].includes(key) && typeof child === "string") {
				if (["failed", "failure", "error", "aborted", "cancelled"].includes(child.toLowerCase())) failure = true;
			}
			if (key === "error" && (child === true || (typeof child === "string" && child.length > 0))) failure = true;
			const nested = summarizeFailures(child, depth + 1, ancestors, state);
			failure ||= nested.failure;
		}
	} catch {
		state.incomplete = true;
	} finally {
		ancestors.delete(value);
	}
	return { failure, incomplete: state.incomplete };
}

export class ToolEventCollector {
	private static readonly MAX_RECORDS = 2048;
	private calls: Map<string, ToolCallRecord> = new Map();
	private results: Map<string, ToolResultRecord> = new Map();
	private canonicalCallIds: Map<string, string> = new Map();
	private callAliases: Map<string, string> = new Map();
	private retired = new RetiredCallBloom();

	/**
	 * Record a tool_call event.
	 *
	 * Accepts a raw event object from the extension system and extracts
	 * the fields relevant for evidence collection. Parameter values are
	 * truncated (keys preserved, values replaced with length / type
	 * indicators) to keep the evidence log compact and avoid leaking
	 * large prompts.
	 */
	recordCall(event: ToolCallEvent | LegacySyntheticToolCallEvent, context?: ExtensionContext): void {
		let toolName: string;
		let toolCallId: string;
		let serverName: string | undefined;
		let input: object;
		let canonicalIdentity: CanonicalToolIdentity | undefined;
		if (isOfficialToolCallEvent(event)) {
			toolName = event.toolName;
			toolCallId = boundedIdentifier(event.toolCallId);
			input = event.input;
		} else {
			// Legacy synthetic events are isolated to internal fixtures and verification recording.
			toolName = String(event.toolName ?? "");
			toolCallId = boundedIdentifier(String(event.toolCallId ?? `${toolName}-${Date.now()}`));
			serverName = event.serverName ? String(event.serverName) : undefined;
			input = event.params ?? {};
		}
		if (utilTypes.isProxy(input)) {
			if (toolName === "write") {
				this.recordInvalidXdev(
					toolCallId,
					"invalid_content",
					context,
					undefined,
					isOfficialToolCallEvent(event) ? "official" : "legacy",
				);
			}
			return;
		}

		const classified = classifyToolCallEvent(event);
		if (classified.kind === "invalid_xdev") {
			this.recordInvalidXdev(
				boundedIdentifier(classified.toolCallId),
				classified.reason,
				context,
				undefined,
				isOfficialToolCallEvent(event) ? "official" : "legacy",
			);
			return;
		}
		if (classified.kind === "valid") {
			const unwrapped = classified.event;
			const observedId = boundedIdentifier(unwrapped.toolCallId);
			const correlationId = boundedIdentifier(unwrapped.correlationId);
			const dedupeKey = this.dedupeKey(correlationId, unwrapped.identity);
			const observedDedupeKey = this.dedupeKey(observedId, unwrapped.identity);
			const aliasKey = this.aliasKey(observedId, unwrapped.identity);
			if (
				this.retired.has(this.retiredDedupeKey(dedupeKey)) ||
				this.retired.has(this.retiredDedupeKey(observedDedupeKey)) ||
				this.retired.has(this.retiredAliasKey(aliasKey))
			) {
				return;
			}
			const existingId = this.canonicalCallIds.get(dedupeKey);
			if (existingId) {
				this.setCanonicalMapping(observedDedupeKey, existingId);
				this.setAlias(aliasKey, existingId);
				if (observedId !== existingId) this.setRawAlias(observedId, existingId);
				return;
			}
			toolCallId = this.availableStorageId(correlationId, unwrapped.identity.argsFingerprint);
			toolName = unwrapped.identity.toolName;
			serverName = "codebase-memory";
			input = unwrapped.identity.args;
			canonicalIdentity = unwrapped.identity;
			this.setCanonicalMapping(dedupeKey, toolCallId);
			this.setCanonicalMapping(observedDedupeKey, toolCallId);
			this.setAlias(aliasKey, toolCallId);
			if (observedId !== toolCallId) this.setRawAlias(observedId, toolCallId);
		} else if (this.isXdevCandidate(toolName, input)) {
			return;
		}
		toolName = boundedToolName(toolName);
		serverName = serverName === undefined ? undefined : boundedServerName(serverName);
		const cwd = context?.cwd === undefined ? undefined : boundedUtf8(context.cwd, CWD_MAX_BYTES, "cwd");
		const rawSessionId = context?.sessionManager.getSessionId();
		const sessionId =
			rawSessionId === undefined ? undefined : boundedHashedString(rawSessionId, SESSION_ID_MAX_BYTES, "session");

		this.calls.set(toolCallId, {
			toolName,
			toolCallId,
			serverName,
			qualifiedName: canonicalIdentity?.qualifiedName,
			argsFingerprint: canonicalIdentity?.argsFingerprint,
			params: this.truncateParams(input),
			cwd,
			sessionId,
			timestamp: new Date().toISOString(),
		});
		this.enforceCallLimit();
	}

	/**
	 * Record a tool_result event.
	 *
	 * Accepts a raw event object and extracts the correlation id, success
	 * indicator, and a result reference string (truncated to avoid storing
	 * large blobs in memory).
	 */
	recordResult(event: ToolResultEvent | LegacySyntheticToolResultEvent, _context?: ExtensionContext): void {
		let toolCallId: string;
		let isError: boolean;
		let resultToolName: string | undefined;
		const source = isOfficialToolResultEvent(event) ? "official" : "legacy";
		if (isOfficialToolResultEvent(event)) {
			toolCallId = boundedIdentifier(event.toolCallId);
			isError = event.isError;
			resultToolName = boundedToolName(event.toolName);
		} else {
			toolCallId = boundedIdentifier(String(event.toolCallId ?? ""));
			isError = event.isError === true || event.success === false;
			resultToolName =
				typeof event.toolName === "string" && event.toolName.length > 0 ? boundedToolName(event.toolName) : undefined;
		}
		let identity: CanonicalToolIdentity | undefined;
		let storageId: string | undefined;
		if (isOfficialToolResultEvent(event)) {
			const callClassification = classifyToolCallEvent({ ...event, type: "tool_call" });
			if (callClassification.kind === "valid") {
				identity = callClassification.event.identity;
				const resultDedupeKey = this.dedupeKey(toolCallId, identity);
				if (this.retired.has(this.retiredDedupeKey(resultDedupeKey))) return;
				storageId = this.canonicalCallIds.get(resultDedupeKey);
				if (!storageId) {
					this.recordCanonicalMismatch(toolCallId, identity);
					return;
				}
				const expectedCall = this.calls.get(storageId);
				if (!expectedCall) return;
				if (identity.qualifiedName !== expectedCall.qualifiedName) {
					this.recordInvalidXdev(toolCallId, "tool_mismatch", undefined, storageId, "official");
					return;
				}
				if (identity.argsFingerprint !== expectedCall.argsFingerprint) {
					this.recordInvalidXdev(toolCallId, "args_mismatch", undefined, storageId, "official");
					return;
				}
				if (identity.transport === "xdev") {
					const resultClassification = classifyToolResultEvent(event, expectedCall.qualifiedName);
					if (resultClassification.kind === "invalid_xdev") {
						this.recordInvalidXdev(toolCallId, resultClassification.reason, undefined, storageId, "official");
						return;
					}
					if (resultClassification.kind !== "valid") return;
				}
			} else {
				// Official non-canonical tools may only correlate by their exact bounded id.
				const exactCall = this.calls.get(toolCallId);
				storageId =
					exactCall && !exactCall.qualifiedName && resultToolName === exactCall.toolName ? toolCallId : undefined;
			}
		} else {
			// Alias fallback is reserved for legacy synthetic fixtures without identity metadata.
			if (
				this.retired.has(this.retiredIdKey(toolCallId)) ||
				this.retired.has(this.retiredAliasKey(this.rawAliasKey(toolCallId)))
			) {
				return;
			}
			storageId = this.findLegacyStorageId(toolCallId);
		}
		if (!storageId) return;
		const expectedCall = this.calls.get(storageId);
		if (!expectedCall) return;
		if (!identity && resultToolName !== undefined && resultToolName !== expectedCall.toolName) return;
		if (
			this.retired.has(this.retiredIdKey(storageId)) ||
			this.retired.has(this.retiredAliasKey(this.rawAliasKey(toolCallId)))
		) {
			return;
		}
		toolCallId = storageId;
		const ref = this.extractResultRef(event);
		const detailSummary = this.extractStructuredDetails(event);

		this.results.set(toolCallId, {
			toolCallId,
			success: !isError,
			resultRef: ref,
			source,
			details: detailSummary.details,
			detailsTruncated: detailSummary.truncated,
			detailsFailure: detailSummary.failure,
			timestamp: new Date().toISOString(),
		});
		this.enforceResultLimit();
	}

	/**
	 * Produce a composite evidence snapshot.
	 *
	 * Walks all stored call/result pairs and runs them through the
	 * module-specific normalizers (codebase-memory, task-delegation,
	 * verification) to produce structured evidence.
	 */
	snapshot(): EvidenceSnapshot {
		const paired: Array<{ call: ToolCallRecord; result?: ToolResultRecord }> = [];
		for (const [id, call] of this.calls) {
			paired.push({ call, result: this.results.get(id) });
		}

		const codebaseMemory = normalizeCodebaseMemory(paired);
		const subagentDelegations = normalizeTaskDelegation(paired);
		const verifications = collectVerifications(paired);

		return {
			calls: Array.from(this.calls.values()),
			results: Array.from(this.results.values()),
			codebaseMemory,
			subagentDelegations,
			verifications,
		};
	}

	/**
	 * Reset all stored events (for test isolation or session boundaries).
	 */
	reset(): void {
		this.calls.clear();
		this.results.clear();
		this.canonicalCallIds.clear();
		this.callAliases.clear();
		this.retired = new RetiredCallBloom();
	}

	/** Remove only graph-derived evidence after the repository index is rebuilt. */
	invalidateCodebaseMemory(): void {
		for (const [storageId, call] of this.calls) {
			if (call.serverName === "codebase-memory") this.evictCall(storageId);
		}
	}

	// ─── Private helpers ────────────────────────────────────────

	private isXdevCandidate(toolName: string, input: object): boolean {
		return (
			toolName === "write" &&
			typeof (input as Record<string, unknown>).path === "string" &&
			((input as Record<string, unknown>).path as string).trim().toLowerCase().startsWith("xd://")
		);
	}

	private dedupeKey(correlationId: string, identity: CanonicalToolIdentity): string {
		return boundedIdentifier(
			`${boundedIdentifier(correlationId)}\u0000${identity.qualifiedName}\u0000${identity.argsFingerprint}`,
		);
	}

	private aliasKey(toolCallId: string, identity: CanonicalToolIdentity): string {
		return boundedIdentifier(
			`${boundedIdentifier(toolCallId)}\u0000${identity.qualifiedName}\u0000${identity.argsFingerprint}`,
		);
	}

	private rawAliasKey(toolCallId: string): string {
		return boundedIdentifier(`raw:${boundedIdentifier(toolCallId)}`);
	}

	private retiredDedupeKey(key: string): string {
		return boundedIdentifier(`dedupe:${boundedIdentifier(key)}`);
	}

	private retiredAliasKey(key: string): string {
		return boundedIdentifier(`alias:${boundedIdentifier(key)}`);
	}

	private retiredIdKey(key: string): string {
		return boundedIdentifier(`id:${boundedIdentifier(key)}`);
	}

	private availableStorageId(correlationId: string, fingerprint: string): string {
		const boundedCorrelationId = boundedIdentifier(correlationId);
		if (!this.calls.has(boundedCorrelationId) && !this.retired.has(this.retiredIdKey(boundedCorrelationId))) {
			return boundedCorrelationId;
		}
		for (let counter = 0; ; counter++) {
			const digest = createHash("sha256")
				.update(boundedCorrelationId, "utf8")
				.update("\u0000")
				.update(fingerprint, "utf8")
				.update("\u0000")
				.update(String(counter), "utf8")
				.digest("hex");
			const candidate = `call:sha256:${digest}`;
			if (!this.calls.has(candidate) && !this.retired.has(this.retiredIdKey(candidate))) return candidate;
		}
	}

	private findLegacyStorageId(toolCallId: string): string | undefined {
		const aliased = this.callAliases.get(this.rawAliasKey(toolCallId));
		if (aliased && this.calls.has(aliased)) return aliased;
		return this.calls.has(toolCallId) ? toolCallId : undefined;
	}

	private recordCanonicalMismatch(toolCallId: string, identity: CanonicalToolIdentity): void {
		const rawCall = this.calls.get(boundedIdentifier(toolCallId));
		if (!rawCall?.qualifiedName || !rawCall.argsFingerprint) return;
		const reason: InvalidXdevReason =
			rawCall.qualifiedName === identity.qualifiedName ? "args_mismatch" : "tool_mismatch";
		// Exact canonical misses never mutate the raw-id call. Keep diagnostics separate.
		this.recordInvalidXdev(toolCallId, reason, undefined, undefined, "official");
	}

	private setCanonicalMapping(key: string, storageId: string): void {
		const boundedKey = boundedIdentifier(key);
		const boundedStorageId = boundedIdentifier(storageId);
		this.canonicalCallIds.set(boundedKey, boundedStorageId);
		while (this.canonicalCallIds.size > ToolEventCollector.MAX_RECORDS) {
			const oldest = this.canonicalCallIds.keys().next().value;
			if (oldest === undefined) break;
			const oldestStorageId = this.canonicalCallIds.get(oldest);
			if (oldestStorageId && this.calls.has(oldestStorageId)) this.evictCall(oldestStorageId);
			else {
				this.canonicalCallIds.delete(oldest);
				this.retired.add(this.retiredDedupeKey(oldest));
			}
		}
	}

	private setAlias(key: string, storageId: string): void {
		this.callAliases.set(key, storageId);
		while (this.callAliases.size > ToolEventCollector.MAX_RECORDS) {
			const oldest = this.callAliases.keys().next().value;
			if (oldest === undefined) break;
			const oldestStorageId = this.callAliases.get(oldest);
			if (oldestStorageId && this.calls.has(oldestStorageId)) {
				this.evictCall(oldestStorageId);
			} else {
				this.callAliases.delete(oldest);
				this.retired.add(this.retiredAliasKey(oldest));
			}
		}
	}

	private setRawAlias(toolCallId: string, storageId: string): void {
		const key = this.rawAliasKey(toolCallId);
		const existing = this.callAliases.get(key);
		if (existing && existing !== storageId) {
			this.callAliases.delete(key);
			return;
		}
		this.setAlias(key, storageId);
	}

	private removeIndexesForStorage(storageId: string, retire: boolean): void {
		for (const [key, value] of this.canonicalCallIds) {
			if (value !== storageId) continue;
			this.canonicalCallIds.delete(key);
			if (retire) this.retired.add(this.retiredDedupeKey(key));
		}
		for (const [key, value] of this.callAliases) {
			if (value !== storageId) continue;
			this.callAliases.delete(key);
			if (retire) this.retired.add(this.retiredAliasKey(key));
		}
		if (retire) this.retired.add(this.retiredIdKey(storageId));
	}

	private evictCall(storageId: string): void {
		this.calls.delete(storageId);
		this.results.delete(storageId);
		this.removeIndexesForStorage(storageId, true);
	}

	private enforceCallLimit(): void {
		while (this.calls.size > ToolEventCollector.MAX_RECORDS) {
			const oldest = this.calls.keys().next().value;
			if (oldest === undefined) break;
			this.evictCall(oldest);
		}
	}

	private enforceResultLimit(): void {
		while (this.results.size > ToolEventCollector.MAX_RECORDS) {
			const oldest = this.results.keys().next().value;
			if (oldest === undefined) break;
			this.results.delete(oldest);
		}
	}

	private recordInvalidXdev(
		toolCallId: string,
		reason: InvalidXdevReason,
		context?: ExtensionContext,
		existingStorageId?: string,
		source: "official" | "legacy" = "legacy",
	): void {
		const storageId = existingStorageId ?? this.availableStorageId(toolCallId, reason);
		if (existingStorageId) this.removeIndexesForStorage(existingStorageId, true);
		const cwd = context?.cwd === undefined ? undefined : boundedUtf8(context.cwd, CWD_MAX_BYTES, "cwd");
		const rawSessionId = context?.sessionManager.getSessionId();
		const sessionId =
			rawSessionId === undefined ? undefined : boundedHashedString(rawSessionId, SESSION_ID_MAX_BYTES, "session");
		this.calls.set(storageId, {
			toolName: "invalid_xdev_event",
			toolCallId: storageId,
			params: { reason },
			cwd,
			sessionId,
			timestamp: new Date().toISOString(),
		});
		this.results.set(storageId, {
			toolCallId: storageId,
			success: false,
			resultRef: reason,
			source,
			details: { reason },
			timestamp: new Date().toISOString(),
		});
		this.enforceCallLimit();
		this.enforceResultLimit();
	}

	/**
	 * Truncate parameter values to a safe summary.
	 *
	 * String values are shortened to the first 80 characters plus length.
	 * Array values are counted. Object values are flattened to their key
	 * count. Primitives pass through unchanged.
	 */
	private truncateParams(params: object): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		const state: SanitizeState = { valueTruncated: false, incomplete: false };
		let count = 0;
		for (const key in params) {
			if (!Object.hasOwn(params, key)) continue;
			if (count >= DETAILS_MAX_KEYS) {
				state.incomplete = true;
				break;
			}
			const storedKey = boundedStorageKey(key, state);
			try {
				result[storedKey] = this.truncateValue((params as Record<string, unknown>)[key]);
			} catch {
				result[storedKey] = "[Unreadable]";
				state.incomplete = true;
			}
			count++;
		}
		const serialized = sanitizeDetailJson(result, 0, new Set(), DETAILS_MAX_BYTES, state);
		if (!serialized) return {};
		try {
			const parsed: unknown = JSON.parse(serialized);
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	private truncateValue(value: unknown): unknown {
		if (typeof value === "string") {
			if (value.length <= 80) return value;
			return `${value.slice(0, 80)}…[+${value.length - 80}]`;
		}
		if (Array.isArray(value)) {
			return `[array:${value.length}]`;
		}
		if (typeof value === "object" && value !== null) {
			let count = 0;
			for (const key in value) {
				if (Object.hasOwn(value, key)) count++;
			}
			return `{object:${count}}`;
		}
		return value;
	}

	/**
	 * Extract a concise reference string from a result event.
	 *
	 * Prefers explicit fields like resultRef / content / output, then
	 * truncates the full result as JSON.
	 */
	private extractResultRef(event: ToolResultEvent | LegacySyntheticToolResultEvent): string {
		if (isOfficialToolResultEvent(event)) {
			const text = boundedTextContent(event.content, RESULT_REF_MAX_BYTES);
			if (text) return boundedUtf8(text, RESULT_REF_MAX_BYTES, "result");
			return boundedStructuredRef(event.details ?? event, RESULT_REF_MAX_BYTES);
		}
		if (typeof event.resultRef === "string") return boundedUtf8(event.resultRef, RESULT_REF_MAX_BYTES, "result");
		if (typeof event.content === "string") {
			return boundedUtf8(event.content, RESULT_REF_MAX_BYTES, "result");
		}
		if (typeof event.output === "string") {
			return boundedUtf8(event.output, RESULT_REF_MAX_BYTES, "result");
		}
		return boundedStructuredRef(event.result ?? event, RESULT_REF_MAX_BYTES);
	}

	private extractStructuredDetails(event: ToolResultEvent | LegacySyntheticToolResultEvent): DetailSummary {
		const value = isOfficialToolResultEvent(event) ? event.details : event.result;
		if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
			return { truncated: true, failure: false };
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { truncated: false, failure: false };
		}
		const state: SanitizeState = { valueTruncated: false, incomplete: false };
		const failureSummary = summarizeFailures(value);
		try {
			const serialized = sanitizeDetailJson(value, 0, new Set(), DETAILS_MAX_BYTES, state);
			if (!serialized) return { truncated: true, failure: failureSummary.failure };
			const parsed: unknown = JSON.parse(serialized);
			return {
				details:
					typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: undefined,
				truncated: state.incomplete || failureSummary.incomplete,
				failure: failureSummary.failure,
			};
		} catch {
			return { truncated: true, failure: failureSummary.failure };
		}
	}
}
