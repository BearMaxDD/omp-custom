/** Normalize official v17 task and hub evidence into one supervised delegation lifecycle. */

import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type { JobSnapshot } from "@oh-my-pi/pi-coding-agent/tools/hub/types";
import {
	type DelegationRecord,
	type TrustedDelegationContext,
	applyDelegationEvent,
	createDelegationCompletionAttestation,
	getTrustedDelegationActualFiles,
	isTrustedDelegationContext,
} from "../delegation/delegation-supervisor";
import type { TaskDelegationEvidence, ToolCallRecord, ToolResultRecord } from "./types";

const TASK_TOOL_NAME = "task";
const HUB_TOOL_NAME = "hub";
const MAX_ITEMS = 512;
const MAX_ID_BYTES = 256;
const MAX_STRING_BYTES = 4096;

export interface DelegationBinding {
	readonly delegationId: string;
	readonly transport: "task" | "hub";
	readonly originalToolCallId: string;
	readonly jobId?: string;
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly actualFiles?: readonly string[];
}

export interface TrustedDelegationNormalizationContext {
	readonly delegation: TrustedDelegationContext;
	readonly bindings: readonly DelegationBinding[];
}

const trustedNormalizationContexts = new WeakSet<object>();
const trustedNormalizedEvents = new WeakSet<object>();

export function createTrustedDelegationNormalizationContext(
	delegation: TrustedDelegationContext,
	bindings: readonly DelegationBinding[],
): TrustedDelegationNormalizationContext {
	if (!isTrustedDelegationContext(delegation)) throw new TypeError("invalid_trusted_delegation_context");
	const normalized = safeArrayValues(bindings, "delegation_bindings").map((binding) => {
		if (!isPlainRecord(binding)) throw new TypeError("invalid_delegation_binding");
		if (binding.transport !== "task" && binding.transport !== "hub") {
			throw new TypeError("invalid_delegation_binding_transport");
		}
		const transport = binding.transport as DelegationBinding["transport"];
		const actualFiles =
			binding.actualFiles === undefined
				? undefined
				: boundedStringArray(binding.actualFiles, "binding_actual_files", 1024);
		const attestedActualFiles = getTrustedDelegationActualFiles(delegation, String(binding.delegationId));
		if (actualFiles !== undefined && !sameStrings(actualFiles, attestedActualFiles)) {
			throw new TypeError("untrusted_delegation_actual_files");
		}
		return {
			delegationId: boundedString(binding.delegationId, "binding_delegation_id", MAX_ID_BYTES),
			transport,
			originalToolCallId: boundedString(binding.originalToolCallId, "binding_tool_call_id", MAX_ID_BYTES),
			...(binding.jobId === undefined ? {} : { jobId: boundedString(binding.jobId, "binding_job_id", MAX_ID_BYTES) }),
			...(binding.agentId === undefined
				? {}
				: { agentId: boundedString(binding.agentId, "binding_agent_id", MAX_ID_BYTES) }),
			...(binding.sessionId === undefined
				? {}
				: { sessionId: boundedString(binding.sessionId, "binding_session_id", MAX_ID_BYTES) }),
			...(attestedActualFiles === undefined ? {} : { actualFiles: attestedActualFiles }),
		};
	});
	const context = deepFreeze({ delegation, bindings: normalized });
	trustedNormalizationContexts.add(context);
	return context;
}

export interface NormalizedDelegationEvent {
	readonly delegationId: string;
	readonly agentId?: string;
	readonly jobId?: string;
	readonly sessionId?: string;
	readonly toolCallId: string;
	readonly originToolCallId: string;
	readonly resultToolCallId?: string;
	readonly transport: "task" | "hub";
	readonly status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
	readonly workPackage?: string;
	readonly actualFilesKnown: boolean;
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
	readonly completionAttestation?: ReturnType<typeof createDelegationCompletionAttestation>;
}

/** Normalize only official structured task/hub results into supervision events. */
export function normalizeDelegationEvents(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
	context?: TrustedDelegationNormalizationContext,
): NormalizedDelegationEvent[] {
	try {
		const pairs = safeArrayValues(paired, "delegation_pairs");
		if (context !== undefined && !trustedNormalizationContexts.has(context)) return [];
		const events: NormalizedDelegationEvent[] = [];
		for (const rawPair of pairs) {
			try {
				if (!isPlainRecord(rawPair) || !isToolCallRecord(rawPair.call)) continue;
				const pair = rawPair as { call: ToolCallRecord; result?: ToolResultRecord };
				if (
					pair.result !== undefined &&
					(!isToolResultRecord(pair.result) || pair.result.toolCallId !== pair.call.toolCallId)
				) {
					continue;
				}
				if (pair.call.toolName === TASK_TOOL_NAME) {
					events.push(...normalizeTaskEvents(pair.call, pair.result, context));
				}
				if (pair.call.toolName === HUB_TOOL_NAME) {
					events.push(...normalizeHubEvents(pair.call, pair.result, context));
				}
			} catch {}
		}
		return deepFreeze(events);
	} catch {
		return [];
	}
}

export function applyNormalizedDelegationEvents(
	record: DelegationRecord,
	events: readonly NormalizedDelegationEvent[],
): DelegationRecord {
	let current = record;
	let normalizedEvents: unknown[];
	try {
		normalizedEvents = safeArrayValues(events, "normalized_delegation_events");
	} catch {
		return current;
	}
	for (const rawEvent of normalizedEvents) {
		if (!isPlainRecord(rawEvent) || !trustedNormalizedEvents.has(rawEvent)) continue;
		const event = rawEvent as unknown as NormalizedDelegationEvent;
		if (
			event.delegationId !== current.delegationId ||
			event.agentId !== current.agentId ||
			event.sessionId !== current.sessionId ||
			event.transport !== current.transport ||
			event.originToolCallId !== current.toolCallId
		)
			continue;
		if (event.status === "queued") continue;
		if (event.status !== "running" && (!event.resultToolCallId || event.resultToolCallId !== event.toolCallId))
			continue;
		if (current.status === "queued") {
			current = applyDelegationEvent(current, { delegationId: event.delegationId, type: "started" });
		}
		if (event.status === "running") continue;
		if (event.status === "completed") {
			if (!event.completionAttestation) continue;
			current = applyDelegationEvent(current, event.completionAttestation);
		} else {
			current = applyDelegationEvent(current, { delegationId: event.delegationId, type: event.status });
		}
	}
	return current;
}

/**
 * Normalize paired call/result entries into task delegation evidence.
 *
 * Filters to entries whose toolName === "task" and produces structured
 * evidence records. Batch calls can produce one entry per result plus an
 * asynchronous call-level placeholder while background work is unresolved.
 */
export function normalizeTaskDelegation(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
): TaskDelegationEvidence[] {
	const results: TaskDelegationEvidence[] = [];
	let pairs: unknown[];
	try {
		pairs = safeArrayValues(paired, "task_delegation_pairs");
	} catch {
		return [];
	}

	for (const rawPair of pairs) {
		try {
			if (!isPlainRecord(rawPair)) continue;
			const call = rawPair.call;
			const result = rawPair.result;
			if (!isToolCallRecord(call) || (result !== undefined && !isToolResultRecord(result))) continue;
			if (result !== undefined && result.toolCallId !== call.toolCallId) continue;
			if (call.toolName !== TASK_TOOL_NAME) continue;

			if (!result) {
				// Call with no result → insufficient evidence
				results.push({
					status: "insufficient",
					taskSummary: extractTaskSummary(call.params),
					outputArtifacts: [],
					codebaseRefs: [],
				});
				continue;
			}

			if (!result.success) {
				// Error result → insufficient evidence
				results.push({
					status: "insufficient",
					taskSummary: extractTaskSummary(call.params),
					outputArtifacts: [],
					codebaseRefs: [],
				});
				continue;
			}

			if (result.detailsTruncated || (result.source === "official" && !isTaskToolDetails(result.details ?? {}))) {
				results.push(emptyEvidence(call, result.detailsFailure ? "aborted" : "insufficient"));
				continue;
			}

			// Official v17 Task evidence is structured-only. Text fallback is legacy-fixture compatibility.
			const details =
				result.source === "official"
					? (result.details ?? {})
					: { ...parseResultDetails(result.resultRef), ...result.details };
			if (isTaskToolDetails(details)) {
				const asyncDetails = readRecord(details.async);
				if (details.results.length === 0) {
					results.push(asyncEvidence(call, asyncDetails));
					continue;
				}

				const evidenceCount = results.length;
				for (const value of details.results) {
					const single = readRecord(value);
					if (!single) continue;
					const exitCode = toFiniteNumber(single.exitCode);
					const aborted = single.aborted === true || hasNonEmptyString(single.error);
					const outputArtifacts = collectOutputArtifacts(single);
					const codebaseRefs = extractCodebaseRefs(`${outputArtifacts.join(" ")} ${safeStringify(single)}`);

					results.push({
						agentId: toOptionalString(single.id),
						agent: toOptionalString(single.agent),
						taskSummary: extractSingleResultSummary(single) ?? extractTaskSummary(call.params),
						status: !aborted && exitCode === 0 ? "completed" : "aborted",
						durationMs: toFiniteNumber(single.durationMs),
						exitCode,
						outputArtifacts,
						codebaseRefs,
					});
				}
				if (results.length === evidenceCount) results.push(emptyEvidence(call, "insufficient"));
				if (asyncDetails?.state === "running" || asyncDetails?.state === "failed") {
					results.push(asyncEvidence(call, asyncDetails));
				}
				continue;
			}

			const agentId = details.agentId ?? details.agent ?? call.params.agent ?? call.params.name;
			const exitCode = details.exitCode ?? details.exit ?? details.code;
			const aborted = details.aborted ?? details.cancelled ?? false;
			const durationMs = details.durationMs ?? details.duration;
			const outputArtifacts = collectOutputArtifacts(details);

			// Extract codebase references from output text
			const codebaseRefs = extractCodebaseRefs(
				`${outputArtifacts.join(" ")} ${JSON.stringify(details)} ${result.resultRef}`,
			);

			results.push({
				agentId: agentId != null ? String(agentId) : undefined,
				taskSummary: extractTaskSummary(call.params),
				status: aborted ? "aborted" : exitCode === 0 ? "completed" : "aborted",
				durationMs: durationMs != null ? Number(durationMs) : undefined,
				exitCode: exitCode != null ? Number(exitCode) : undefined,
				outputArtifacts,
				codebaseRefs,
			});
		} catch {}
	}

	return results;
}

function normalizeTaskEvents(
	call: ToolCallRecord,
	result?: ToolResultRecord,
	context?: TrustedDelegationNormalizationContext,
): NormalizedDelegationEvent[] {
	const callBindings =
		context?.bindings.filter(
			(binding) => binding.transport === "task" && binding.originalToolCallId === call.toolCallId,
		) ?? [];
	if (!result) {
		const bindings =
			callBindings.length > 0
				? callBindings
				: [
						{
							delegationId: call.toolCallId,
							transport: "task" as const,
							originalToolCallId: call.toolCallId,
						},
					];
		return bindings.map((binding) =>
			delegationEvent(call, binding, "queued", extractTaskSummary(call.params), [], context?.delegation),
		);
	}
	if (
		!result.success ||
		result.source !== "official" ||
		result.detailsTruncated ||
		!result.details ||
		!isTaskToolDetails(result.details)
	)
		return [];

	const evidenceIds = [`tool-result:${result.toolCallId}`];
	const events: NormalizedDelegationEvent[] = [];
	for (const [index, value] of result.details.results.entries()) {
		const single = readRecord(value);
		if (!single) continue;
		const agentId = toOptionalString(single.id);
		if (!agentId) continue;
		const binding = callBindings.find((candidate) => candidate.agentId === agentId) ??
			callBindings[index] ?? {
				delegationId: result.details.results.length === 1 ? call.toolCallId : `${call.toolCallId}:${index}`,
				transport: "task" as const,
				originalToolCallId: call.toolCallId,
				agentId,
			};
		const summary = extractSingleResultSummary(single) ?? extractTaskSummary(call.params);
		events.push(delegationEvent(call, binding, "running", summary, [], context?.delegation));
		events.push(
			delegationEvent(
				call,
				binding,
				taskResultStatus(single, result.success),
				summary,
				evidenceIds,
				context?.delegation,
			),
		);
	}

	const asyncDetails = readRecord(result.details.async);
	const jobId = toOptionalString(asyncDetails?.jobId);
	if (events.length === 0 && jobId && (asyncDetails?.state === "running" || asyncDetails?.state === "failed")) {
		const binding = callBindings.find((candidate) => candidate.jobId === jobId) ??
			callBindings[0] ?? {
				delegationId: call.toolCallId,
				transport: "task" as const,
				originalToolCallId: call.toolCallId,
				jobId,
			};
		events.push(
			delegationEvent(
				call,
				binding,
				asyncDetails.state === "running" ? "running" : "failed",
				extractTaskSummary(call.params),
				evidenceIds,
				context?.delegation,
			),
		);
	}
	return events;
}

function normalizeHubEvents(
	call: ToolCallRecord,
	result: ToolResultRecord | undefined,
	context: TrustedDelegationNormalizationContext | undefined,
): NormalizedDelegationEvent[] {
	if (
		!context ||
		!result?.success ||
		result.source !== "official" ||
		result.detailsTruncated ||
		!result.details ||
		!isHubJobDetails(result.details)
	)
		return [];

	const evidenceIds = [`tool-result:${result.toolCallId}`];
	const events: NormalizedDelegationEvent[] = [];
	for (const job of result.details.jobs) {
		if (job.type !== "task") continue;
		const binding = context.bindings.find((candidate) => candidate.transport === "hub" && candidate.jobId === job.id);
		if (!binding) continue;
		events.push(delegationEvent(call, binding, hubJobStatus(job), job.label, evidenceIds, context.delegation));
	}
	return events;
}

function delegationEvent(
	call: ToolCallRecord,
	binding: DelegationBinding,
	status: NormalizedDelegationEvent["status"],
	workPackage: string | undefined,
	toolEvidenceIds: readonly string[],
	context?: TrustedDelegationContext,
): NormalizedDelegationEvent {
	const resultToolCallId = status === "queued" || status === "running" ? undefined : call.toolCallId;
	const completionAttestation =
		status === "completed" && context
			? createDelegationCompletionAttestation(context, {
					delegationId: binding.delegationId,
					originToolCallId: binding.originalToolCallId,
					resultToolCallId: call.toolCallId,
					toolEvidenceIds,
				})
			: undefined;
	const event = deepFreeze({
		delegationId: binding.delegationId,
		...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
		...(binding.jobId === undefined ? {} : { jobId: binding.jobId }),
		...((binding.sessionId ?? call.sessionId) === undefined ? {} : { sessionId: binding.sessionId ?? call.sessionId }),
		toolCallId: call.toolCallId,
		originToolCallId: binding.originalToolCallId,
		...(resultToolCallId === undefined ? {} : { resultToolCallId }),
		transport: binding.transport,
		status,
		...(workPackage === undefined
			? {}
			: { workPackage: boundedString(workPackage, "delegation_work_package", MAX_STRING_BYTES) }),
		actualFilesKnown: completionAttestation?.actualFilesKnown ?? false,
		actualFiles: completionAttestation?.actualFiles ?? [],
		toolEvidenceIds: boundedStringArray(toolEvidenceIds, "delegation_tool_evidence", MAX_STRING_BYTES),
		...(completionAttestation === undefined ? {} : { completionAttestation }),
	});
	trustedNormalizedEvents.add(event);
	return event;
}

function taskResultStatus(
	result: Record<string, unknown>,
	toolSucceeded: boolean,
): NormalizedDelegationEvent["status"] {
	const reason = toOptionalString(result.abortReason)?.toLowerCase() ?? "";
	if (reason.includes("timed out") || reason.includes("timeout")) return "timed_out";
	if (!toolSucceeded || hasNonEmptyString(result.error) || toFiniteNumber(result.exitCode) !== 0) return "failed";
	if (result.aborted !== true) return "completed";
	return reason.includes("cancel") ? "cancelled" : "failed";
}

function hubJobStatus(job: JobSnapshot): NormalizedDelegationEvent["status"] {
	if (job.status === "failed" && /timed?\s*out|timeout/i.test(job.errorText ?? "")) return "timed_out";
	return job.status;
}

function isHubJobDetails(
	details: Record<string, unknown>,
): details is Record<string, unknown> & { jobs: JobSnapshot[] } {
	if (!Array.isArray(details.jobs) || details.jobs.length > MAX_ITEMS) return false;
	return details.jobs.every((value) => {
		const job = readRecord(value);
		return (
			job !== undefined &&
			isNonEmptyString(job.id) &&
			(job.type === "task" || job.type === "bash") &&
			(job.status === "running" ||
				job.status === "completed" ||
				job.status === "failed" ||
				job.status === "cancelled") &&
			isNonEmptyString(job.label) &&
			isFiniteNumber(job.durationMs) &&
			(job.errorText === undefined || typeof job.errorText === "string")
		);
	});
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse result details from a result reference string.
 *
 * Tries JSON parse first; falls back to interpreting the string
 * as raw text. Returns parsed fields or empty object.
 */
function parseResultDetails(ref: string): Record<string, unknown> {
	if (!ref) return {};
	try {
		const parsed = JSON.parse(ref);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return { output: ref };
	} catch {
		// Not JSON — return as raw output
		return { output: ref };
	}
}

function collectOutputArtifacts(details: Record<string, unknown>): string[] {
	const artifacts: string[] = [];
	for (const value of [
		details.artifacts,
		details.outputs,
		details.output,
		details.outputPath,
		details.patchPath,
		details.branchName,
	]) {
		if (Array.isArray(value)) {
			if (value.length > MAX_ITEMS) return [];
			artifacts.push(...value.filter((item): item is string => typeof item === "string").slice(0, MAX_ITEMS));
		} else if (typeof value === "string") {
			artifacts.push(value);
		}
	}
	return [...new Set(artifacts.filter((value) => Buffer.byteLength(value) <= MAX_STRING_BYTES))].slice(0, MAX_ITEMS);
}

const AGENT_SOURCES = new Set(["bundled", "user", "project"]);

function isTaskToolDetails(
	details: Record<string, unknown>,
): details is Record<string, unknown> & { results: unknown[] } {
	if (
		!(details.projectAgentsDir === null || typeof details.projectAgentsDir === "string") ||
		!Array.isArray(details.results) ||
		details.results.length > MAX_ITEMS ||
		!isFiniteNumber(details.totalDurationMs)
	) {
		return false;
	}
	if (details.outputPaths !== undefined && !isStringArray(details.outputPaths)) return false;
	if (details.async !== undefined && !isTaskAsyncDetails(details.async)) return false;
	return details.results.every(isSingleResult);
}

function isSingleResult(value: unknown): value is Record<string, unknown> {
	const result = readRecord(value);
	if (!result) return false;
	if (
		!isFiniteNumber(result.index) ||
		!isBoundedString(result.id, MAX_ID_BYTES) ||
		!isBoundedString(result.agent, MAX_ID_BYTES) ||
		!AGENT_SOURCES.has(String(result.agentSource)) ||
		!isBoundedString(result.task, MAX_STRING_BYTES) ||
		!isFiniteNumber(result.exitCode) ||
		!isStringWithinLimit(result.output, MAX_STRING_BYTES) ||
		!isStringWithinLimit(result.stderr, MAX_STRING_BYTES) ||
		typeof result.truncated !== "boolean" ||
		!isFiniteNumber(result.durationMs) ||
		!isFiniteNumber(result.tokens) ||
		!isFiniteNumber(result.requests)
	) {
		return false;
	}
	for (const key of [
		"assignment",
		"description",
		"lastIntent",
		"error",
		"abortReason",
		"outputPath",
		"patchPath",
		"branchName",
		"branchBaseSha",
		"resolvedModel",
	] as const) {
		if (result[key] !== undefined && !isStringWithinLimit(result[key], MAX_STRING_BYTES)) return false;
	}
	if (result.aborted !== undefined && typeof result.aborted !== "boolean") return false;
	if (result.modelOverride !== undefined && !isStringOrStringArray(result.modelOverride)) return false;
	return true;
}

function isTaskAsyncDetails(value: unknown): boolean {
	const details = readRecord(value);
	return (
		details !== undefined &&
		["running", "completed", "failed"].includes(String(details.state)) &&
		isNonEmptyString(details.jobId) &&
		details.type === "task"
	);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ITEMS &&
		value.every((item) => typeof item === "string" && Buffer.byteLength(item) <= MAX_STRING_BYTES)
	);
}

function isStringOrStringArray(value: unknown): boolean {
	return isStringWithinLimit(value, MAX_STRING_BYTES) || isStringArray(value);
}

function isStringWithinLimit(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && Buffer.byteLength(value) <= maxBytes;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return isPlainRecord(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	try {
		return (
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
		);
	} catch {
		return false;
	}
}

function isToolCallRecord(value: unknown): value is ToolCallRecord {
	const record = readRecord(value);
	return (
		record !== undefined &&
		isBoundedString(record.toolName, MAX_ID_BYTES) &&
		isBoundedString(record.toolCallId, MAX_ID_BYTES) &&
		isPlainRecord(record.params) &&
		(record.sessionId === undefined || isBoundedString(record.sessionId, MAX_ID_BYTES)) &&
		isBoundedString(record.timestamp, MAX_STRING_BYTES)
	);
}

function isToolResultRecord(value: unknown): value is ToolResultRecord {
	const record = readRecord(value);
	return (
		record !== undefined &&
		isBoundedString(record.toolCallId, MAX_ID_BYTES) &&
		typeof record.success === "boolean" &&
		typeof record.resultRef === "string" &&
		Buffer.byteLength(record.resultRef) <= MAX_STRING_BYTES &&
		(record.source === undefined || record.source === "official" || record.source === "legacy") &&
		(record.details === undefined || isPlainRecord(record.details)) &&
		(record.detailsTruncated === undefined || typeof record.detailsTruncated === "boolean") &&
		(record.detailsFailure === undefined || typeof record.detailsFailure === "boolean") &&
		isBoundedString(record.timestamp, MAX_STRING_BYTES)
	);
}

function boundedStringArray(values: unknown, label: string, maxBytes: number): string[] {
	return [...new Set(safeArrayValues(values, label).map((value) => boundedString(value, label, maxBytes)))];
}

function safeArrayValues(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || utilTypes.isProxy(value)) throw new TypeError(`invalid_${label}`);
	try {
		if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ITEMS) {
			throw new TypeError(`invalid_${label}`);
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const values: unknown[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !("value" in descriptor)) throw new TypeError(`invalid_${label}`);
			values.push(descriptor.value);
		}
		return values;
	} catch (error) {
		if (error instanceof TypeError && error.message === `invalid_${label}`) throw error;
		throw new TypeError(`invalid_${label}`);
	}
}

function sameStrings(left: readonly string[], right: readonly string[] | undefined): boolean {
	return right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
	if (!isBoundedString(value, maxBytes)) throw new TypeError(`invalid_${label}`);
	return value;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function hasNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function extractSingleResultSummary(result: Record<string, unknown>): string | undefined {
	for (const value of [result.assignment, result.task, result.description]) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function emptyEvidence(call: ToolCallRecord, status: TaskDelegationEvidence["status"]): TaskDelegationEvidence {
	return {
		status,
		taskSummary: extractTaskSummary(call.params),
		outputArtifacts: [],
		codebaseRefs: [],
	};
}

function asyncEvidence(call: ToolCallRecord, asyncDetails?: Record<string, unknown>): TaskDelegationEvidence {
	return {
		...emptyEvidence(call, asyncDetails?.state === "failed" ? "aborted" : "insufficient"),
		jobId: toOptionalString(asyncDetails?.jobId),
	};
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/**
 * Extract a short task summary from the call parameters.
 *
 * Looks for assignment, task, description, or name fields in order.
 */
function extractTaskSummary(params: Record<string, unknown>): string | undefined {
	const summary = String(params.assignment ?? params.task ?? params.description ?? params.name ?? "");
	return summary || undefined;
}

/**
 * Extract codebase file references from a text blob.
 *
 * Matches file paths with known extensions.
 */
function extractCodebaseRefs(text: string): string[] {
	if (!text) return [];
	const refs: string[] = [];
	const refPattern = /[\w./-]+\.[a-z]+(?::\w[\w.]*)?/gi;
	const matched = text.match(refPattern);
	if (matched) {
		for (const m of matched) {
			if (
				m.includes("/") &&
				(m.endsWith(".ts") ||
					m.endsWith(".tsx") ||
					m.endsWith(".js") ||
					m.endsWith(".jsx") ||
					m.endsWith(".py") ||
					m.endsWith(".go") ||
					m.endsWith(".rs") ||
					m.endsWith(".json") ||
					m.endsWith(".yaml") ||
					m.endsWith(".yml") ||
					m.endsWith(".md"))
			) {
				refs.push(m);
			}
		}
	}
	return [...new Set(refs)];
}
