export type DelegationTransport = "task" | "hub";
export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type DelegationGateStatus = "pending" | "sufficient" | "insufficient" | "violation";

export interface DelegationViolation {
	readonly kind: "outside_owned_files";
	readonly files: readonly string[];
}

export interface DelegationRecord {
	readonly delegationId: string;
	readonly taskId: string;
	readonly agentId: string;
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
	readonly actualFiles: readonly string[];
	readonly toolEvidenceIds: readonly string[];
	readonly violations: readonly DelegationViolation[];
}

export type DelegationRecordInput = Omit<
	DelegationRecord,
	"status" | "gateStatus" | "actualFiles" | "toolEvidenceIds" | "violations"
>;

export type DelegationEvent =
	| { readonly delegationId: string; readonly type: "started" }
	| {
			readonly delegationId: string;
			readonly type: "completed";
			readonly actualFiles: readonly string[];
			readonly toolEvidenceIds: readonly string[];
	  }
	| { readonly delegationId: string; readonly type: "failed" | "cancelled" | "timed_out" };

const TERMINAL_STATUSES = new Set<DelegationStatus>(["completed", "failed", "cancelled", "timed_out"]);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createDelegationRecord(input: DelegationRecordInput): DelegationRecord {
	return {
		...input,
		ownedFiles: uniqueStrings(input.ownedFiles),
		verificationCommands: uniqueStrings(input.verificationCommands),
		status: "queued",
		gateStatus: "pending",
		actualFiles: [],
		toolEvidenceIds: [],
		violations: [],
	};
}

export function applyDelegationEvent(record: DelegationRecord, event: DelegationEvent): DelegationRecord {
	if (event.delegationId !== record.delegationId || TERMINAL_STATUSES.has(record.status)) return record;

	if (event.type === "started") {
		return record.status === "queued" ? { ...record, status: "running" } : record;
	}

	if (event.type === "completed") {
		if (record.status !== "running") return record;
		const actualFiles = uniqueStrings(event.actualFiles);
		const outside = actualFiles.filter((file) => !record.ownedFiles.includes(file));
		const expectedEvidenceId = `tool-result:${record.toolCallId}`;
		const toolEvidenceIds = uniqueStrings(event.toolEvidenceIds).filter((id) => id === expectedEvidenceId);
		const violations: DelegationViolation[] =
			outside.length > 0 ? [{ kind: "outside_owned_files", files: outside }] : [];
		return {
			...record,
			status: "completed",
			gateStatus: violations.length > 0 ? "violation" : toolEvidenceIds.length > 0 ? "sufficient" : "insufficient",
			actualFiles,
			toolEvidenceIds,
			violations,
		};
	}

	if (record.status !== "running") return record;
	return { ...record, status: event.type, gateStatus: "insufficient" };
}

export function delegationSatisfiesGate(record: DelegationRecord): boolean {
	return (
		record.status === "completed" &&
		record.gateStatus === "sufficient" &&
		record.violations.length === 0 &&
		record.toolEvidenceIds.includes(`tool-result:${record.toolCallId}`) &&
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
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter(hasText))];
}

function hasText(value: string): boolean {
	return value.trim().length > 0;
}
