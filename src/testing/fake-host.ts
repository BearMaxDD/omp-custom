import type {
	ArtifactWriteRequest,
	ArtifactWriteResult,
	CodebaseMemoryResult,
	StrictStageRequest,
	StrictStageResult,
} from "../contract/dto.ts";
import type { HostResult } from "../contract/errors.ts";
import type { HostConfigSnapshot, OmpCustomHost } from "../contract/host.ts";
import { CONTRACT_VERSION } from "../contract/version.ts";

export type FakeHostCall =
	| "getConfigSnapshot"
	| "executeStrictStage"
	| "writeArtifact"
	| "inspectCodebaseMemory";

export interface FakeHostOptions {
	readonly hostCompatibilityVersion?: number;
	readonly configResult?: HostResult<HostConfigSnapshot>;
	readonly strictStageResult?: HostResult<StrictStageResult>;
	readonly artifactWriteResult?: HostResult<ArtifactWriteResult>;
	readonly codebaseMemoryResult?: HostResult<CodebaseMemoryResult>;
}

export interface FakeHost extends OmpCustomHost {
	calls(): FakeHostCall[];
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
	const calls: FakeHostCall[] = [];
	const configResult = freezeHostResult(
		options.configResult ?? {
			ok: true,
			value: {
				schemaVersion: 1,
				hostCompatibilityVersion:
					options.hostCompatibilityVersion ?? CONTRACT_VERSION,
				cwd: "/fake/cwd",
				artifactRoot: "/fake/artifacts",
				roleBindings: [],
				featureFlags: {},
			},
		},
	);

	return Object.freeze({
		contractVersion: CONTRACT_VERSION,
		async getConfigSnapshot(): Promise<HostResult<HostConfigSnapshot>> {
			calls.push("getConfigSnapshot");
			return configResult;
		},
		async executeStrictStage(
			request: StrictStageRequest,
		): Promise<HostResult<StrictStageResult>> {
			calls.push("executeStrictStage");
			return (
				options.strictStageResult ??
				freezeHostResult({
					ok: true,
					value: {
						schemaVersion: 1,
						state: "completed",
						artifact: request.artifact,
						output: "",
					},
				})
			);
		},
		async writeArtifact(
			request: ArtifactWriteRequest,
		): Promise<HostResult<ArtifactWriteResult>> {
			calls.push("writeArtifact");
			return (
				options.artifactWriteResult ??
				freezeHostResult({
					ok: true,
					value: { schemaVersion: 1, artifact: request.artifact },
				})
			);
		},
		async inspectCodebaseMemory(): Promise<HostResult<CodebaseMemoryResult>> {
			calls.push("inspectCodebaseMemory");
			return (
				options.codebaseMemoryResult ??
				freezeHostResult({
					ok: true,
					value: { schemaVersion: 1, state: "ready", message: "" },
				})
			);
		},
		calls(): FakeHostCall[] {
			return Object.freeze([...calls]) as FakeHostCall[];
		},
	});
}

function freezeHostResult<T>(result: HostResult<T>): HostResult<T> {
	return deepFreeze(structuredClone(result));
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value) as T;
}
