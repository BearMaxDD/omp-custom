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

import { normalizeCodebaseMemory } from "./codebase-memory";
import { normalizeTaskDelegation } from "./task-delegation";
import type { EvidenceSnapshot, ToolCallRecord, ToolResultRecord } from "./types";
import { collectVerifications } from "./verification";

export class ToolEventCollector {
	private calls: Map<string, ToolCallRecord> = new Map();
	private results: Map<string, ToolResultRecord> = new Map();

	/**
	 * Record a tool_call event.
	 *
	 * Accepts a raw event object from the extension system and extracts
	 * the fields relevant for evidence collection. Parameter values are
	 * truncated (keys preserved, values replaced with length / type
	 * indicators) to keep the evidence log compact and avoid leaking
	 * large prompts.
	 */
	recordCall(event: Record<string, unknown>): void {
		const toolName = String(event.toolName ?? event.name ?? "");
		const toolCallId = String(event.toolCallId ?? event.id ?? `${toolName}-${Date.now()}`);
		const serverName = event.serverName ? String(event.serverName) : undefined;
		const rawParams = (event.params ?? event.arguments ?? {}) as Record<string, unknown>;

		this.calls.set(toolCallId, {
			toolName,
			toolCallId,
			serverName,
			params: this.truncateParams(rawParams),
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
	recordResult(event: Record<string, unknown>): void {
		const ref = this.extractResultRef(event);
		const toolCallId = String(event.toolCallId ?? event.id ?? "");
		const isError = event.isError === true || event.error != null;

		this.results.set(toolCallId, {
			toolCallId,
			success: !isError,
			resultRef: ref,
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
	}

	// ─── Private helpers ────────────────────────────────────────

	/**
	 * Truncate parameter values to a safe summary.
	 *
	 * String values are shortened to the first 80 characters plus length.
	 * Array values are counted. Object values are flattened to their key
	 * count. Primitives pass through unchanged.
	 */
	private truncateParams(params: Record<string, unknown>): Record<string, unknown> {
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
	private extractResultRef(event: Record<string, unknown>): string {
		if (typeof event.resultRef === "string") return event.resultRef;
		if (typeof event.content === "string") {
			return event.content.length > 200 ? `${event.content.slice(0, 200)}…` : event.content;
		}
		if (typeof event.output === "string") {
			return event.output.length > 200 ? `${event.output.slice(0, 200)}…` : event.output;
		}
		try {
			const json = JSON.stringify(event.result ?? event);
			return json.length > 200 ? `${json.slice(0, 200)}…` : json;
		} catch {
			return "[unserializable]";
		}
	}
}
