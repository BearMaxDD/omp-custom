import { posix } from "node:path";
import { types as utilTypes } from "node:util";
import type { TaskContract } from "../contract/types";
import { validateTaskContractIntegrity } from "../contracts/task-contract";
import { validateCodebasePack } from "../signals/codebase-memory";
import type { CodebaseEvidencePack, TrustedCodebaseValidationContext } from "../signals/types";
import {
	CANONICAL_CODEBASE_SERVER_ID,
	codebaseToolAccess,
	isAdvisorCodebaseToolAllowed,
} from "../xdev/codebase-tool-policy";
import { type CanonicalToolIdentity, canonicalArgsFingerprint, canonicalJson } from "../xdev/tool-identity";

const BUILTIN_SERVER_ID = "omp";
const MAX_IDENTIFIER_BYTES = 512;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_SHELL_TOKENS = 256;

const MUTATING_BUILTINS = new Set(["edit", "write", "bash", "task", "hub"]);
const TARGETED_BUILTINS = new Set(["edit", "write"]);
const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"dirname",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"stat",
	"tail",
	"wc",
	"which",
]);
const SIMPLE_MUTATION_COMMANDS = new Set(["mkdir", "rm", "rmdir", "touch", "truncate", "unlink"]);

export type PreToolActor = "main" | "advisor";
export type PreToolDenyReason =
	| "advisor_tool_forbidden"
	| "invalid_input"
	| "invalid_codebase_evidence"
	| "task_identity_mismatch"
	| "missing_codebase_evidence"
	| "missing_contract"
	| "scope_violation"
	| "stale_evidence"
	| "unknown_tool";

export interface CanonicalBuiltinToolIdentity extends Omit<CanonicalToolIdentity, "transport"> {
	readonly transport: "builtin";
}

export type PreToolIdentity = CanonicalToolIdentity | CanonicalBuiltinToolIdentity;

export interface CanonicalToolCall {
	readonly actor: PreToolActor;
	readonly taskId: string;
	readonly callId: string;
	readonly identity: PreToolIdentity;
	readonly evidenceRevision: `sha256:${string}`;
}

export interface PreToolContext {
	readonly evidenceRevision: `sha256:${string}`;
	readonly contract?: TaskContract;
	readonly codebasePack?: CodebaseEvidencePack;
	readonly trustedCodebaseContext?: TrustedCodebaseValidationContext;
}

export type PreToolDecision =
	| { readonly allow: true; readonly invalidatesEvidence?: true }
	| {
			readonly allow: false;
			readonly reason: PreToolDenyReason;
			readonly evidenceWriteFailed?: true;
	  };

export interface PreToolBlockedEvidence {
	readonly event: "tool_call_blocked";
	readonly task: string;
	readonly call: string;
	readonly actor: PreToolActor | "unknown";
	readonly canonicalServer: string;
	readonly canonicalTool: string;
	readonly qualifiedName: string;
	readonly argsFingerprint: string;
	readonly callEvidenceRevision: string;
	readonly contextEvidenceRevision?: string;
	readonly packEvidenceRevision?: string;
	readonly contractRevision?: string;
	readonly reason: PreToolDenyReason;
	readonly remediationHint: string;
	readonly remediationAction: string;
}

export interface PreToolEvidenceSink {
	append(record: PreToolBlockedEvidence): void;
}

interface ValidatedCall {
	actor: PreToolActor;
	taskId: string;
	callId: string;
	evidenceRevision: `sha256:${string}`;
	identity: PreToolIdentity;
	isCodebase: boolean;
}

type ShellClassification = { kind: "read" } | { kind: "write"; targets: readonly string[] | null };

const REMEDIATION_HINT = "A pre-tool policy requirement was not satisfied.";
const REMEDIATION_ACTIONS: Readonly<Record<PreToolDenyReason, string>> = {
	advisor_tool_forbidden: "Use only canonical read-only Codebase tools from the Advisor.",
	invalid_input: "Submit a bounded canonical tool call with plain data-only inputs.",
	invalid_codebase_evidence: "Rebuild trusted Codebase evidence from the controlled collector before retrying.",
	task_identity_mismatch: "Use a tool call task identity that matches the validated trusted TaskContract.",
	missing_codebase_evidence: "Provide a trusted Codebase context and its validated Evidence Pack before retrying.",
	missing_contract: "Provide a valid TaskContract before retrying the tool call.",
	scope_violation: "Restrict mutation targets to the trusted contract and Codebase evidence scope.",
	stale_evidence: "Refresh Codebase evidence and retry with the current evidence revision.",
	unknown_tool: "Use a canonical tool identity explicitly supported by the pre-tool policy.",
};

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) return false;
		}
	} catch {
		return false;
	}
	return true;
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
}

function boundedString(value: unknown, maxBytes = MAX_IDENTIFIER_BYTES): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= maxBytes &&
		!value.includes("\0")
	);
}

function safeEvidenceLabel(value: unknown, key: string, fallback: string): string {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return fallback;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return fallback;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.enumerable && "value" in descriptor && boundedString(descriptor.value)
			? descriptor.value
			: fallback;
	} catch {
		return fallback;
	}
}

function safeRecord(value: unknown): Record<string, unknown> | null {
	return isPlainDataObject(value) ? value : null;
}

function safeRecordProperty(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	return record ? safeRecord(dataProperty(record, key)) : null;
}

function safeBoundedProperty(record: Record<string, unknown> | null, key: string, fallback: string): string {
	if (!record) return fallback;
	const value = dataProperty(record, key);
	return boundedString(value) ? value : fallback;
}

function safeOptionalRevision(record: Record<string, unknown> | null, key: string): string | undefined {
	if (!record) return undefined;
	const value = dataProperty(record, key);
	return validRevision(value) ? value : undefined;
}

function blockedEvidenceMetadata(
	callInput: unknown,
	contextInput: unknown,
): Omit<PreToolBlockedEvidence, "event" | "task" | "call" | "reason" | "remediationHint" | "remediationAction"> {
	const call = safeRecord(callInput);
	const identity = safeRecordProperty(call, "identity");
	const context = safeRecord(contextInput);
	const contract = safeRecordProperty(context, "contract");
	const pack = safeRecordProperty(context, "codebasePack");
	const actor = call ? dataProperty(call, "actor") : undefined;
	return {
		actor: actor === "main" || actor === "advisor" ? actor : "unknown",
		canonicalServer: safeBoundedProperty(identity, "serverId", "<invalid-server>"),
		canonicalTool: safeBoundedProperty(identity, "toolName", "<invalid-tool>"),
		qualifiedName: safeBoundedProperty(identity, "qualifiedName", "<invalid-qualified-name>"),
		argsFingerprint: safeBoundedProperty(identity, "argsFingerprint", "<invalid-args-fingerprint>"),
		callEvidenceRevision: safeBoundedProperty(call, "evidenceRevision", "<invalid-call-evidence-revision>"),
		...(safeOptionalRevision(context, "evidenceRevision")
			? { contextEvidenceRevision: safeOptionalRevision(context, "evidenceRevision") }
			: {}),
		...(safeOptionalRevision(pack, "evidenceRevision")
			? { packEvidenceRevision: safeOptionalRevision(pack, "evidenceRevision") }
			: {}),
		...(safeOptionalRevision(contract, "revision")
			? { contractRevision: safeOptionalRevision(contract, "revision") }
			: {}),
	};
}

function validRevision(value: unknown): value is `sha256:${string}` {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateCall(value: unknown): ValidatedCall | null {
	if (!isPlainDataObject(value)) return null;
	const actor = dataProperty(value, "actor");
	const taskId = dataProperty(value, "taskId");
	const callId = dataProperty(value, "callId");
	const evidenceRevision = dataProperty(value, "evidenceRevision");
	const identityValue = dataProperty(value, "identity");
	if (
		(actor !== "main" && actor !== "advisor") ||
		!boundedString(taskId) ||
		!boundedString(callId) ||
		!validRevision(evidenceRevision) ||
		!isPlainDataObject(identityValue)
	) {
		return null;
	}

	const transport = dataProperty(identityValue, "transport");
	const serverId = dataProperty(identityValue, "serverId");
	const toolName = dataProperty(identityValue, "toolName");
	const qualifiedName = dataProperty(identityValue, "qualifiedName");
	const args = dataProperty(identityValue, "args");
	const argsFingerprint = dataProperty(identityValue, "argsFingerprint");
	const access = dataProperty(identityValue, "access");
	if (
		!boundedString(serverId) ||
		!boundedString(toolName) ||
		!boundedString(qualifiedName) ||
		!isPlainDataObject(args) ||
		!boundedString(argsFingerprint) ||
		(access !== "read" && access !== "write")
	) {
		return null;
	}
	const actualFingerprint = canonicalArgsFingerprint(args);
	if (!actualFingerprint || actualFingerprint !== argsFingerprint) return null;

	if (transport === "builtin") {
		if (serverId !== BUILTIN_SERVER_ID || qualifiedName !== `${BUILTIN_SERVER_ID}.${toolName}` || access !== "write") {
			return null;
		}
		return {
			actor,
			taskId,
			callId,
			evidenceRevision,
			identity: identityValue as unknown as CanonicalBuiltinToolIdentity,
			isCodebase: false,
		};
	}

	if (transport !== "direct" && transport !== "mcp" && transport !== "xdev") return null;
	const expectedAccess = codebaseToolAccess(toolName);
	if (
		serverId !== CANONICAL_CODEBASE_SERVER_ID ||
		qualifiedName !== `${CANONICAL_CODEBASE_SERVER_ID}.${toolName}` ||
		expectedAccess !== access
	) {
		return null;
	}
	return {
		actor,
		taskId,
		callId,
		evidenceRevision,
		identity: identityValue as unknown as CanonicalToolIdentity,
		isCodebase: true,
	};
}

function normalizeRepositoryPath(value: unknown): string | null {
	if (!boundedString(value, MAX_PATH_BYTES) || value !== value.trim() || value.includes("\\")) return null;
	if (posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return null;
	const segments = value.split("/");
	if (segments.some((segment) => segment === ".." || segment.length === 0)) return null;
	const normalized = posix.normalize(value);
	return normalized === "." || normalized.startsWith("../") ? null : normalized;
}

function normalizedPathList(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || utilTypes.isProxy(value) || canonicalJson(value) === null) return null;
	const normalized: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) return null;
		const path = normalizeRepositoryPath(descriptor.value);
		if (!path) return null;
		normalized.push(path);
	}
	return normalized;
}

function validateContext(value: unknown): {
	evidenceRevision: `sha256:${string}`;
	contract?: TaskContract;
	codebasePack?: CodebaseEvidencePack;
	trustedCodebaseContext?: TrustedCodebaseValidationContext;
} | null {
	if (!isPlainDataObject(value)) return null;
	const evidenceRevision = dataProperty(value, "evidenceRevision");
	const contract = dataProperty(value, "contract");
	const codebasePack = dataProperty(value, "codebasePack");
	const trustedCodebaseContext = dataProperty(value, "trustedCodebaseContext");
	if (!validRevision(evidenceRevision)) return null;
	if (contract !== undefined && !isPlainDataObject(contract)) return null;
	if (codebasePack !== undefined && !isPlainDataObject(codebasePack)) return null;
	if (contract !== undefined && normalizedPathList(dataProperty(contract, "affectedFiles")) === null) return null;
	if (
		codebasePack !== undefined &&
		(!validRevision(dataProperty(codebasePack, "evidenceRevision")) ||
			normalizedPathList(dataProperty(codebasePack, "allowedNewFileRoots")) === null)
	) {
		return null;
	}
	return {
		evidenceRevision,
		contract: contract as TaskContract | undefined,
		codebasePack: codebasePack as CodebaseEvidencePack | undefined,
		trustedCodebaseContext: trustedCodebaseContext as TrustedCodebaseValidationContext | undefined,
	};
}

function extractDirectTargets(args: Record<string, unknown>): readonly string[] | null {
	const keys = ["path", "file", "filePath", "file_path"];
	const present = keys.filter((key) => dataProperty(args, key) !== undefined);
	if (present.length !== 1) return null;
	const target = normalizeRepositoryPath(dataProperty(args, present[0]));
	return target ? [target] : null;
}

function tokenizeShell(command: unknown): string[] | null {
	if (!boundedString(command, 16 * 1024) || /[\0\r\n`$\\;&|<>()[\]{}*?]/.test(command)) return null;
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	for (const character of command) {
		if (quote) {
			if (character === quote) quote = null;
			else token += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (token) {
				tokens.push(token);
				token = "";
				if (tokens.length > MAX_SHELL_TOKENS) return null;
			}
			continue;
		}
		token += character;
	}
	if (quote) return null;
	if (token) tokens.push(token);
	return tokens.length > 0 && tokens.length <= MAX_SHELL_TOKENS ? tokens : null;
}

function operands(tokens: readonly string[], start: number): string[] | null {
	const result: string[] = [];
	let optionsEnded = false;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index];
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-")) return null;
		const path = normalizeRepositoryPath(token);
		if (!path) return null;
		result.push(path);
	}
	return result.length > 0 ? result : null;
}

function classifyShell(args: Record<string, unknown>): ShellClassification {
	const tokens = tokenizeShell(dataProperty(args, "command"));
	if (!tokens) return { kind: "write", targets: null };
	const command = tokens[0];
	const unsafeReadOption = tokens.some(
		(token) =>
			token === "--ext-diff" ||
			token === "--textconv" ||
			token === "--open-files-in-pager" ||
			token === "--pre" ||
			token.startsWith("--pre=") ||
			token === "--output" ||
			token.startsWith("--output="),
	);
	if (!unsafeReadOption && READ_ONLY_COMMANDS.has(command)) return { kind: "read" };
	if (SIMPLE_MUTATION_COMMANDS.has(command)) return { kind: "write", targets: operands(tokens, 1) };
	if (command === "cp") {
		const parsed = operands(tokens, 1);
		return { kind: "write", targets: parsed && parsed.length >= 2 ? [parsed.at(-1) as string] : null };
	}
	if (command === "mv") return { kind: "write", targets: operands(tokens, 1) };
	return { kind: "write", targets: null };
}

function pathAllowed(target: string, contractPaths: readonly string[], allowedRoots: readonly string[]): boolean {
	if (contractPaths.includes(target)) return true;
	return allowedRoots.some((root) => target === root || target.startsWith(`${root}/`));
}

export class PreToolPolicy {
	constructor(private readonly evidence: PreToolEvidenceSink) {}

	evaluate(callInput: CanonicalToolCall, contextInput: PreToolContext): PreToolDecision {
		const task = safeEvidenceLabel(callInput, "taskId", "<invalid-task>");
		const callId = safeEvidenceLabel(callInput, "callId", "<invalid-call>");
		const evidenceMetadata = blockedEvidenceMetadata(callInput, contextInput);
		const deny = (reason: PreToolDenyReason): PreToolDecision => {
			try {
				this.evidence.append({
					event: "tool_call_blocked",
					task,
					call: callId,
					...evidenceMetadata,
					reason,
					remediationHint: REMEDIATION_HINT,
					remediationAction: REMEDIATION_ACTIONS[reason],
				});
				return { allow: false, reason };
			} catch {
				return { allow: false, reason, evidenceWriteFailed: true };
			}
		};

		const call = validateCall(callInput);
		const context = validateContext(contextInput);
		if (!call || !context) return deny("invalid_input");

		if (call.actor === "advisor") {
			if (!call.isCodebase || !isAdvisorCodebaseToolAllowed(call.identity)) {
				return deny("advisor_tool_forbidden");
			}
			return { allow: true };
		}

		if (call.isCodebase) {
			if (call.identity.access === "read") return { allow: true };
			if (call.identity.toolName === "index_repository") return { allow: true, invalidatesEvidence: true };
			return deny("unknown_tool");
		}

		const toolName = call.identity.toolName;
		if (!MUTATING_BUILTINS.has(toolName)) return deny("unknown_tool");
		let targets: readonly string[] | null = [];
		if (TARGETED_BUILTINS.has(toolName)) targets = extractDirectTargets(call.identity.args);
		if (toolName === "bash") {
			const shell = classifyShell(call.identity.args);
			if (shell.kind === "read") return { allow: true };
			targets = shell.targets;
		}

		if (!context.contract) return deny("missing_contract");
		let validatedContract: TaskContract;
		try {
			validatedContract = validateTaskContractIntegrity(context.contract);
		} catch {
			return deny("invalid_codebase_evidence");
		}
		if (!context.codebasePack || !context.trustedCodebaseContext) return deny("missing_codebase_evidence");
		try {
			const packErrors = validateCodebasePack(context.codebasePack, context.trustedCodebaseContext);
			if (packErrors.length > 0) return deny("invalid_codebase_evidence");
		} catch {
			return deny("invalid_codebase_evidence");
		}
		const trustedContract = context.trustedCodebaseContext.taskContract;
		if (
			validatedContract.revision !== trustedContract.revision ||
			validatedContract.taskId !== trustedContract.taskId ||
			validatedContract.projectId !== trustedContract.projectId ||
			validatedContract.gitHead !== trustedContract.gitHead ||
			validatedContract.revision !== context.codebasePack.taskContractRevision ||
			validatedContract.projectId !== context.codebasePack.projectId ||
			validatedContract.gitHead !== context.codebasePack.gitHead
		) {
			return deny("invalid_codebase_evidence");
		}
		if (call.taskId !== validatedContract.taskId || call.taskId !== trustedContract.taskId) {
			return deny("task_identity_mismatch");
		}
		if (
			call.evidenceRevision !== context.evidenceRevision ||
			call.evidenceRevision !== context.codebasePack.evidenceRevision
		) {
			return deny("stale_evidence");
		}

		if (toolName === "task" || toolName === "hub") return { allow: true };
		if (targets === null) return deny("scope_violation");
		const contractPaths = normalizedPathList(validatedContract.affectedFiles);
		const allowedRoots = normalizedPathList(context.codebasePack.allowedNewFileRoots);
		if (
			!contractPaths ||
			!allowedRoots ||
			targets.some((target) => !pathAllowed(target, contractPaths, allowedRoots))
		) {
			return deny("scope_violation");
		}
		return { allow: true };
	}
}
