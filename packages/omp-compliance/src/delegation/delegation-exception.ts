export const DELEGATION_EXCEPTION_REASONS = ["trivial_change", "emergency_fix", "unsafe_to_split"] as const;

export type DelegationExceptionReason = (typeof DELEGATION_EXCEPTION_REASONS)[number];
export type DelegationExceptionApprover = "user" | "advisor";

export interface DelegationException {
	readonly taskId: string;
	readonly reason: DelegationExceptionReason;
	readonly approvedBy: DelegationExceptionApprover;
	readonly approvalEvidenceId: string;
	readonly approvedAt: string;
}

export interface DelegationExceptionRequest {
	readonly taskId: string;
	readonly reason: string;
	readonly approvedBy: string;
	readonly approvalEvidenceId: string;
	readonly approvedAt: string;
}

const REASONS = new Set<string>(DELEGATION_EXCEPTION_REASONS);

export function createDelegationException(request: DelegationExceptionRequest): DelegationException | null {
	if (
		!hasText(request.taskId) ||
		!REASONS.has(request.reason) ||
		(request.approvedBy !== "user" && request.approvedBy !== "advisor") ||
		!hasText(request.approvalEvidenceId) ||
		!request.approvalEvidenceId.startsWith(`${request.approvedBy}:`) ||
		!hasText(request.approvalEvidenceId.slice(request.approvedBy.length + 1)) ||
		!isIsoTimestamp(request.approvedAt)
	) {
		return null;
	}

	return {
		taskId: request.taskId,
		reason: request.reason as DelegationExceptionReason,
		approvedBy: request.approvedBy,
		approvalEvidenceId: request.approvalEvidenceId,
		approvedAt: request.approvedAt,
	};
}

function hasText(value: string): boolean {
	return value.trim().length > 0;
}

function isIsoTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
