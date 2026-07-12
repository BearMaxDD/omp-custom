export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface ArtifactIdentity {
	readonly acceptingDir: string;
	readonly relativePath: string;
}

export interface RoleBindingSnapshot {
	readonly roleId: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly bindingHash: string;
}

export interface StrictBindingInput {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string | undefined;
	readonly bindingHash: string;
}

export interface StrictBindingSnapshot {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly bindingHash: string;
}

export interface StrictStageRequestInput {
	readonly taskId: string;
	readonly stageId: string;
	readonly roleId: string;
	readonly binding: StrictBindingInput;
	readonly prompt: string;
	readonly artifact: ArtifactIdentity;
}

export interface StrictStageRequest {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly stageId: string;
	readonly roleId: string;
	readonly binding: StrictBindingSnapshot;
	readonly prompt: string;
	readonly artifact: ArtifactIdentity;
}

export interface StrictStageResult {
	readonly schemaVersion: 1;
	readonly state: "completed" | "blocked" | "failed";
	readonly artifact: ArtifactIdentity;
	readonly output: string;
}

export interface ArtifactWriteRequestInput<TJson = unknown> {
	readonly artifact: ArtifactIdentity;
	readonly json: TJson;
}

export interface ArtifactWriteRequest<TJson = JsonValue> {
	readonly schemaVersion: 1;
	readonly artifact: ArtifactIdentity;
	readonly json: TJson;
}

export interface ArtifactWriteResult {
	readonly schemaVersion: 1;
	readonly artifact: ArtifactIdentity;
}

export interface CodebaseMemoryRequest {
	readonly schemaVersion: 1;
	readonly cwd: string;
	readonly mode: "off" | "advisory" | "required";
}

export interface CodebaseMemoryResult {
	readonly schemaVersion: 1;
	readonly state: "ready" | "degraded" | "blocked";
	readonly message: string;
}

const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
const THINKING_LEVELS: Record<ThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

export function createStrictStageRequest(
	input: StrictStageRequestInput,
): StrictStageRequest {
	assertOpaqueId("taskId", input.taskId);
	assertOpaqueId("stageId", input.stageId);
	assertOpaqueId("roleId", input.roleId);
	if (typeof input.prompt !== "string") {
		throw new TypeError("prompt must be a string");
	}

	const binding = createStrictBindingSnapshot(input.binding);
	const artifact = createArtifactIdentity(input.artifact);
	return deepFreeze({
		schemaVersion: 1,
		taskId: input.taskId,
		stageId: input.stageId,
		roleId: input.roleId,
		binding,
		prompt: input.prompt,
		artifact,
	});
}

export function createArtifactWriteRequest<TJson>(
	input: ArtifactWriteRequestInput<TJson>,
): ArtifactWriteRequest<TJson>;
export function createArtifactWriteRequest(
	input: ArtifactWriteRequestInput,
): ArtifactWriteRequest {
	return deepFreeze({
		schemaVersion: 1,
		artifact: createArtifactIdentity(input.artifact),
		json: copyJsonValue(input.json),
	});
}

function createStrictBindingSnapshot(
	input: StrictBindingInput,
): StrictBindingSnapshot {
	if (typeof input.provider !== "string" || input.provider.length === 0) {
		throw new TypeError("binding.provider must be a non-empty string");
	}
	if (typeof input.modelId !== "string" || input.modelId.length === 0) {
		throw new TypeError("binding.modelId must be a non-empty string");
	}
	if (
		input.thinkingLevel !== undefined &&
		!isThinkingLevel(input.thinkingLevel)
	) {
		throw new TypeError("binding.thinkingLevel is invalid");
	}
	if (typeof input.bindingHash !== "string" || input.bindingHash.length === 0) {
		throw new TypeError("binding.bindingHash must be a non-empty string");
	}
	return deepFreeze({
		provider: input.provider,
		modelId: input.modelId,
		thinkingLevel: input.thinkingLevel,
		bindingHash: input.bindingHash,
	});
}

function createArtifactIdentity(input: ArtifactIdentity): ArtifactIdentity {
	if (
		typeof input.acceptingDir !== "string" ||
		input.acceptingDir.length === 0
	) {
		throw new TypeError("artifact.acceptingDir must be a non-empty string");
	}
	if (
		typeof input.relativePath !== "string" ||
		input.relativePath.length === 0
	) {
		throw new TypeError("artifact.relativePath must be a non-empty string");
	}
	if (input.relativePath.startsWith("/") || input.relativePath.includes("\\")) {
		throw new TypeError(
			"artifact.relativePath must be a relative slash-separated path",
		);
	}
	for (const segment of input.relativePath.split("/")) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new TypeError(
				"artifact.relativePath must not contain empty, dot, or parent segments",
			);
		}
	}
	return deepFreeze({
		acceptingDir: input.acceptingDir,
		relativePath: input.relativePath,
	});
}

function assertOpaqueId(name: string, value: string): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value === "." ||
		value === ".." ||
		!OPAQUE_ID.test(value)
	) {
		throw new TypeError(`${name} must be a non-empty opaque ID`);
	}
}

function copyJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new TypeError("json numbers must be finite");
	}
	if (Array.isArray(value)) return value.map(copyJsonValue);
	if (isPlainRecord(value)) {
		const copy: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value))
			copy[key] = copyJsonValue(entry);
		return copy;
	}
	throw new TypeError("json must contain only JSON-compatible values");
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return value in THINKING_LEVELS;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value) as T;
}
