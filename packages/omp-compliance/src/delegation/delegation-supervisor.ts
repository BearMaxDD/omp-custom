import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { types as utilTypes } from "node:util";
import type { TaskContract } from "../contract/types";
import { validateTaskContractIntegrity } from "../contracts/task-contract";

export type DelegationTransport = "task" | "hub";
export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type DelegationGateStatus = "pending" | "sufficient" | "insufficient" | "violation";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const MAX_STRING_BYTES = 4096;
const MAX_ID_BYTES = 256;
const MAX_PATH_BYTES = 1024;
const MAX_ITEMS = 512;

export interface TrustedDelegationContext {
	readonly taskContract: TaskContract;
	readonly evidenceRevision: `sha256:${string}`;
}

const trustedContexts = new WeakSet<object>();
const trustedEvidenceVerifiers = new WeakSet<object>();
const trustedRecords = new WeakSet<object>();
const trustedCompletionAttestations = new WeakSet<object>();
const trustedDelegationEvidence = new WeakMap<object, ReadonlyMap<string, TrustedDelegationEvidence>>();
const contextTokens = new WeakMap<object, object>();
const recordContextTokens = new WeakMap<object, object>();
const completionContextTokens = new WeakMap<object, object>();

interface TrustedDelegationEvidence {
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
}

export interface DelegationFileEvidence {
	readonly delegationId: string;
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds?: readonly string[];
}

export interface DelegationEvidenceReference {
	readonly taskId: string;
	readonly contractHash: `sha256:${string}`;
	readonly evidenceRevision: `sha256:${string}`;
	readonly delegations?: readonly DelegationFileEvidence[];
}

export interface DelegationEvidenceVerifier {
	readonly verify: (evidenceRevision: `sha256:${string}`) => DelegationEvidenceReference | null;
}

export function createDelegationEvidenceVerifier(
	resolve: (evidenceRevision: `sha256:${string}`) => DelegationEvidenceReference | null,
): DelegationEvidenceVerifier {
	if (typeof resolve !== "function") throw new TypeError("invalid_delegation_evidence_resolver");
	const verifier = Object.freeze({ verify: resolve });
	trustedEvidenceVerifiers.add(verifier);
	return verifier;
}

export function isTrustedDelegationContext(value: unknown): value is TrustedDelegationContext {
	return typeof value === "object" && value !== null && trustedContexts.has(value);
}

export function getTrustedDelegationActualFiles(
	context: TrustedDelegationContext,
	delegationId: string,
): readonly string[] | undefined {
	if (!isTrustedDelegationContext(context)) return undefined;
	return trustedDelegationEvidence.get(context)?.get(delegationId)?.actualFiles;
}

export function createTrustedDelegationContext(
	input: {
		readonly taskContract: TaskContract;
		readonly evidenceRevision: `sha256:${string}`;
	},
	verifier?: DelegationEvidenceVerifier,
): TrustedDelegationContext {
	if (!verifier || !trustedEvidenceVerifiers.has(verifier)) {
		throw new TypeError("invalid_delegation_evidence_verifier");
	}
	const safe = plainObject(input, "trusted_delegation_context");
	const taskContract = validateTaskContractIntegrity(safe.taskContract as TaskContract);
	const evidenceRevision = boundedString(safe.evidenceRevision, "evidence_revision", MAX_ID_BYTES);
	if (!HASH_PATTERN.test(evidenceRevision)) throw new TypeError("invalid_evidence_revision");
	const reference = verifier.verify(evidenceRevision as `sha256:${string}`);
	if (
		!isPlainObject(reference) ||
		reference.taskId !== taskContract.taskId ||
		reference.contractHash !== taskContract.contractHash ||
		reference.evidenceRevision !== evidenceRevision
	)
		throw new TypeError("delegation_evidence_mismatch");
	const delegations = safeArrayValues(reference.delegations ?? [], "delegation_file_evidence");
	const delegationEvidence = new Map<string, TrustedDelegationEvidence>();
	for (const entry of delegations) {
		if (!isPlainObject(entry)) throw new TypeError("invalid_delegation_file_evidence");
		const delegationId = boundedString(entry.delegationId, "delegation_file_evidence_id", MAX_ID_BYTES);
		if (delegationEvidence.has(delegationId)) throw new TypeError("duplicate_delegation_file_evidence");
		delegationEvidence.set(
			delegationId,
			deepFreeze({
				actualFiles: normalizePaths(entry.actualFiles, "delegation_actual_files"),
				toolEvidenceIds: boundedStrings(entry.toolEvidenceIds ?? [], "delegation_tool_evidence_ids"),
			}),
		);
	}
	const context = deepFreeze({ taskContract, evidenceRevision }) as TrustedDelegationContext;
	trustedContexts.add(context);
	trustedDelegationEvidence.set(context, delegationEvidence);
	contextTokens.set(context, Object.freeze({}));
	return context;
}

export interface DelegationViolation {
	readonly kind: "outside_owned_files";
	readonly files: readonly string[];
}

export interface DelegationRecord {
	readonly delegationId: string;
	readonly taskId: string;
	readonly agentId?: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly transport: DelegationTransport;
	readonly workPackage: string;
	readonly ownedFiles: readonly string[];
	readonly contractHash: `sha256:${string}`;
	readonly evidenceRevision: `sha256:${string}`;
	readonly verificationCommands: readonly string[];
	readonly status: DelegationStatus;
	readonly gateStatus: DelegationGateStatus;
	readonly actualFilesKnown: boolean;
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
	readonly violations: readonly DelegationViolation[];
}

export interface DelegationRecordInput {
	readonly delegationId: string;
	readonly agentId?: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly transport: DelegationTransport;
	readonly workPackage: string;
	readonly context: TrustedDelegationContext;
}

export type DelegationEvent =
	| { readonly delegationId: string; readonly type: "started" }
	| DelegationCompletionAttestation
	| { readonly delegationId: string; readonly type: "failed" | "cancelled" | "timed_out" };

export interface DelegationCompletionAttestation {
	readonly delegationId: string;
	readonly type: "completed";
	readonly originToolCallId: string;
	readonly resultToolCallId: string;
	readonly actualFilesKnown: boolean;
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
}

export interface DelegationCompletionAttestationInput {
	readonly delegationId: string;
	readonly originToolCallId: string;
	readonly resultToolCallId: string;
	readonly toolEvidenceIds: readonly string[];
}

export function createDelegationCompletionAttestation(
	context: TrustedDelegationContext,
	input: DelegationCompletionAttestationInput,
): DelegationCompletionAttestation {
	if (!isTrustedDelegationContext(context)) throw new TypeError("invalid_trusted_delegation_context");
	const safe = plainObject(input, "delegation_completion_attestation");
	const delegationId = boundedString(safe.delegationId, "delegation_id", MAX_ID_BYTES);
	const evidence = trustedDelegationEvidence.get(context)?.get(delegationId);
	const submittedEvidenceIds = boundedStrings(safe.toolEvidenceIds, "tool_evidence_ids");
	const attestation = deepFreeze({
		delegationId,
		type: "completed" as const,
		originToolCallId: boundedString(safe.originToolCallId, "origin_tool_call_id", MAX_ID_BYTES),
		resultToolCallId: boundedString(safe.resultToolCallId, "result_tool_call_id", MAX_ID_BYTES),
		actualFilesKnown: evidence !== undefined,
		actualFiles: evidence?.actualFiles ?? [],
		toolEvidenceIds: submittedEvidenceIds.filter((id) => evidence?.toolEvidenceIds.includes(id) === true),
	});
	trustedCompletionAttestations.add(attestation);
	completionContextTokens.set(attestation, contextTokens.get(context) as object);
	return attestation;
}

const TERMINAL_STATUSES = new Set<DelegationStatus>(["completed", "failed", "cancelled", "timed_out"]);

export function createDelegationRecord(input: DelegationRecordInput): DelegationRecord {
	const safe = plainObject(input, "delegation_record");
	if (!trustedContexts.has(safe.context as object)) throw new TypeError("invalid_trusted_delegation_context");
	const context = safe.context as TrustedDelegationContext;
	const contextToken = contextTokens.get(context);
	if (!contextToken) throw new TypeError("invalid_trusted_delegation_context");
	const agentId = safe.agentId === undefined ? undefined : boundedString(safe.agentId, "agent_id", MAX_ID_BYTES);
	return trustRecord(
		deepFreeze({
			delegationId: boundedString(safe.delegationId, "delegation_id", MAX_ID_BYTES),
			taskId: boundedString(context.taskContract.taskId, "task_id", MAX_ID_BYTES),
			...(agentId === undefined ? {} : { agentId }),
			sessionId: boundedString(safe.sessionId, "session_id", MAX_ID_BYTES),
			toolCallId: boundedString(safe.toolCallId, "tool_call_id", MAX_ID_BYTES),
			transport: transport(safe.transport),
			workPackage: boundedString(safe.workPackage, "work_package", MAX_STRING_BYTES),
			ownedFiles: normalizePaths(context.taskContract.affectedFiles, "owned_files"),
			contractHash: context.taskContract.contractHash,
			evidenceRevision: context.evidenceRevision,
			verificationCommands: boundedStrings(context.taskContract.verificationCommands, "verification_commands"),
			status: "queued" as const,
			gateStatus: "pending" as const,
			actualFilesKnown: false,
			actualFiles: [] as string[],
			toolEvidenceIds: [] as string[],
			violations: [] as DelegationViolation[],
		}),
		contextToken,
	);
}

export function applyDelegationEvent(record: DelegationRecord, event: DelegationEvent): DelegationRecord {
	if (!trustedRecords.has(record)) return record;
	const contextToken = recordContextTokens.get(record);
	if (!contextToken) return record;
	if (!isPlainObject(record as unknown) || !isPlainObject(event as unknown)) return record;
	if (event.delegationId !== record.delegationId || TERMINAL_STATUSES.has(record.status)) return record;

	if (event.type === "started") {
		return record.status === "queued"
			? trustRecord(deepFreeze({ ...record, status: "running" as const }), contextToken)
			: record;
	}

	if (event.type === "completed") {
		if (record.status !== "running" || !trustedCompletionAttestations.has(event)) return record;
		if (completionContextTokens.get(event) !== contextToken) return record;
		const originToolCallId = boundedString(event.originToolCallId, "origin_tool_call_id", MAX_ID_BYTES);
		const resultToolCallId = boundedString(event.resultToolCallId, "result_tool_call_id", MAX_ID_BYTES);
		if (originToolCallId !== record.toolCallId) return record;
		const actualFilesKnown = event.actualFilesKnown === true;
		const actualFiles = actualFilesKnown ? normalizePaths(event.actualFiles, "actual_files") : [];
		const outside = actualFiles.filter((file) => !record.ownedFiles.includes(file));
		const expectedEvidenceId = `tool-result:${resultToolCallId}`;
		const toolEvidenceIds = boundedStrings(event.toolEvidenceIds, "tool_evidence_ids").filter(
			(id) => id === expectedEvidenceId,
		);
		const violations: DelegationViolation[] =
			outside.length > 0 ? [{ kind: "outside_owned_files", files: outside }] : [];
		return trustRecord(
			deepFreeze({
				...record,
				status: "completed" as const,
				gateStatus:
					violations.length > 0
						? ("violation" as const)
						: actualFilesKnown && toolEvidenceIds.length > 0
							? ("sufficient" as const)
							: ("insufficient" as const),
				actualFilesKnown,
				actualFiles,
				toolEvidenceIds,
				violations,
			}),
			contextToken,
		);
	}

	if (record.status !== "running") return record;
	return trustRecord(deepFreeze({ ...record, status: event.type, gateStatus: "insufficient" as const }), contextToken);
}

export function delegationSatisfiesGate(record: DelegationRecord): boolean {
	try {
		return (
			isPlainObject(record) &&
			trustedRecords.has(record) &&
			record.status === "completed" &&
			record.gateStatus === "sufficient" &&
			record.actualFilesKnown === true &&
			record.violations.length === 0 &&
			record.toolEvidenceIds.length > 0 &&
			record.actualFiles.every((file) => record.ownedFiles.includes(file)) &&
			hasText(record.delegationId) &&
			hasText(record.taskId) &&
			hasText(record.agentId) &&
			hasText(record.sessionId) &&
			hasText(record.toolCallId) &&
			hasText(record.workPackage) &&
			HASH_PATTERN.test(record.contractHash) &&
			HASH_PATTERN.test(record.evidenceRevision)
		);
	} catch {
		return false;
	}
}

function trustRecord<T extends DelegationRecord>(record: T, contextToken: object): T {
	trustedRecords.add(record);
	recordContextTokens.set(record, contextToken);
	return record;
}

function normalizePaths(values: unknown, label: string): string[] {
	return [...new Set(safeArrayValues(values, label).map((value) => normalizePath(value, label)))];
}

function normalizePath(value: unknown, label: string): string {
	const raw = boundedString(value, label, MAX_PATH_BYTES);
	if (raw.includes("\0") || WINDOWS_DRIVE.test(raw)) throw new TypeError(`invalid_${label}`);
	const portable = raw.replaceAll("\\", "/");
	if (posix.isAbsolute(portable) || portable.split("/").includes("..")) throw new TypeError(`invalid_${label}`);
	const normalized = posix.normalize(portable);
	if (normalized === "." || normalized.startsWith("../")) throw new TypeError(`invalid_${label}`);
	return normalized;
}

function boundedStrings(values: unknown, label: string): string[] {
	return [...new Set(safeArrayValues(values, label).map((value) => boundedString(value, label, MAX_STRING_BYTES)))];
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

function boundedString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
		throw new TypeError(`invalid_${label}`);
	}
	return value;
}

function transport(value: unknown): DelegationTransport {
	if (value !== "task" && value !== "hub") throw new TypeError("invalid_delegation_transport");
	return value;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainObject(value)) throw new TypeError(`invalid_${label}`);
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return false;
	try {
		return (
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
		);
	} catch {
		return false;
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
