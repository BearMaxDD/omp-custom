import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { loadComplianceContract } from "../contract/load-contract";
import type { SHA256Hash, TaskContract, TaskContractSource } from "../contract/types";
import { canonicalArgsFingerprint, canonicalJson } from "../xdev/tool-identity";

const STRING_MAX_BYTES = 4096;
const PATH_MAX_BYTES = 1024;
const COLLECTION_MAX_ITEMS = 512;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CLASSIFICATION_KEYS = new Set([
	"affectedFiles",
	"risk",
	"lowRisk",
	"changesPublicBehavior",
	"includesMigration",
	"crossRepository",
	"crossModule",
	"releaseProcess",
	"binaryArtifact",
	"requiresParallelDelegation",
]);
const LIGHTWEIGHT_KEYS = new Set([
	...CLASSIFICATION_KEYS,
	"projectId",
	"gitHead",
	"taskId",
	"scope",
	"acceptanceCriteria",
	"verificationCommands",
	"createdAt",
]);
const FORMAL_KEYS = new Set(["projectId", "gitHead", "affectedFiles", "createdAt"]);
const TASK_CONTRACT_KEYS = new Set([
	"schemaVersion",
	"source",
	"taskId",
	"projectId",
	"documentPath",
	"gitHead",
	"affectedFiles",
	"scope",
	"acceptanceCriteria",
	"verificationCommands",
	"delegationRequired",
	"revision",
	"contractHash",
	"createdAt",
	"tddPath",
]);

export type TaskRisk = "low" | "medium" | "high";

export interface TaskClassificationInput {
	readonly affectedFiles: readonly string[];
	readonly risk?: TaskRisk;
	readonly lowRisk?: boolean;
	readonly changesPublicBehavior?: boolean;
	readonly includesMigration?: boolean;
	readonly crossRepository?: boolean;
	readonly crossModule?: boolean;
	readonly releaseProcess?: boolean;
	readonly binaryArtifact?: boolean;
	readonly requiresParallelDelegation?: boolean;
}

export interface LightweightTaskContractInput extends TaskClassificationInput {
	readonly projectId: string;
	readonly gitHead: string;
	readonly taskId?: string;
	readonly scope: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly verificationCommands: readonly string[];
	readonly createdAt?: string;
}

export interface FormalTaskContractOptions {
	readonly projectId: string;
	readonly gitHead: string;
	readonly affectedFiles: readonly string[];
	readonly createdAt?: string;
}

function parsedPlainInput<T>(value: unknown, label: string): T {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) throw new TypeError(`invalid_${label}`);
	const canonical = canonicalJson(value);
	if (canonical === null) throw new TypeError(`invalid_${label}`);
	return JSON.parse(canonical) as T;
}

function assertExactKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown_${label}_field:${key}`);
}

function boundedString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`invalid_${label}`);
	const normalized = value.normalize("NFC").trim();
	if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > STRING_MAX_BYTES) {
		throw new TypeError(`invalid_${label}`);
	}
	return normalized;
}

function strictIso(value: unknown, label: string): string {
	const text = boundedString(value, label);
	const timestamp = Date.parse(text);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text)
		throw new TypeError(`invalid_${label}`);
	return text;
}

function strictProjectId(value: unknown): string {
	const projectId = boundedString(value, "project_id");
	if (!UUID_V4_RE.test(projectId)) throw new TypeError("invalid_project_id");
	return projectId.toLowerCase();
}

function strictGitHead(value: unknown): string {
	const gitHead = boundedString(value, "git_head");
	if (!GIT_HEAD_RE.test(gitHead)) throw new TypeError("invalid_git_head");
	return gitHead.toLowerCase();
}

export function normalizeRepositoryPath(value: unknown): string {
	const path = boundedString(value, "repository_path");
	if (
		Buffer.byteLength(path, "utf8") > PATH_MAX_BYTES ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.startsWith("/") ||
		/^[a-zA-Z]:/.test(path) ||
		path.includes("//")
	)
		throw new TypeError("invalid_repository_path");
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new TypeError("invalid_repository_path");
	}
	return segments.join("/");
}

function normalizePaths(values: unknown, label: string): string[] {
	if (!Array.isArray(values) || values.length === 0 || values.length > COLLECTION_MAX_ITEMS)
		throw new TypeError(`invalid_${label}`);
	const byFolded = new Map<string, string>();
	for (const value of values) {
		const path = normalizeRepositoryPath(value);
		const folded = path.toLocaleLowerCase("en-US");
		const existing = byFolded.get(folded);
		if (existing && existing !== path) throw new TypeError(`ambiguous_${label}`);
		byFolded.set(folded, path);
	}
	return [...byFolded.values()].sort();
}

function normalizeStringSet(values: unknown, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(values) || values.length > COLLECTION_MAX_ITEMS || (!allowEmpty && values.length === 0))
		throw new TypeError(`invalid_${label}`);
	return [...new Set(values.map((value) => boundedString(value, label)))].sort();
}

function normalizeOrderedStrings(values: unknown, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(values) || values.length > COLLECTION_MAX_ITEMS || (!allowEmpty && values.length === 0))
		throw new TypeError(`invalid_${label}`);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = boundedString(value, label);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}

function deepFreeze<T>(value: T): T {
	const pending: object[] = typeof value === "object" && value !== null ? [value] : [];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object.isFrozen(current)) continue;
		for (const child of Object.values(current)) if (typeof child === "object" && child !== null) pending.push(child);
		Object.freeze(current);
	}
	return value;
}

function semanticHash(value: unknown): SHA256Hash {
	const hash = canonicalArgsFingerprint(value);
	if (!hash) throw new TypeError("task_contract_too_large");
	return hash;
}

function resolveRisk(safe: TaskClassificationInput): TaskRisk {
	if (safe.risk !== undefined && !["low", "medium", "high"].includes(safe.risk)) throw new TypeError("invalid_risk");
	if (safe.lowRisk !== undefined && typeof safe.lowRisk !== "boolean") throw new TypeError("invalid_low_risk");
	if (safe.risk === undefined && safe.lowRisk === undefined) throw new TypeError("missing_risk");
	const fromLegacy: TaskRisk | undefined = safe.lowRisk === undefined ? undefined : safe.lowRisk ? "low" : "medium";
	if (safe.risk && fromLegacy && safe.risk !== fromLegacy) throw new TypeError("conflicting_risk");
	return safe.risk ?? fromLegacy ?? "high";
}

function classifySafe(safe: TaskClassificationInput): TaskContractSource {
	const affectedFiles = normalizePaths(safe.affectedFiles, "affected_files");
	const risk = resolveRisk(safe);
	const flags = [
		safe.changesPublicBehavior,
		safe.includesMigration,
		safe.crossRepository,
		safe.crossModule,
		safe.releaseProcess,
		safe.binaryArtifact,
		safe.requiresParallelDelegation,
	];
	for (const flag of flags)
		if (flag !== undefined && typeof flag !== "boolean") throw new TypeError("invalid_task_classification_flag");
	return affectedFiles.length === 1 && risk === "low" && flags.every((flag) => flag !== true) ? "lightweight" : "tdd";
}

export function classifyTaskContractSource(input: TaskClassificationInput): TaskContractSource {
	const safe = parsedPlainInput<TaskClassificationInput>(input, "task_classification");
	assertExactKeys(safe, CLASSIFICATION_KEYS, "task_classification");
	return classifySafe(safe);
}

export function createLightweightTaskContract(input: LightweightTaskContractInput): TaskContract {
	const safe = parsedPlainInput<LightweightTaskContractInput>(input, "lightweight_contract");
	assertExactKeys(safe, LIGHTWEIGHT_KEYS, "lightweight_contract");
	if (classifySafe(safe) !== "lightweight") throw new TypeError("formal_tdd_required");
	const semantic = {
		schemaVersion: 1 as const,
		source: "lightweight" as const,
		taskId: safe.taskId ? boundedString(safe.taskId, "task_id") : "lightweight-task",
		projectId: strictProjectId(safe.projectId),
		gitHead: strictGitHead(safe.gitHead),
		affectedFiles: normalizePaths(safe.affectedFiles, "affected_files"),
		scope: normalizeStringSet(safe.scope, "scope"),
		acceptanceCriteria: normalizeStringSet(safe.acceptanceCriteria, "acceptance_criteria"),
		verificationCommands: normalizeOrderedStrings(safe.verificationCommands, "verification_commands"),
		delegationRequired: false,
	};
	const revision = semanticHash(semantic);
	return deepFreeze({
		...semantic,
		contractHash: revision,
		revision,
		createdAt: strictIso(safe.createdAt ?? new Date().toISOString(), "created_at"),
	});
}

export function loadTaskContractFromTdd(
	filePath: string,
	repoRoot: string,
	options: FormalTaskContractOptions,
): TaskContract {
	const safe = parsedPlainInput<FormalTaskContractOptions>(options, "formal_contract_options");
	assertExactKeys(safe, FORMAL_KEYS, "formal_contract_options");
	const contract = loadComplianceContract(filePath, repoRoot);
	const documentPath = normalizeRepositoryPath(contract.tddPath);
	const semantic = {
		schemaVersion: 1 as const,
		source: "tdd" as const,
		taskId: contract.taskId,
		projectId: strictProjectId(safe.projectId),
		documentPath,
		contractHash: contract.contractHash,
		gitHead: strictGitHead(safe.gitHead),
		affectedFiles: normalizePaths(safe.affectedFiles, "affected_files"),
		scope: normalizeStringSet(contract.summary.scope, "scope", true),
		acceptanceCriteria: normalizeStringSet(contract.summary.completionCriteria, "acceptance_criteria", true),
		verificationCommands: normalizeOrderedStrings(contract.summary.verification, "verification_commands", true),
		delegationRequired: contract.policy.requiresSubagentDelegation,
		tddPath: documentPath,
	};
	return deepFreeze({
		...semantic,
		revision: semanticHash(semantic),
		createdAt: strictIso(safe.createdAt ?? new Date().toISOString(), "created_at"),
	});
}

export function validateTaskContractIntegrity(input: TaskContract): TaskContract {
	const safe = parsedPlainInput<TaskContract>(input, "task_contract");
	assertExactKeys(safe, TASK_CONTRACT_KEYS, "task_contract");
	if (safe.schemaVersion !== 1 || (safe.source !== "tdd" && safe.source !== "lightweight")) {
		throw new TypeError("invalid_task_contract");
	}
	if (typeof safe.delegationRequired !== "boolean") throw new TypeError("invalid_task_delegation_required");
	const common = {
		schemaVersion: 1 as const,
		source: safe.source,
		taskId: boundedString(safe.taskId, "task_id"),
		projectId: strictProjectId(safe.projectId),
		gitHead: strictGitHead(safe.gitHead),
		affectedFiles: normalizePaths(safe.affectedFiles, "affected_files"),
		scope: normalizeStringSet(safe.scope, "scope", safe.source === "tdd"),
		acceptanceCriteria: normalizeStringSet(safe.acceptanceCriteria, "acceptance_criteria", safe.source === "tdd"),
		verificationCommands: normalizeOrderedStrings(
			safe.verificationCommands,
			"verification_commands",
			safe.source === "tdd",
		),
		delegationRequired: safe.delegationRequired,
	};
	const contractHash = (() => {
		if (!SHA256_RE.test(safe.contractHash)) throw new TypeError("invalid_contract_hash");
		return safe.contractHash;
	})();
	const documentPath = safe.documentPath === undefined ? undefined : normalizeRepositoryPath(safe.documentPath);
	const tddPath = safe.tddPath === undefined ? undefined : normalizeRepositoryPath(safe.tddPath);
	if (documentPath !== undefined && tddPath !== undefined && documentPath !== tddPath) {
		throw new TypeError("task_contract_path_mismatch");
	}
	if (safe.source === "lightweight" && (documentPath !== undefined || tddPath !== undefined)) {
		throw new TypeError("invalid_lightweight_document_path");
	}
	const semantic =
		safe.source === "tdd"
			? {
					...common,
					source: "tdd" as const,
					...(documentPath === undefined ? {} : { documentPath }),
					contractHash,
					...(tddPath === undefined ? {} : { tddPath }),
				}
			: { ...common, source: "lightweight" as const };
	const revision = semanticHash(semantic);
	if (safe.revision !== revision) throw new TypeError("task_contract_revision_mismatch");
	if (safe.source === "lightweight" && contractHash !== revision) {
		throw new TypeError("task_contract_hash_mismatch");
	}
	return deepFreeze({
		...semantic,
		contractHash,
		revision,
		createdAt: strictIso(safe.createdAt, "created_at"),
	});
}

export function compareTaskContractRevision(
	original: Pick<TaskContract, "revision">,
	updated: Pick<TaskContract, "revision">,
): {
	readonly oldRevision: SHA256Hash;
	readonly newRevision: SHA256Hash;
	readonly drifted: boolean;
} {
	const oldValue = parsedPlainInput<{ revision: string }>(original, "task_revision");
	const newValue = parsedPlainInput<{ revision: string }>(updated, "task_revision");
	assertExactKeys(oldValue, new Set(["revision"]), "task_revision");
	assertExactKeys(newValue, new Set(["revision"]), "task_revision");
	if (!SHA256_RE.test(oldValue.revision) || !SHA256_RE.test(newValue.revision))
		throw new TypeError("invalid_task_revision");
	return Object.freeze({
		oldRevision: oldValue.revision as SHA256Hash,
		newRevision: newValue.revision as SHA256Hash,
		drifted: oldValue.revision !== newValue.revision,
	});
}
