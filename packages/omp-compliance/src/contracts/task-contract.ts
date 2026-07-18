import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { types as utilTypes } from "node:util";
import { loadComplianceContract } from "../contract/load-contract";
import type { SHA256Hash, TaskContract, TaskContractSource } from "../contract/types";
import { canonicalArgsFingerprint, canonicalJson } from "../xdev/tool-identity";

const STRING_MAX_BYTES = 4096;
const PATH_MAX_BYTES = 1024;
const COLLECTION_MAX_ITEMS = 512;

export interface TaskClassificationInput {
	readonly affectedFiles: readonly string[];
	readonly lowRisk: boolean;
	readonly changesPublicBehavior?: boolean;
	readonly includesMigration?: boolean;
	readonly crossRepository?: boolean;
}

export interface LightweightTaskContractInput extends TaskClassificationInput {
	readonly projectId: string;
	readonly gitHead: string;
	readonly taskId?: string;
	readonly scope: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly verificationCommands: readonly string[];
}

export interface FormalTaskContractOptions {
	readonly projectId: string;
	readonly gitHead: string;
	readonly affectedFiles: readonly string[];
}

function parsedPlainInput<T>(value: unknown, label: string): T {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) throw new TypeError(`invalid_${label}`);
	const canonical = canonicalJson(value);
	if (canonical === null) throw new TypeError(`invalid_${label}`);
	return JSON.parse(canonical) as T;
}

function boundedString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string") throw new TypeError(`invalid_${label}`);
	const normalized = value.normalize("NFC").trim();
	if ((!allowEmpty && normalized.length === 0) || Buffer.byteLength(normalized, "utf8") > STRING_MAX_BYTES) {
		throw new TypeError(`invalid_${label}`);
	}
	return normalized;
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
	) {
		throw new TypeError("invalid_repository_path");
	}
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new TypeError("invalid_repository_path");
	}
	return segments.join("/");
}

function normalizePaths(values: unknown, label: string): string[] {
	if (!Array.isArray(values) || values.length === 0 || values.length > COLLECTION_MAX_ITEMS) {
		throw new TypeError(`invalid_${label}`);
	}
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
	if (!Array.isArray(values) || values.length > COLLECTION_MAX_ITEMS || (!allowEmpty && values.length === 0)) {
		throw new TypeError(`invalid_${label}`);
	}
	return [...new Set(values.map((value) => boundedString(value, label)))].sort();
}

function deepFreeze<T>(value: T): T {
	const pending: object[] = [];
	if (typeof value === "object" && value !== null) pending.push(value);
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object.isFrozen(current)) continue;
		for (const child of Object.values(current)) {
			if (typeof child === "object" && child !== null) pending.push(child);
		}
		Object.freeze(current);
	}
	return value;
}

function revisionOf(value: unknown): SHA256Hash {
	const revision = canonicalArgsFingerprint(value);
	if (!revision) throw new TypeError("task_contract_too_large");
	return revision;
}

export function classifyTaskContractSource(input: TaskClassificationInput): TaskContractSource {
	const safe = parsedPlainInput<TaskClassificationInput>(input, "task_classification");
	const affectedFiles = normalizePaths(safe.affectedFiles, "affected_files");
	if (typeof safe.lowRisk !== "boolean") throw new TypeError("invalid_low_risk");
	for (const flag of [safe.changesPublicBehavior, safe.includesMigration, safe.crossRepository]) {
		if (flag !== undefined && typeof flag !== "boolean") throw new TypeError("invalid_task_classification_flag");
	}
	return affectedFiles.length === 1 &&
		safe.lowRisk &&
		!safe.changesPublicBehavior &&
		!safe.includesMigration &&
		!safe.crossRepository
		? "lightweight"
		: "tdd";
}

export function createLightweightTaskContract(input: LightweightTaskContractInput): TaskContract {
	const safe = parsedPlainInput<LightweightTaskContractInput>(input, "lightweight_contract");
	if (classifyTaskContractSource(safe) !== "lightweight") throw new TypeError("formal_tdd_required");
	const body = {
		source: "lightweight" as const,
		taskId: safe.taskId ? boundedString(safe.taskId, "task_id") : "lightweight-task",
		projectId: boundedString(safe.projectId, "project_id"),
		gitHead: boundedString(safe.gitHead, "git_head"),
		affectedFiles: normalizePaths(safe.affectedFiles, "affected_files"),
		scope: normalizeStringSet(safe.scope, "scope"),
		acceptanceCriteria: normalizeStringSet(safe.acceptanceCriteria, "acceptance_criteria"),
		verificationCommands: normalizeStringSet(safe.verificationCommands, "verification_commands"),
		delegationRequired: false,
	};
	return deepFreeze({ ...body, revision: revisionOf(body) });
}

export function loadTaskContractFromTdd(
	filePath: string,
	repoRoot: string,
	options: FormalTaskContractOptions,
): TaskContract {
	const safe = parsedPlainInput<FormalTaskContractOptions>(options, "formal_contract_options");
	const contract = loadComplianceContract(filePath, repoRoot);
	const body = {
		source: "tdd" as const,
		taskId: contract.taskId,
		projectId: boundedString(safe.projectId, "project_id"),
		gitHead: boundedString(safe.gitHead, "git_head"),
		affectedFiles: normalizePaths(safe.affectedFiles, "affected_files"),
		scope: normalizeStringSet(contract.summary.scope, "scope", true),
		acceptanceCriteria: normalizeStringSet(contract.summary.completionCriteria, "acceptance_criteria", true),
		verificationCommands: normalizeStringSet(contract.summary.verification, "verification_commands", true),
		delegationRequired: contract.policy.requiresSubagentDelegation,
		tddPath: normalizeRepositoryPath(contract.tddPath),
		contractHash: contract.contractHash,
	};
	return deepFreeze({ ...body, revision: revisionOf(body) });
}

export function compareTaskContractRevision(
	original: Pick<TaskContract, "revision">,
	updated: Pick<TaskContract, "revision">,
): { readonly oldRevision: SHA256Hash; readonly newRevision: SHA256Hash; readonly drifted: boolean } {
	return Object.freeze({
		oldRevision: original.revision,
		newRevision: updated.revision,
		drifted: original.revision !== updated.revision,
	});
}

export function defaultProjectId(repoRoot: string): string {
	return boundedString(basename(repoRoot), "project_id");
}
