import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

export const DELEGATION_EXCEPTION_REASONS = ["trivial_change", "emergency_fix", "unsafe_to_split"] as const;

export type DelegationExceptionReason = (typeof DELEGATION_EXCEPTION_REASONS)[number];
export type DelegationExceptionApprover = "user" | "advisor";

export interface DelegationApprovalEvidence {
	readonly id: string;
	readonly eventType: "delegation_exception_approved";
	readonly taskId: string;
	readonly reason: DelegationExceptionReason;
	readonly operator: { readonly kind: DelegationExceptionApprover; readonly id: string };
	readonly approvedAt: string;
}

export interface DelegationApprovalVerifier {
	readonly verify: (evidenceId: string) => DelegationApprovalEvidence | null;
}

export interface DelegationException {
	readonly taskId: string;
	readonly reason: DelegationExceptionReason;
	readonly approvedBy: DelegationExceptionApprover;
	readonly operatorId: string;
	readonly approvalEvidenceId: string;
	readonly approvedAt: string;
}

export interface DelegationExceptionRequest {
	readonly taskId: string;
	readonly reason: string;
	readonly approvalEvidenceId: string;
}

const REASONS = new Set<string>(DELEGATION_EXCEPTION_REASONS);
const trustedVerifiers = new WeakSet<object>();
const MAX_ID_BYTES = 256;

export function createDelegationApprovalVerifier(
	resolve: (evidenceId: string) => DelegationApprovalEvidence | null,
): DelegationApprovalVerifier {
	if (typeof resolve !== "function") throw new TypeError("invalid_delegation_approval_resolver");
	const verifier = Object.freeze({ verify: resolve });
	trustedVerifiers.add(verifier);
	return verifier;
}

export function createDelegationException(
	request: DelegationExceptionRequest,
	verifier?: DelegationApprovalVerifier,
): DelegationException | null {
	try {
		if (!isPlainObject(request) || !verifier || !trustedVerifiers.has(verifier)) return null;
		const taskId = boundedId(request.taskId);
		const evidenceId = boundedId(request.approvalEvidenceId);
		if (!REASONS.has(request.reason)) return null;
		const evidence = verifier.verify(evidenceId);
		if (!isApprovalEvidence(evidence)) return null;
		if (
			evidence.id !== evidenceId ||
			evidence.eventType !== "delegation_exception_approved" ||
			evidence.taskId !== taskId ||
			evidence.reason !== request.reason
		)
			return null;
		return deepFreeze({
			taskId,
			reason: request.reason as DelegationExceptionReason,
			approvedBy: evidence.operator.kind,
			operatorId: evidence.operator.id,
			approvalEvidenceId: evidence.id,
			approvedAt: evidence.approvedAt,
		});
	} catch {
		return null;
	}
}

function isApprovalEvidence(value: unknown): value is DelegationApprovalEvidence {
	if (!isPlainObject(value) || !isPlainObject(value.operator)) return false;
	return (
		value.eventType === "delegation_exception_approved" &&
		REASONS.has(String(value.reason)) &&
		(value.operator.kind === "user" || value.operator.kind === "advisor") &&
		hasBoundedId(value.id) &&
		hasBoundedId(value.taskId) &&
		hasBoundedId(value.operator.id) &&
		isIsoTimestamp(value.approvedAt)
	);
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

function boundedId(value: unknown): string {
	if (!hasBoundedId(value)) throw new TypeError("invalid_delegation_approval_id");
	return value;
}

function hasBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_ID_BYTES;
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}
