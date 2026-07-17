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
 *   producing the snapshot. Orphan results are stored but flagged.
 */

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
	return new TextEncoder().encode(value).byteLength;
}

function boundedJsonString(value: string, maxBytes: number): string | null {
	const capped = value.slice(0, DETAILS_MAX_STRING);
	let serialized = JSON.stringify(capped);
	if (utf8Length(serialized) <= maxBytes) return serialized;
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

function orderedDetailKeys(value: object): string[] {
	const keys = Object.keys(value);
	const priority = new Map(DETAILS_PRIORITY_KEYS.map((key, index) => [key, index]));
	return keys
		.sort(
			(left, right) =>
				(priority.get(left) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right) ?? Number.MAX_SAFE_INTEGER),
		)
		.slice(0, DETAILS_MAX_KEYS);
}

function sanitizeDetailJson(value: unknown, depth: number, ancestors: Set<object>, maxBytes: number): string | null {
	if (value === null) return maxBytes >= 4 ? "null" : null;
	if (typeof value === "string") return boundedJsonString(value, maxBytes);
	if (typeof value === "boolean") {
		const serialized = String(value);
		return utf8Length(serialized) <= maxBytes ? serialized : null;
	}
	if (typeof value === "number") {
		const serialized = Number.isFinite(value) ? String(value) : JSON.stringify("[Unsupported:number]");
		return utf8Length(serialized) <= maxBytes ? serialized : null;
	}
	if (typeof value !== "object") return boundedJsonString(`[Unsupported:${typeof value}]`, maxBytes);
	if (ancestors.has(value)) return boundedJsonString("[Circular]", maxBytes);
	if (depth >= DETAILS_MAX_DEPTH) return boundedJsonString("[MaxDepth]", maxBytes);

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (maxBytes < 2) return null;
			const parts: string[] = [];
			let used = 2;
			for (const item of value.slice(0, DETAILS_MAX_ARRAY)) {
				const separatorBytes = parts.length === 0 ? 0 : 1;
				const child = sanitizeDetailJson(item, depth + 1, ancestors, maxBytes - used - separatorBytes);
				if (child === null) break;
				parts.push(child);
				used += separatorBytes + utf8Length(child);
			}
			return `[${parts.join(",")}]`;
		}

		if (maxBytes < 2) return null;
		const parts: string[] = [];
		let used = 2;
		for (const key of orderedDetailKeys(value)) {
			const keyJson = JSON.stringify(key);
			const separatorBytes = parts.length === 0 ? 0 : 1;
			const overhead = separatorBytes + utf8Length(keyJson) + 1;
			if (used + overhead >= maxBytes) break;
			let child: string | null;
			try {
				child = sanitizeDetailJson(
					(value as Record<string, unknown>)[key],
					depth + 1,
					ancestors,
					maxBytes - used - overhead,
				);
			} catch {
				child = boundedJsonString("[Unreadable]", maxBytes - used - overhead);
			}
			if (child === null) continue;
			parts.push(`${keyJson}:${child}`);
			used += overhead + utf8Length(child);
		}
		return `{${parts.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
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
			toolCallId = event.toolCallId;
			input = event.input;
		} else {
			// Legacy synthetic events are isolated to internal fixtures and verification recording.
			toolName = String(event.toolName ?? "");
			toolCallId = String(event.toolCallId ?? `${toolName}-${Date.now()}`);
			serverName = event.serverName ? String(event.serverName) : undefined;
			input = event.params ?? {};
		}

		const classified = classifyToolCallEvent(event);
		if (classified.kind === "invalid_xdev") {
			this.recordInvalidXdev(classified.toolCallId, classified.reason, context);
			return;
		}
		if (classified.kind === "valid") {
			const unwrapped = classified.event;
			const dedupeKey = this.dedupeKey(unwrapped.correlationId, unwrapped.identity);
			const aliasKey = this.aliasKey(unwrapped.toolCallId, unwrapped.identity);
			if (this.retired.has(this.retiredDedupeKey(dedupeKey)) || this.retired.has(this.retiredAliasKey(aliasKey))) {
				return;
			}
			const existingId = this.canonicalCallIds.get(dedupeKey);
			if (existingId) {
				this.setAlias(aliasKey, existingId);
				if (unwrapped.toolCallId !== existingId) this.setRawAlias(unwrapped.toolCallId, existingId);
				return;
			}
			toolCallId = this.availableStorageId(unwrapped.correlationId, unwrapped.identity.argsFingerprint);
			toolName = unwrapped.identity.toolName;
			serverName = "codebase-memory";
			input = unwrapped.identity.args;
			canonicalIdentity = unwrapped.identity;
			this.canonicalCallIds.set(dedupeKey, toolCallId);
			this.setAlias(aliasKey, toolCallId);
			if (unwrapped.toolCallId !== toolCallId) this.setRawAlias(unwrapped.toolCallId, toolCallId);
		} else if (this.isXdevCandidate(toolName, input)) {
			return;
		}

		this.calls.set(toolCallId, {
			toolName,
			toolCallId,
			serverName,
			qualifiedName: canonicalIdentity?.qualifiedName,
			argsFingerprint: canonicalIdentity?.argsFingerprint,
			params: this.truncateParams(input),
			cwd: context?.cwd,
			sessionId: context?.sessionManager.getSessionId(),
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
		if (isOfficialToolResultEvent(event)) {
			toolCallId = event.toolCallId;
			isError = event.isError;
		} else {
			toolCallId = String(event.toolCallId ?? "");
			isError = event.isError === true || event.success === false;
		}
		const existingStorageId = this.findExistingStorageId(toolCallId);
		if (
			!existingStorageId &&
			(this.retired.has(this.retiredIdKey(toolCallId)) ||
				this.retired.has(this.retiredAliasKey(this.rawAliasKey(toolCallId))))
		) {
			return;
		}
		const expectedCall = existingStorageId ? this.calls.get(existingStorageId) : undefined;

		let identity: CanonicalToolIdentity | undefined;
		if (isOfficialToolResultEvent(event) && this.isXdevCandidate(event.toolName, event.input)) {
			const classified = classifyToolResultEvent(event, expectedCall?.qualifiedName);
			if (classified.kind === "invalid_xdev") {
				this.recordInvalidXdev(toolCallId, classified.reason, undefined, existingStorageId);
				return;
			}
			if (classified.kind === "ignored") return;
			identity = classified.event.identity;
			if (expectedCall?.qualifiedName && identity.qualifiedName !== expectedCall.qualifiedName) {
				this.recordInvalidXdev(toolCallId, "tool_mismatch", undefined, existingStorageId);
				return;
			}
			if (expectedCall?.argsFingerprint && identity.argsFingerprint !== expectedCall.argsFingerprint) {
				this.recordInvalidXdev(toolCallId, "args_mismatch", undefined, existingStorageId);
				return;
			}
		} else if (isOfficialToolResultEvent(event)) {
			const classified = classifyToolCallEvent({ ...event, type: "tool_call" });
			if (classified.kind === "valid") identity = classified.event.identity;
		}

		const resolvedId =
			existingStorageId ??
			(identity
				? this.resolveStorageId(toolCallId, identity)
				: (this.callAliases.get(this.rawAliasKey(toolCallId)) ?? toolCallId));
		if (
			this.retired.has(this.retiredIdKey(resolvedId)) ||
			this.retired.has(this.retiredAliasKey(this.rawAliasKey(toolCallId)))
		) {
			return;
		}
		toolCallId = resolvedId;
		const ref = this.extractResultRef(event);
		const details = this.extractStructuredDetails(event);

		this.results.set(toolCallId, {
			toolCallId,
			success: !isError,
			resultRef: ref,
			details,
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

	// ─── Private helpers ────────────────────────────────────────

	private isXdevCandidate(toolName: string, input: object): boolean {
		return (
			toolName === "write" &&
			typeof (input as Record<string, unknown>).path === "string" &&
			((input as Record<string, unknown>).path as string).trim().toLowerCase().startsWith("xd://")
		);
	}

	private dedupeKey(correlationId: string, identity: CanonicalToolIdentity): string {
		return `${correlationId}\u0000${identity.qualifiedName}\u0000${identity.argsFingerprint}`;
	}

	private aliasKey(toolCallId: string, identity: CanonicalToolIdentity): string {
		return `${toolCallId}\u0000${identity.qualifiedName}\u0000${identity.argsFingerprint}`;
	}

	private rawAliasKey(toolCallId: string): string {
		return `raw:${toolCallId}`;
	}

	private retiredDedupeKey(key: string): string {
		return `dedupe:${key}`;
	}

	private retiredAliasKey(key: string): string {
		return `alias:${key}`;
	}

	private retiredIdKey(key: string): string {
		return `id:${key}`;
	}

	private availableStorageId(correlationId: string, fingerprint: string): string {
		if (!this.calls.has(correlationId)) return correlationId;
		const base = `${correlationId}#${fingerprint.slice("sha256:".length, "sha256:".length + 12)}`;
		let candidate = base;
		let suffix = 1;
		while (this.calls.has(candidate)) candidate = `${base}-${suffix++}`;
		return candidate;
	}

	private resolveStorageId(toolCallId: string, identity: CanonicalToolIdentity): string {
		const aliasKey = this.aliasKey(toolCallId, identity);
		return (
			this.callAliases.get(aliasKey) ??
			this.canonicalCallIds.get(this.dedupeKey(toolCallId, identity)) ??
			this.callAliases.get(this.rawAliasKey(toolCallId)) ??
			toolCallId
		);
	}

	private findExistingStorageId(toolCallId: string): string | undefined {
		const aliased = this.callAliases.get(this.rawAliasKey(toolCallId));
		if (aliased && this.calls.has(aliased)) return aliased;
		return this.calls.has(toolCallId) ? toolCallId : undefined;
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
	): void {
		const storageId = existingStorageId ?? this.availableStorageId(toolCallId, reason);
		if (existingStorageId) this.removeIndexesForStorage(existingStorageId, true);
		this.calls.set(storageId, {
			toolName: "invalid_xdev_event",
			toolCallId: storageId,
			params: { reason },
			cwd: context?.cwd,
			sessionId: context?.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
		this.results.set(storageId, {
			toolCallId: storageId,
			success: false,
			resultRef: reason,
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
		for (const [key, value] of Object.entries(params)) {
			result[key] = this.truncateValue(value);
		}
		return result;
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
			return `{object:${Object.keys(value).length}}`;
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
			const text = event.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			if (text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
			try {
				const json = JSON.stringify(event.details ?? event) ?? "[undefined]";
				return json.length > 200 ? `${json.slice(0, 200)}…` : json;
			} catch {
				return "[unserializable]";
			}
		}
		if (typeof event.resultRef === "string") return event.resultRef;
		if (typeof event.content === "string") {
			return event.content.length > 200 ? `${event.content.slice(0, 200)}…` : event.content;
		}
		if (typeof event.output === "string") {
			return event.output.length > 200 ? `${event.output.slice(0, 200)}…` : event.output;
		}
		try {
			const json = JSON.stringify(event.result ?? event) ?? "[undefined]";
			return json.length > 200 ? `${json.slice(0, 200)}…` : json;
		} catch {
			return "[unserializable]";
		}
	}

	private extractStructuredDetails(
		event: ToolResultEvent | LegacySyntheticToolResultEvent,
	): Record<string, unknown> | undefined {
		const value = isOfficialToolResultEvent(event) ? event.details : event.result;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		try {
			const serialized = sanitizeDetailJson(value, 0, new Set(), DETAILS_MAX_BYTES);
			if (!serialized) return undefined;
			const parsed: unknown = JSON.parse(serialized);
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}
}
