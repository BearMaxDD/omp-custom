/**
 * Codebase Memory MCP Evidence Normalizer.
 *
 * Recognizes codebase-memory tool interactions by exact tool name
 * matching (not natural language content). Produces a structured
 * evidence summary from paired tool_call / tool_result events.
 *
 * Only these tool names are recognized:
 *   - index_repository, index_status     (indexing)
 *   - get_architecture, search_graph, search_code, trace_path,
 *     get_code_snippet, query_graph      (read-only queries)
 *
 * The normalizer NEVER matches based on natural language output
 * (e.g. standalone "search_graph" in a response). Only the server
 * + toolName field from a tool_call event is used.
 */

import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { normalizeRepositoryPath, validateTaskContractIntegrity } from "../contracts/task-contract";
import { READONLY_CODEBASE_TOOLS, WRITE_CODEBASE_TOOLS } from "../xdev/codebase-tool-policy";
import { canonicalArgsFingerprint, canonicalJson } from "../xdev/tool-identity";
import { type TrustedCodebaseEvidenceReader, snapshotTrustedCodebaseEvidence } from "./collector-runtime";
import type {
	CodebaseEvidencePack,
	CodebaseMemoryEvidence,
	CodebaseSymbolEvidence,
	CodebaseToolEvidence,
	CodebaseTraceEvidence,
	ToolCallRecord,
	ToolResultRecord,
	TrustedCodebaseValidationContext,
} from "./types";

/** The set of recognized codebase-memory tool names. */
const RECOGNIZED_TOOLS: ReadonlySet<string> = new Set([
	"index_repository",
	"index_status",
	"get_architecture",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
	"query_graph",
]);

const QUERY_TOOLS: ReadonlySet<string> = new Set([
	"get_architecture",
	"search_graph",
	"search_code",
	"get_code_snippet",
	"trace_path",
	"query_graph",
]);

/** The MCP server name expected for codebase-memory tools. */
const EXPECTED_SERVER = "codebase-memory";
const EXPECTED_QUALIFIED_PREFIX = "codebase-memory-mcp.";
const PACK_STRING_MAX_BYTES = 4096;
const PACK_PATH_MAX_ITEMS = 512;
const PACK_TOOL_MAX_ITEMS = 256;

export interface TrustedCodebaseValidationContextInput {
	readonly taskContract: import("../contract/types").TaskContract;
	readonly codebaseProjectId: string;
	readonly indexRevision: string;
	readonly queriedAt: string;
	readonly changedFiles: readonly string[];
	readonly newFiles: readonly string[];
	readonly allowedNewFileRoots: readonly string[];
	readonly unresolvedClaims: readonly string[];
	readonly requiredSymbols: readonly string[];
}

/**
 * Input types accepted by normalizeCodebaseMemory.
 *
 * Array form: paired tool_call / tool_result records from the collector.
 * Single form: convenience for tests — a tool name and its result object.
 */
type PairedInput = ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>;
interface SingleInput {
	toolName: string;
	result: { success: boolean; status?: string };
}

/**
 * Determine whether a codebase-memory tool result indicates the index is ready.
 *
 * - index_repository: success + status in ["indexed", "ready"] → ready
 * - index_status:     success + status === "ready" → ready
 * - other tools:      never considered index-readiness
 */
export function codebaseIndexReady(toolName: string, result: { success: boolean; status?: string }): boolean {
	return (
		result.success === true &&
		((toolName === "index_repository" && (result.status === "indexed" || result.status === "ready")) ||
			(toolName === "index_status" && result.status === "ready"))
	);
}

/**
 * Parse a `status` field from a resultRef string if it contains JSON.
 */
function parseStatusFromRef(resultRef: string): string | undefined {
	try {
		const parsed = JSON.parse(resultRef);
		if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
			return parsed.status;
		}
	} catch {
		// Not valid JSON — no status to extract
	}
	return undefined;
}

/**
 * Normalize paired call/result entries into codebase-memory evidence.
 *
 * Returns index readiness flag, query names, and file references.
 */
export function normalizeCodebaseMemory(paired: PairedInput | SingleInput): {
	indexReady: boolean;
	queries: string[];
	references: string[];
} {
	// Single-input convenience (test path)
	if ("toolName" in paired) {
		return {
			indexReady: codebaseIndexReady(paired.toolName, paired.result),
			queries: [],
			references: [],
		};
	}

	const queryNames: string[] = [];
	const allRefs: string[] = [];
	const evidences: CodebaseMemoryEvidence[] = [];

	for (const { call, result } of paired) {
		const toolName = call.toolName;
		const serverName = call.serverName ?? "";

		if (serverName !== EXPECTED_SERVER) continue;
		if (call.qualifiedName !== `${EXPECTED_QUALIFIED_PREFIX}${toolName}`) continue;
		if (!RECOGNIZED_TOOLS.has(toolName)) continue;

		const success = result?.success ?? false;

		// Failed and missing results never establish retrieval evidence.
		if (result?.success === true && QUERY_TOOLS.has(toolName)) {
			const refs = extractReferences(result.resultRef);
			allRefs.push(...refs);
		}

		if (result?.success === true && QUERY_TOOLS.has(toolName)) {
			queryNames.push(toolName);
		}

		evidences.push({
			serverName,
			toolName,
			success,
			params: call.params,
			resultRef: result?.resultRef ?? "",
		});
	}

	// Determine indexReady: match on tool name and result status.
	let isIndexReady = false;
	for (const ev of evidences) {
		const status = parseStatusFromRef(ev.resultRef);
		if (codebaseIndexReady(ev.toolName, { success: ev.success, status })) {
			isIndexReady = true;
			break;
		}
	}

	return {
		indexReady: isIndexReady,
		queries: [...new Set(queryNames)],
		references: [...new Set(allRefs)],
	};
}

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_HEAD_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CODEBASE_PROJECT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const CONTEXT_INPUT_KEYS = new Set([
	"taskContract",
	"codebaseProjectId",
	"indexRevision",
	"queriedAt",
	"changedFiles",
	"newFiles",
	"allowedNewFileRoots",
	"unresolvedClaims",
	"requiredSymbols",
]);
const PACK_KEYS = new Set([
	"schemaVersion",
	"evidenceRevision",
	"projectId",
	"taskContractRevision",
	"codebaseProjectId",
	"indexRevision",
	"gitHead",
	"diffHash",
	"queriedAt",
	"tools",
	"symbols",
	"traces",
	"affectedFiles",
	"changedFiles",
	"newFiles",
	"allowedNewFileRoots",
	"unresolvedClaims",
	"requiredSymbols",
]);
const CONTEXT_KEYS = new Set([
	"taskContract",
	"codebaseProjectId",
	"diffHash",
	"indexRevision",
	"queriedAt",
	"changedFiles",
	"newFiles",
	"allowedNewFileRoots",
	"unresolvedClaims",
	"requiredSymbols",
]);
const CALL_KEYS = new Set([
	"toolName",
	"toolCallId",
	"serverName",
	"qualifiedName",
	"argsFingerprint",
	"params",
	"cwd",
	"sessionId",
	"timestamp",
]);
const RESULT_KEYS = new Set([
	"toolCallId",
	"success",
	"resultRef",
	"source",
	"details",
	"detailsTruncated",
	"detailsFailure",
	"timestamp",
]);

function boundedPackString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string") throw new TypeError(`invalid_${label}`);
	const normalized = value.normalize("NFC").trim();
	if ((!allowEmpty && normalized.length === 0) || Buffer.byteLength(normalized, "utf8") > PACK_STRING_MAX_BYTES)
		throw new TypeError(`invalid_${label}`);
	return normalized;
}

function strictIso(value: unknown, label: string): string {
	const text = boundedPackString(value, label);
	const timestamp = Date.parse(text);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text)
		throw new TypeError(`invalid_${label}`);
	return text;
}

function strictHash(value: unknown, label: string): `sha256:${string}` {
	const text = boundedPackString(value, label);
	if (!SHA256_RE.test(text)) throw new TypeError(`invalid_${label}`);
	return text as `sha256:${string}`;
}

function strictProjectId(value: unknown): string {
	const projectId = boundedPackString(value, "project_id");
	if (!UUID_V4_RE.test(projectId)) throw new TypeError("invalid_project_id");
	return projectId.toLowerCase();
}

function strictGitHead(value: unknown): string {
	const gitHead = boundedPackString(value, "git_head");
	if (!GIT_HEAD_RE.test(gitHead)) throw new TypeError("invalid_git_head");
	return gitHead;
}

function strictCodebaseProjectId(value: unknown): string {
	const projectId = boundedPackString(value, "codebase_project_id");
	if (!CODEBASE_PROJECT_RE.test(projectId) || projectId.includes(".."))
		throw new TypeError("invalid_codebase_project_id");
	return projectId;
}

function taskBinding(taskContract: import("../contract/types").TaskContract): {
	projectId: string;
	gitHead: string;
	affectedFiles: string[];
	revision: `sha256:${string}`;
	source: "tdd" | "lightweight";
	taskId: string;
} {
	const validated = validateTaskContractIntegrity(taskContract);
	return {
		projectId: strictProjectId(validated.projectId),
		gitHead: strictGitHead(validated.gitHead),
		affectedFiles: normalizePackPaths(validated.affectedFiles),
		revision: strictHash(validated.revision, "task_contract_revision"),
		source: validated.source,
		taskId: boundedPackString(validated.taskId, "task_id"),
	};
}

function plainCanonical<T>(value: unknown, label: string): T {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) throw new TypeError(`invalid_${label}`);
	const canonical = canonicalJson(value);
	if (canonical === null) throw new TypeError(`invalid_${label}`);
	return JSON.parse(canonical) as T;
}

function assertKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown_${label}_field:${key}`);
}

function normalizePackPaths(values: unknown, allowEmpty = false, label = "affected_files"): string[] {
	if (!Array.isArray(values) || values.length > PACK_PATH_MAX_ITEMS || (!allowEmpty && values.length === 0))
		throw new TypeError(`invalid_${label}`);
	const paths = new Map<string, string>();
	for (const value of values) {
		const path = normalizeRepositoryPath(value);
		const folded = path.toLocaleLowerCase("en-US");
		const existing = paths.get(folded);
		if (existing && existing !== path) throw new TypeError(`ambiguous_${label}`);
		paths.set(folded, path);
	}
	return [...paths.values()].sort();
}

function normalizeClaims(values: unknown): string[] {
	if (!Array.isArray(values) || values.length > PACK_PATH_MAX_ITEMS) throw new TypeError("invalid_unresolved_claims");
	return [...new Set(values.map((value) => boundedPackString(value, "unresolved_claim")))].sort();
}

function toolAccess(toolName: string): "read" | "write" | null {
	if (READONLY_CODEBASE_TOOLS.has(toolName)) return "read";
	if (WRITE_CODEBASE_TOOLS.has(toolName)) return "write";
	return null;
}

function normalizePair(pair: { call: ToolCallRecord; result?: ToolResultRecord }): CodebaseToolEvidence {
	assertKeys(pair, new Set(["call", "result"]), "tool_pair");
	if (!pair.result) throw new TypeError("missing_tool_result");
	const { call, result } = pair;
	assertKeys(call, CALL_KEYS, "tool_call");
	assertKeys(result, RESULT_KEYS, "tool_result");
	const toolName = boundedPackString(call.toolName, "tool_name");
	const access = toolAccess(toolName);
	if (
		!access ||
		call.serverName !== EXPECTED_SERVER ||
		call.qualifiedName !== `${EXPECTED_QUALIFIED_PREFIX}${toolName}`
	)
		throw new TypeError("invalid_tool_identity");
	const toolCallId = boundedPackString(call.toolCallId, "tool_call_id");
	if (result.toolCallId !== toolCallId) throw new TypeError("tool_result_id_mismatch");
	const argsFingerprint = strictHash(call.argsFingerprint, "args_fingerprint");
	if (result.source !== "official") throw new TypeError("untrusted_tool_result_source");
	if (
		typeof result.success !== "boolean" ||
		typeof result.detailsTruncated !== "boolean" ||
		typeof result.detailsFailure !== "boolean"
	)
		throw new TypeError("invalid_tool_result");
	const params = plainCanonical<Record<string, unknown>>(call.params, "tool_params");
	const paramsLossless = Object.values(params).every(
		(value) =>
			value === null ||
			typeof value === "boolean" ||
			typeof value === "number" ||
			(typeof value === "string" && !/^(?:\[array:\d+\]|\{object:\d+\})$/.test(value) && !/…\[\+\d+\]$/.test(value)),
	);
	if (paramsLossless && canonicalArgsFingerprint(params) !== argsFingerprint)
		throw new TypeError("args_fingerprint_mismatch");
	const callTimestamp = strictIso(call.timestamp, "tool_call_timestamp");
	const resultTimestamp = strictIso(result.timestamp, "tool_result_timestamp");
	const resultRef = boundedPackString(result.resultRef, "result_ref", true);
	const details =
		result.details === undefined ? undefined : plainCanonical<Record<string, unknown>>(result.details, "tool_details");
	return {
		toolCallId,
		serverName: EXPECTED_SERVER,
		qualifiedName: `${EXPECTED_QUALIFIED_PREFIX}${toolName}`,
		toolName,
		argsFingerprint,
		access,
		success: result.success,
		source: "official",
		params,
		resultRef,
		...(details ? { details } : {}),
		detailsTruncated: result.detailsTruncated,
		detailsFailure: result.detailsFailure,
		callTimestamp,
		resultTimestamp,
	};
}

function resultObject(tool: CodebaseToolEvidence): Record<string, unknown> {
	if (tool.details) return tool.details as Record<string, unknown>;
	try {
		const parsed = JSON.parse(tool.resultRef) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function indexFields(tool: CodebaseToolEvidence): { status?: string; revision?: string } {
	if (!tool.success || tool.detailsTruncated || tool.detailsFailure || tool.toolName !== "index_status") return {};
	const value = resultObject(tool);
	return {
		status: typeof value.status === "string" ? value.status : undefined,
		revision:
			typeof value.revision === "string"
				? value.revision
				: typeof value.indexRevision === "string"
					? value.indexRevision
					: undefined,
	};
}

function collectObjects(value: unknown): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const pending: unknown[] = [value];
	let visited = 0;
	while (pending.length > 0 && visited++ < 4096) {
		const current = pending.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (const item of current) pending.push(item);
			continue;
		}
		const record = current as Record<string, unknown>;
		result.push(record);
		for (const child of Object.values(record)) if (typeof child === "object" && child !== null) pending.push(child);
	}
	return result;
}

function safeExtractPath(value: unknown): string | undefined {
	try {
		return normalizeRepositoryPath(value);
	} catch {
		return undefined;
	}
}

function relatedFiles(tool: CodebaseToolEvidence): string[] {
	const files = new Set(
		extractReferences(tool.resultRef)
			.map((file) => safeExtractPath(file))
			.filter((file): file is string => Boolean(file)),
	);
	for (const object of collectObjects(tool.details)) {
		const file = safeExtractPath(object.file_path ?? object.file);
		if (file) files.add(file);
	}
	return [...files].sort();
}

function deriveSymbols(tools: readonly CodebaseToolEvidence[]): CodebaseSymbolEvidence[] {
	const symbols = new Map<string, CodebaseSymbolEvidence>();
	for (const tool of tools) {
		if (
			!tool.success ||
			tool.detailsTruncated ||
			tool.detailsFailure ||
			!["search_graph", "get_code_snippet"].includes(tool.toolName)
		)
			continue;
		const objects = collectObjects(tool.details);
		if (tool.toolName === "get_code_snippet")
			objects.push({ qualified_name: tool.params.qualified_name, file_path: relatedFiles(tool)[0] });
		for (const object of objects) {
			const qualifiedName =
				typeof (object.qualified_name ?? object.qualifiedName) === "string"
					? boundedPackString(object.qualified_name ?? object.qualifiedName, "qualified_name")
					: undefined;
			const file = safeExtractPath(object.file_path ?? object.file);
			if (!qualifiedName || !file) continue;
			const line =
				typeof object.line === "number" && Number.isSafeInteger(object.line) && object.line > 0
					? object.line
					: undefined;
			const symbol = { qualifiedName, file, ...(line ? { line } : {}) };
			symbols.set(`${qualifiedName}\0${file}\0${line ?? ""}`, symbol);
		}
	}
	return [...symbols.values()].sort((left, right) =>
		`${left.qualifiedName}\0${left.file}`.localeCompare(`${right.qualifiedName}\0${right.file}`),
	);
}

function deriveTraces(tools: readonly CodebaseToolEvidence[]): CodebaseTraceEvidence[] {
	const traces = new Map<string, CodebaseTraceEvidence>();
	for (const tool of tools) {
		if (
			!tool.success ||
			tool.detailsTruncated ||
			tool.detailsFailure ||
			!["trace_path", "query_graph"].includes(tool.toolName)
		)
			continue;
		for (const object of collectObjects(resultObject(tool))) {
			if (typeof object.source !== "string" || typeof object.target !== "string") continue;
			const direction =
				object.direction === "inbound" || object.direction === "outbound"
					? object.direction
					: tool.params.direction === "inbound"
						? "inbound"
						: "outbound";
			const trace = {
				source: boundedPackString(object.source, "trace_source"),
				target: boundedPackString(object.target, "trace_target"),
				direction,
			} as const;
			traces.set(`${trace.source}\0${trace.target}\0${direction}`, trace);
			if (traces.size > PACK_TOOL_MAX_ITEMS) throw new TypeError("invalid_traces");
		}
	}
	return [...traces.values()].sort((left, right) =>
		`${left.source}\0${left.target}`.localeCompare(`${right.source}\0${right.target}`),
	);
}

function deepFreezeValue<T>(value: T): T {
	const pending: object[] = typeof value === "object" && value !== null ? [value] : [];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object.isFrozen(current)) continue;
		for (const child of Object.values(current)) if (typeof child === "object" && child !== null) pending.push(child);
		Object.freeze(current);
	}
	return value;
}

interface TrustedContextInternal {
	readonly pairs: ReadonlyArray<{ readonly call: ToolCallRecord; readonly result: ToolResultRecord }>;
}

const trustedContexts = new WeakMap<object, TrustedContextInternal>();

function authenticateContext(context: TrustedCodebaseValidationContext): TrustedContextInternal {
	if (typeof context !== "object" || context === null || utilTypes.isProxy(context)) {
		throw new TypeError("invalid_trusted_context");
	}
	const internal = trustedContexts.get(context);
	if (!internal) throw new TypeError("invalid_trusted_context");
	return internal;
}

function captureCollectorPairs(
	reader: TrustedCodebaseEvidenceReader,
): Array<{ call: ToolCallRecord; result: ToolResultRecord }> {
	const snapshot = snapshotTrustedCodebaseEvidence(reader);
	const results = new Map(snapshot.results.map((result) => [result.toolCallId, result]));
	const pairs = snapshot.calls.flatMap((call) => {
		const result = results.get(call.toolCallId);
		if (!result) return [];
		return [
			{
				call: {
					toolName: call.toolName,
					toolCallId: call.toolCallId,
					...(call.serverName === undefined ? {} : { serverName: call.serverName }),
					...(call.qualifiedName === undefined ? {} : { qualifiedName: call.qualifiedName }),
					...(call.argsFingerprint === undefined ? {} : { argsFingerprint: call.argsFingerprint }),
					params: call.params,
					...(call.cwd === undefined ? {} : { cwd: call.cwd }),
					...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
					timestamp: call.timestamp,
				},
				result: {
					toolCallId: result.toolCallId,
					success: result.success,
					resultRef: result.resultRef,
					source: result.source,
					...(result.details === undefined ? {} : { details: result.details }),
					...(result.detailsTruncated === undefined ? {} : { detailsTruncated: result.detailsTruncated }),
					...(result.detailsFailure === undefined ? {} : { detailsFailure: result.detailsFailure }),
					timestamp: result.timestamp,
				},
			},
		];
	});
	const safePairs = plainCanonical<Array<{ call: ToolCallRecord; result: ToolResultRecord }>>(pairs, "collector_pairs");
	if (safePairs.length > PACK_TOOL_MAX_ITEMS) throw new TypeError("invalid_collector_pairs");
	for (const pair of safePairs) normalizePair(pair);
	return safePairs;
}

function computeDiffHash(
	gitHead: string,
	changedFiles: readonly string[],
	newFiles: readonly string[],
): `sha256:${string}` {
	const revision = canonicalArgsFingerprint({ gitHead, changedFiles, newFiles });
	if (!revision) throw new TypeError("invalid_diff_snapshot");
	return revision;
}

export function createTrustedCodebaseValidationContext(
	reader: TrustedCodebaseEvidenceReader,
	input: TrustedCodebaseValidationContextInput,
): TrustedCodebaseValidationContext {
	const pairs = captureCollectorPairs(reader);
	const safe = plainCanonical<TrustedCodebaseValidationContextInput>(input, "trusted_context_input");
	assertKeys(safe, CONTEXT_INPUT_KEYS, "trusted_context_input");
	const taskContract = validateTaskContractIntegrity(safe.taskContract);
	const task = taskBinding(taskContract);
	const codebaseProjectId = strictCodebaseProjectId(safe.codebaseProjectId);
	const indexRevision = boundedPackString(safe.indexRevision, "context_index_revision");
	const queriedAt = strictIso(safe.queriedAt, "queried_at");
	const changedFiles = normalizePackPaths(safe.changedFiles, true, "changed_files");
	const newFiles = normalizePackPaths(safe.newFiles, true, "new_files");
	const allowedNewFileRoots = normalizePackPaths(safe.allowedNewFileRoots, true, "allowed_new_file_roots");
	const unresolvedClaims = normalizeClaims(safe.unresolvedClaims);
	const requiredSymbols = normalizeClaims(safe.requiredSymbols);
	if (task.source === "tdd" && requiredSymbols.length === 0) throw new TypeError("missing_required_symbols");
	if (task.source === "tdd" && changedFiles.length === 0) throw new TypeError("missing_changed_files");
	const changedSet = new Set(changedFiles);
	for (const file of task.affectedFiles) if (!changedSet.has(file)) throw new TypeError(`missing_changed_file:${file}`);
	for (const file of newFiles) if (!changedSet.has(file)) throw new TypeError(`new_file_not_changed:${file}`);
	for (const pair of pairs) {
		const tool = normalizePair(pair);
		if (tool.access === "read" && tool.params.project !== codebaseProjectId) {
			throw new TypeError(`project_mismatch:${tool.toolName}`);
		}
		if (
			Date.parse(tool.callTimestamp) > Date.parse(tool.resultTimestamp) ||
			Date.parse(tool.resultTimestamp) > Date.parse(queriedAt)
		) {
			throw new TypeError("invalid_tool_time_order");
		}
	}
	const context = deepFreezeValue({
		taskContract,
		codebaseProjectId,
		diffHash: computeDiffHash(task.gitHead, changedFiles, newFiles),
		indexRevision,
		queriedAt,
		changedFiles,
		newFiles,
		allowedNewFileRoots,
		unresolvedClaims,
		requiredSymbols,
	}) as unknown as TrustedCodebaseValidationContext;
	trustedContexts.set(context, deepFreezeValue({ pairs }));
	return context;
}

export function computeEvidenceRevision(pack: Omit<CodebaseEvidencePack, "evidenceRevision">): `sha256:${string}` {
	const revision = canonicalArgsFingerprint(pack);
	if (!revision) throw new TypeError("invalid_evidence_pack");
	return revision;
}

export function createCodebaseEvidencePack(context: TrustedCodebaseValidationContext): CodebaseEvidencePack {
	const internal = authenticateContext(context);
	const safe = plainCanonical<TrustedCodebaseValidationContext>(context, "trusted_validation_context");
	assertKeys(safe, CONTEXT_KEYS, "trusted_validation_context");
	const task = taskBinding(safe.taskContract);
	const codebaseProjectId = strictCodebaseProjectId(safe.codebaseProjectId);
	const queriedAt = strictIso(safe.queriedAt, "queried_at");
	const tools: CodebaseToolEvidence[] = [];
	const seen = new Map<string, string>();
	for (const pair of internal.pairs) {
		const tool = normalizePair(pair);
		if (tool.access === "read" && tool.params.project !== codebaseProjectId) {
			throw new TypeError(`project_mismatch:${tool.toolName}`);
		}
		if (
			Date.parse(tool.callTimestamp) > Date.parse(tool.resultTimestamp) ||
			Date.parse(tool.resultTimestamp) > Date.parse(queriedAt)
		) {
			throw new TypeError("invalid_tool_time_order");
		}
		const canonical = canonicalJson(tool);
		if (!canonical) throw new TypeError("invalid_tool_pair");
		const previous = seen.get(tool.toolCallId);
		if (previous && previous !== canonical) throw new TypeError("conflicting_tool_call_id");
		if (!previous) {
			seen.set(tool.toolCallId, canonical);
			tools.push(tool);
		}
	}
	const readyRevisions = new Set(
		tools
			.map(indexFields)
			.filter((field) => field.status === "ready" && field.revision)
			.map((field) => field.revision as string),
	);
	if (readyRevisions.size > 1) throw new TypeError("conflicting_index_revision");
	const body = {
		schemaVersion: 1 as const,
		projectId: task.projectId,
		taskContractRevision: task.revision,
		codebaseProjectId,
		indexRevision: boundedPackString(safe.indexRevision, "context_index_revision"),
		gitHead: task.gitHead,
		diffHash: strictHash(safe.diffHash, "diff_hash"),
		queriedAt,
		tools,
		symbols: deriveSymbols(tools),
		traces: deriveTraces(tools),
		affectedFiles: task.affectedFiles,
		changedFiles: normalizePackPaths(safe.changedFiles, true, "changed_files"),
		newFiles: normalizePackPaths(safe.newFiles, true, "new_files"),
		allowedNewFileRoots: normalizePackPaths(safe.allowedNewFileRoots, true, "allowed_new_file_roots"),
		unresolvedClaims: normalizeClaims(safe.unresolvedClaims),
		requiredSymbols: normalizeClaims(safe.requiredSymbols),
	};
	return deepFreezeValue({ ...body, evidenceRevision: computeEvidenceRevision(body) });
}

function pathCovered(path: string, affected: ReadonlySet<string>, roots: readonly string[]): boolean {
	return affected.has(path) || roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function validateCodebasePack(pack: CodebaseEvidencePack, context: TrustedCodebaseValidationContext): string[] {
	const internal = authenticateContext(context);
	const safePack = plainCanonical<CodebaseEvidencePack>(pack, "evidence_pack");
	const safeContext = plainCanonical<TrustedCodebaseValidationContext>(context, "trusted_validation_context");
	assertKeys(safePack, PACK_KEYS, "evidence_pack");
	assertKeys(safeContext, CONTEXT_KEYS, "trusted_validation_context");
	const task = taskBinding(safeContext.taskContract);
	const contextCodebaseProjectId = strictCodebaseProjectId(safeContext.codebaseProjectId);
	const contextDiffHash = strictHash(safeContext.diffHash, "context_diff_hash");
	const contextIndexRevision = boundedPackString(safeContext.indexRevision, "context_index_revision");
	const requiredSymbols = normalizeClaims(safeContext.requiredSymbols);
	strictProjectId(safePack.projectId);
	strictHash(safePack.taskContractRevision, "task_contract_revision");
	strictCodebaseProjectId(safePack.codebaseProjectId);
	strictGitHead(safePack.gitHead);
	boundedPackString(safePack.indexRevision, "index_revision", true);
	if (safePack.schemaVersion !== 1 || !SHA256_RE.test(safePack.diffHash) || !SHA256_RE.test(safePack.evidenceRevision))
		throw new TypeError("invalid_evidence_pack_schema");
	strictIso(safePack.queriedAt, "queried_at");
	const changed = normalizePackPaths(safeContext.changedFiles, true, "changed_files");
	const newFiles = normalizePackPaths(safeContext.newFiles, true, "new_files");
	const affected = normalizePackPaths(safePack.affectedFiles);
	const roots = normalizePackPaths(safeContext.allowedNewFileRoots, true, "allowed_new_file_roots");
	const claims = normalizeClaims(safeContext.unresolvedClaims);
	if (!Array.isArray(safePack.tools) || safePack.tools.length > PACK_TOOL_MAX_ITEMS)
		throw new TypeError("invalid_tools");
	const affectedSet = new Set(task.affectedFiles);
	const newSet = new Set(newFiles);
	const errors: string[] = [];
	if (safePack.projectId !== task.projectId) errors.push("project_id_mismatch");
	if (safePack.taskContractRevision !== task.revision) errors.push("task_contract_mismatch");
	if (safePack.codebaseProjectId !== contextCodebaseProjectId) errors.push("codebase_project_id_mismatch");
	if (safePack.gitHead !== task.gitHead) errors.push("git_head_mismatch");
	if (safePack.diffHash !== contextDiffHash) errors.push("diff_hash_mismatch");
	if (safePack.indexRevision !== contextIndexRevision) errors.push("index_revision_mismatch");
	if (canonicalJson(affected) !== canonicalJson(task.affectedFiles)) errors.push("affected_files_mismatch");
	if (canonicalJson(safePack.changedFiles) !== canonicalJson(changed)) errors.push("changed_files_mismatch");
	if (canonicalJson(safePack.newFiles) !== canonicalJson(newFiles)) errors.push("new_files_mismatch");
	if (canonicalJson(safePack.allowedNewFileRoots) !== canonicalJson(safeContext.allowedNewFileRoots))
		errors.push("allowed_new_file_roots_mismatch");
	if (canonicalJson(safePack.unresolvedClaims) !== canonicalJson(safeContext.unresolvedClaims))
		errors.push("unresolved_claims_mismatch");
	if (canonicalJson(safePack.requiredSymbols) !== canonicalJson(requiredSymbols))
		errors.push("required_symbols_mismatch");
	if (safePack.queriedAt !== safeContext.queriedAt) errors.push("queried_at_mismatch");
	if (computeDiffHash(task.gitHead, changed, newFiles) !== contextDiffHash) errors.push("diff_hash_mismatch");
	const trusted: CodebaseToolEvidence[] = [];
	const ids = new Map<string, string>();
	for (const raw of safePack.tools) {
		try {
			const tool = normalizePair({
				call: {
					toolName: raw.toolName,
					toolCallId: raw.toolCallId,
					serverName: raw.serverName,
					qualifiedName: raw.qualifiedName,
					argsFingerprint: raw.argsFingerprint,
					params: raw.params,
					timestamp: raw.callTimestamp,
				},
				result: {
					toolCallId: raw.toolCallId,
					success: raw.success,
					source: raw.source,
					resultRef: raw.resultRef,
					...(raw.details ? { details: raw.details } : {}),
					detailsTruncated: raw.detailsTruncated,
					detailsFailure: raw.detailsFailure,
					timestamp: raw.resultTimestamp,
				},
			});
			const canonical = canonicalJson(tool) ?? "";
			const previous = ids.get(tool.toolCallId);
			if (previous && previous !== canonical) errors.push(`conflicting_tool_call_id:${tool.toolCallId}`);
			else if (!previous) {
				ids.set(tool.toolCallId, canonical);
				trusted.push(tool);
			}
		} catch {
			errors.push(`invalid_tool_evidence:${String(raw.toolCallId ?? "unknown")}`);
		}
	}
	const projectValid = (tool: CodebaseToolEvidence) =>
		tool.access !== "read" || tool.params.project === contextCodebaseProjectId;
	for (const tool of trusted) if (!projectValid(tool)) errors.push(`project_mismatch:${tool.toolName}`);
	const successful = trusted.filter(
		(tool) => tool.success && !tool.detailsFailure && !tool.detailsTruncated && projectValid(tool),
	);
	const statuses = successful
		.filter((tool) => tool.toolName === "index_status")
		.map(indexFields)
		.filter((field) => field.status === "ready" && field.revision);
	if (statuses.length === 0) errors.push("missing_index_status");
	else if (
		statuses.some((field) => field.revision !== safePack.indexRevision || field.revision !== contextIndexRevision)
	)
		errors.push("index_revision_mismatch");
	if (!safePack.indexRevision) errors.push("missing_index_revision");
	if (!successful.some((tool) => tool.toolName === "get_architecture" || tool.toolName === "search_graph"))
		errors.push("missing_architecture_or_search");
	const relevant = (tool: CodebaseToolEvidence) => relatedFiles(tool).some((file) => affectedSet.has(file));
	const searchSymbols = new Set(
		deriveSymbols(successful.filter((tool) => tool.toolName === "search_graph")).map((symbol) => symbol.qualifiedName),
	);
	const symbolTargets = requiredSymbols.length > 0 ? new Set(requiredSymbols) : searchSymbols;
	const relevantSnippets = successful.filter((tool) => {
		if (tool.toolName !== "get_code_snippet" || !relevant(tool)) return false;
		const qualifiedName = tool.params.qualified_name;
		return typeof qualifiedName === "string" && symbolTargets.has(qualifiedName) && searchSymbols.has(qualifiedName);
	});
	if (relevantSnippets.length === 0) errors.push("missing_relevant_snippet");
	const knownSymbols = new Set(deriveSymbols(successful).map((symbol) => symbol.qualifiedName));
	for (const required of requiredSymbols)
		if (!knownSymbols.has(required) || !searchSymbols.has(required)) errors.push(`missing_required_symbol:${required}`);
	const traceRequired = task.source === "tdd" || task.affectedFiles.length > 1;
	const relevantTrace = (tool: CodebaseToolEvidence) => {
		if (!(tool.toolName === "trace_path" || tool.toolName === "query_graph") || !relevant(tool)) return false;
		return deriveTraces([tool]).some((trace) => symbolTargets.has(trace.source) || symbolTargets.has(trace.target));
	};
	if (traceRequired && !successful.some(relevantTrace)) errors.push("missing_relevant_trace");
	for (const file of changed)
		if (!affectedSet.has(file) && !(newSet.has(file) && pathCovered(file, affectedSet, roots)))
			errors.push(`uncovered_file:${file}`);
	for (const file of newFiles)
		if (!pathCovered(file, new Set(), roots)) errors.push(`new_file_outside_allowed_root:${file}`);
	for (const claim of claims) errors.push(`unresolved_claim:${claim}`);
	const derivedSymbols = deriveSymbols(trusted);
	const derivedTraces = deriveTraces(trusted);
	if (canonicalJson(derivedSymbols) !== canonicalJson(safePack.symbols)) errors.push("symbols_mismatch");
	if (canonicalJson(derivedTraces) !== canonicalJson(safePack.traces)) errors.push("traces_mismatch");
	try {
		if (internal.pairs.length > PACK_TOOL_MAX_ITEMS) throw new TypeError("invalid_collector_pairs");
		const expectedPack = createCodebaseEvidencePack(context);
		if (expectedPack.indexRevision !== contextIndexRevision) errors.push("index_revision_mismatch");
		if (canonicalJson(expectedPack) !== canonicalJson(safePack)) errors.push("trusted_context_mismatch");
	} catch {
		errors.push("trusted_context_mismatch");
	}
	const { evidenceRevision: _ignored, ...revisionBody } = safePack;
	if (computeEvidenceRevision(revisionBody) !== safePack.evidenceRevision) errors.push("evidence_revision_mismatch");
	return [...new Set(errors)];
}

// ─── Helpers ────────────────────────────────────────────────────

/** Naive reference extraction from result text. Looks for file:path or path/to/file patterns. */
function extractReferences(text: string): string[] {
	const refs: string[] = [];
	const fileRefPattern = /\bfile:(?:[a-zA-Z]:[\\/])?([^\s,;)]+)/g;
	for (const match of text.matchAll(fileRefPattern)) {
		refs.push(match[1].replace(/^[\\/]+|\.$/, ""));
	}
	const pathPattern =
		/(?:^|[\s,;])((?:src|app|lib|packages|test)[^\s,;)]+\.(?:ts|tsx|js|jsx|py|rs|go|rb|css|scss|json|md|toml|yaml|yml))/g;
	for (const match of text.matchAll(pathPattern)) {
		refs.push(match[1]);
	}
	return refs;
}
