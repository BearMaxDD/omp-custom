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

export class ToolEventCollector {
	private static readonly MAX_RECORDS = 2048;
	private calls: Map<string, ToolCallRecord> = new Map();
	private results: Map<string, ToolResultRecord> = new Map();
	private canonicalCallIds: Map<string, string> = new Map();
	private callAliases: Map<string, string> = new Map();
	private tombstones: Set<string> = new Set();

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
			if (
				this.tombstones.has(this.retiredDedupeKey(dedupeKey)) ||
				this.tombstones.has(this.retiredAliasKey(aliasKey))
			) {
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

		let identity: CanonicalToolIdentity | undefined;
		if (isOfficialToolResultEvent(event) && this.isXdevCandidate(event.toolName, event.input)) {
			const classified = classifyToolResultEvent(event);
			if (classified.kind === "invalid_xdev") {
				const callClassified = classifyToolCallEvent({ ...event, type: "tool_call" });
				const existingId =
					callClassified.kind === "valid"
						? this.resolveStorageId(toolCallId, callClassified.event.identity)
						: (this.callAliases.get(this.rawAliasKey(toolCallId)) ??
							(this.calls.has(toolCallId) ? toolCallId : undefined));
				this.recordInvalidXdev(toolCallId, classified.reason, undefined, existingId);
				return;
			}
			if (classified.kind === "ignored") return;
			identity = classified.event.identity;
		} else if (isOfficialToolResultEvent(event)) {
			const classified = classifyToolCallEvent({ ...event, type: "tool_call" });
			if (classified.kind === "valid") identity = classified.event.identity;
		}

		const resolvedId = identity
			? this.resolveStorageId(toolCallId, identity)
			: (this.callAliases.get(this.rawAliasKey(toolCallId)) ?? toolCallId);
		if (
			this.tombstones.has(this.retiredIdKey(resolvedId)) ||
			this.tombstones.has(this.retiredAliasKey(this.rawAliasKey(toolCallId)))
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
		this.tombstones.clear();
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
				this.addTombstone(this.retiredAliasKey(oldest));
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

	private addTombstone(key: string): void {
		this.tombstones.add(key);
		while (this.tombstones.size > ToolEventCollector.MAX_RECORDS) {
			const oldest = this.tombstones.values().next().value;
			if (oldest === undefined) break;
			this.tombstones.delete(oldest);
		}
	}

	private removeIndexesForStorage(storageId: string, retire: boolean): void {
		for (const [key, value] of this.canonicalCallIds) {
			if (value !== storageId) continue;
			this.canonicalCallIds.delete(key);
			if (retire) this.addTombstone(this.retiredDedupeKey(key));
		}
		for (const [key, value] of this.callAliases) {
			if (value !== storageId) continue;
			this.callAliases.delete(key);
			if (retire) this.addTombstone(this.retiredAliasKey(key));
		}
		if (retire) this.addTombstone(this.retiredIdKey(storageId));
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
			const json = JSON.stringify(event.details ?? event);
			return json.length > 200 ? `${json.slice(0, 200)}…` : json;
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
			const serialized = JSON.stringify(value);
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
