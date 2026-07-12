import type {
	ArtifactWriteRequest,
	ArtifactWriteResult,
	CodebaseMemoryRequest,
	CodebaseMemoryResult,
	RoleBindingSnapshot,
	StrictStageRequest,
	StrictStageResult,
} from "./dto";
import type { HostResult } from "./errors";
import { assertCompatibleHostVersion } from "./version";

export interface HostConfigSnapshot {
	readonly schemaVersion: 1;
	readonly hostCompatibilityVersion: number;
	readonly cwd: string;
	readonly artifactRoot: string;
	readonly roleBindings: readonly RoleBindingSnapshot[];
	readonly featureFlags: Readonly<Record<string, boolean>>;
}

export interface OmpCustomHost {
	readonly contractVersion: number;
	getConfigSnapshot(): Promise<HostResult<HostConfigSnapshot>>;
	executeStrictStage(
		request: StrictStageRequest,
	): Promise<HostResult<StrictStageResult>>;
	writeArtifact(
		request: ArtifactWriteRequest,
	): Promise<HostResult<ArtifactWriteResult>>;
	inspectCodebaseMemory(
		request: CodebaseMemoryRequest,
	): Promise<HostResult<CodebaseMemoryResult>>;
}

export async function runStrictStage(
	host: OmpCustomHost,
	request: StrictStageRequest,
): Promise<HostResult<StrictStageResult>> {
	const snapshot = await host.getConfigSnapshot();
	if (!snapshot.ok) return snapshot;
	const compatible = assertCompatibleHostVersion(
		snapshot.value.hostCompatibilityVersion,
	);
	if (!compatible.ok) return compatible;
	return host.executeStrictStage(request);
}
