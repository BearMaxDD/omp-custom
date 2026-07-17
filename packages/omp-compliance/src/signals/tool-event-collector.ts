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
import { unwrapToolCallEvent, unwrapToolResultEvent } from "../xdev/event-unwrapper";
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
	private static readonly CORRELATION_CACHE_LIMIT = 2048;
	private calls: Map<string, ToolCallRecord> = new Map();
	private results: Map<string, ToolResultRecord> = new Map();
	private canonicalCallIds: Map<string, string> = new Map();
	private callAliases: Map<string, string> = new Map();

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

		const isXdevCandidate =
			toolName === "write" &&
			typeof (input as Record<string, unknown>).path === "string" &&
			((input as Record<string, unknown>).path as string).trim().toLowerCase().startsWith("xd://");
		const unwrapped = unwrapToolCallEvent(event);
		if (isXdevCandidate && !unwrapped) return;
		if (unwrapped) {
			const dedupeKey = `${unwrapped.correlationId}\u0000${unwrapped.identity.qualifiedName}`;
			const existingId = this.canonicalCallIds.get(dedupeKey);
			if (existingId) {
				this.setBounded(this.callAliases, toolCallId, existingId);
				return;
			}
			// An FQN is an identity hint, not standalone server provenance. It may
			// dedupe against a previously validated xd outer event, but cannot create
			// trusted Evidence without explicit server metadata of its own.
			if (unwrapped.identity.transport === "mcp" && serverName === undefined) {
				this.calls.set(toolCallId, {
					toolName,
					toolCallId,
					params: this.truncateParams(input),
					cwd: context?.cwd,
					sessionId: context?.sessionManager.getSessionId(),
					timestamp: new Date().toISOString(),
				});
				return;
			}
			toolCallId = unwrapped.correlationId;
			toolName = unwrapped.identity.toolName;
			serverName = "codebase-memory";
			input = unwrapped.identity.args;
			this.setBounded(this.canonicalCallIds, dedupeKey, toolCallId);
			this.setBounded(this.callAliases, unwrapped.toolCallId, toolCallId);
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
	}

	/**
	 * Record a tool_result event.
	 *
	 * Accepts a raw event object and extracts the correlation id, success
	 * indicator, and a result reference string (truncated to avoid storing
	 * large blobs in memory).
	 */
	recordResult(event: ToolResultEvent | LegacySyntheticToolResultEvent, _context?: ExtensionContext): void {
		const ref = this.extractResultRef(event);
		const details = this.extractStructuredDetails(event);
		let toolCallId: string;
		let isError: boolean;
		if (isOfficialToolResultEvent(event)) {
			toolCallId = event.toolCallId;
			isError = event.isError;
		} else {
			toolCallId = String(event.toolCallId ?? "");
			isError = event.isError === true || event.success === false;
		}

		const input = isOfficialToolResultEvent(event) ? event.input : undefined;
		const isXdevCandidate =
			(isOfficialToolResultEvent(event) ? event.toolName : undefined) === "write" &&
			typeof input?.path === "string" &&
			input.path.trim().toLowerCase().startsWith("xd://");
		if (isXdevCandidate) {
			const canonicalId = this.callAliases.get(toolCallId) ?? toolCallId;
			const expectedCall = this.calls.get(canonicalId);
			const unwrapped = unwrapToolResultEvent(
				event,
				expectedCall ? `codebase-memory-mcp.${expectedCall.toolName}` : undefined,
			);
			if (!unwrapped) return;
		}
		toolCallId = this.callAliases.get(toolCallId) ?? toolCallId;

		this.results.set(toolCallId, {
			toolCallId,
			success: !isError,
			resultRef: ref,
			details,
			timestamp: new Date().toISOString(),
		});
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
	}

	// ─── Private helpers ────────────────────────────────────────

	private setBounded(map: Map<string, string>, key: string, value: string): void {
		map.set(key, value);
		if (map.size <= ToolEventCollector.CORRELATION_CACHE_LIMIT) return;
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
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
