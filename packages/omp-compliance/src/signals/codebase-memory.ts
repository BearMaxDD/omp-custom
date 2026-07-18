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
import { normalizeRepositoryPath } from "../contracts/task-contract";
import { READONLY_CODEBASE_TOOLS, WRITE_CODEBASE_TOOLS } from "../xdev/codebase-tool-policy";
import { canonicalArgsFingerprint, canonicalJson } from "../xdev/tool-identity";
import type {
	CodebaseEvidencePack,
	CodebaseMemoryEvidence,
	CodebaseToolEvidence,
	ToolCallRecord,
	ToolResultRecord,
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

export interface CodebaseEvidencePackInput {
	readonly projectId: string;
	readonly affectedFiles: readonly string[];
	readonly tools: readonly {
		readonly serverName: string;
		readonly qualifiedName: string;
		readonly toolName: string;
		readonly success: boolean;
		readonly params: Readonly<Record<string, unknown>>;
		readonly resultRef: string;
	}[];
}

export interface CodebasePackValidationOptions {
	readonly requiresTrace?: boolean;
	readonly taskSource?: "tdd" | "lightweight";
	readonly crossModule?: boolean;
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

function boundedPackString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string") throw new TypeError(`invalid_${label}`);
	const normalized = value.normalize("NFC").trim();
	if ((!allowEmpty && normalized.length === 0) || Buffer.byteLength(normalized, "utf8") > PACK_STRING_MAX_BYTES) {
		throw new TypeError(`invalid_${label}`);
	}
	return normalized;
}

function plainCanonical<T>(value: unknown, label: string): T {
	if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) throw new TypeError(`invalid_${label}`);
	const canonical = canonicalJson(value);
	if (canonical === null) throw new TypeError(`invalid_${label}`);
	return JSON.parse(canonical) as T;
}

function normalizePackPaths(values: unknown, allowEmpty = false): string[] {
	if (!Array.isArray(values) || values.length > PACK_PATH_MAX_ITEMS || (!allowEmpty && values.length === 0)) {
		throw new TypeError("invalid_affected_files");
	}
	const paths = new Map<string, string>();
	for (const value of values) {
		const path = normalizeRepositoryPath(value);
		const folded = path.toLocaleLowerCase("en-US");
		const existing = paths.get(folded);
		if (existing && existing !== path) throw new TypeError("ambiguous_affected_files");
		paths.set(folded, path);
	}
	return [...paths.values()].sort();
}

function toolAccess(toolName: string): "read" | "write" | null {
	if (READONLY_CODEBASE_TOOLS.has(toolName)) return "read";
	if (WRITE_CODEBASE_TOOLS.has(toolName)) return "write";
	return null;
}

function normalizeToolEvidence(tool: CodebaseEvidencePackInput["tools"][number]): CodebaseToolEvidence | null {
	const toolName = boundedPackString(tool.toolName, "tool_name");
	const access = toolAccess(toolName);
	if (
		!access ||
		tool.serverName !== EXPECTED_SERVER ||
		tool.qualifiedName !== `${EXPECTED_QUALIFIED_PREFIX}${toolName}` ||
		typeof tool.success !== "boolean"
	) {
		return null;
	}
	const paramsCanonical = canonicalJson(tool.params);
	if (paramsCanonical === null) throw new TypeError("invalid_tool_params");
	const params = JSON.parse(paramsCanonical) as Record<string, unknown>;
	const resultRef = boundedPackString(tool.resultRef, "result_ref", true);
	return {
		serverName: EXPECTED_SERVER,
		qualifiedName: `${EXPECTED_QUALIFIED_PREFIX}${toolName}`,
		toolName,
		access,
		success: tool.success,
		params,
		resultRef,
	};
}

function toolKey(tool: CodebaseToolEvidence): string {
	const paramsFingerprint = canonicalArgsFingerprint(tool.params);
	if (!paramsFingerprint) throw new TypeError("invalid_tool_params");
	return `${tool.toolName}\0${tool.success ? "1" : "0"}\0${paramsFingerprint}\0${tool.resultRef}`;
}

function indexFields(tool: CodebaseToolEvidence): { status?: string; revision?: string } {
	if (!tool.success || (tool.toolName !== "index_status" && tool.toolName !== "index_repository")) return {};
	try {
		const parsed = JSON.parse(tool.resultRef) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || utilTypes.isProxy(parsed)) return {};
		const status =
			typeof (parsed as Record<string, unknown>).status === "string"
				? boundedPackString((parsed as Record<string, unknown>).status, "index_status")
				: undefined;
		const rawRevision =
			(parsed as Record<string, unknown>).revision ?? (parsed as Record<string, unknown>).indexRevision;
		const revision = typeof rawRevision === "string" ? boundedPackString(rawRevision, "index_revision") : undefined;
		return { status, revision };
	} catch {
		return {};
	}
}

function freezePack(pack: CodebaseEvidencePack): CodebaseEvidencePack {
	const pending: object[] = [pack];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object.isFrozen(current)) continue;
		for (const child of Object.values(current)) {
			if (typeof child === "object" && child !== null) pending.push(child);
		}
		Object.freeze(current);
	}
	return pack;
}

export function computeEvidenceRevision(pack: Omit<CodebaseEvidencePack, "evidenceRevision">): `sha256:${string}` {
	const revision = canonicalArgsFingerprint(pack);
	if (!revision) throw new TypeError("invalid_evidence_pack");
	return revision;
}

export function createCodebaseEvidencePack(input: CodebaseEvidencePackInput): CodebaseEvidencePack {
	const safe = plainCanonical<CodebaseEvidencePackInput>(input, "evidence_pack_input");
	if (!Array.isArray(safe.tools) || safe.tools.length > PACK_TOOL_MAX_ITEMS) throw new TypeError("invalid_tools");
	const toolMap = new Map<string, CodebaseToolEvidence>();
	for (const rawTool of safe.tools) {
		const tool = normalizeToolEvidence(rawTool);
		if (tool) toolMap.set(toolKey(tool), tool);
	}
	const tools = [...toolMap.values()].sort((left, right) => toolKey(left).localeCompare(toolKey(right)));
	let indexRevision = "";
	for (const tool of tools) {
		const fields = indexFields(tool);
		if (fields.revision && tool.toolName === "index_status" && fields.status === "ready") {
			indexRevision = fields.revision;
			break;
		}
		if (!indexRevision && fields.revision) indexRevision = fields.revision;
	}
	const body = {
		projectId: boundedPackString(safe.projectId, "project_id"),
		indexRevision,
		affectedFiles: normalizePackPaths(safe.affectedFiles),
		tools,
	};
	return freezePack({ ...body, evidenceRevision: computeEvidenceRevision(body) });
}

export function validateCodebasePack(
	pack: CodebaseEvidencePack,
	changedFiles: readonly string[],
	options: CodebasePackValidationOptions = {},
): string[] {
	const safePack = plainCanonical<CodebaseEvidencePack>(pack, "evidence_pack");
	const safeOptions = plainCanonical<CodebasePackValidationOptions>(options, "pack_validation_options");
	const normalizedChangedFiles = normalizePackPaths(changedFiles, true);
	const errors: string[] = [];
	if (!safePack.indexRevision) errors.push("missing_index_revision");
	const successfulTools = safePack.tools.filter((tool) => {
		const normalized = normalizeToolEvidence(tool);
		return normalized?.success === true && normalized.access === "read";
	});
	const successful = (toolName: string) => successfulTools.some((tool) => tool.toolName === toolName);
	const readyIndexStatus = successfulTools.some(
		(tool) => tool.toolName === "index_status" && indexFields(tool).status === "ready",
	);
	if (!readyIndexStatus) errors.push("missing_index_status");
	if (!successful("get_code_snippet")) errors.push("missing_snippet");
	const affectedFiles = normalizePackPaths(safePack.affectedFiles);
	const traceRequired =
		safeOptions.requiresTrace === true ||
		safeOptions.taskSource === "tdd" ||
		safeOptions.crossModule === true ||
		affectedFiles.length > 1;
	if (traceRequired && !successful("trace_path")) errors.push("missing_trace");
	const covered = new Set(affectedFiles);
	for (const file of normalizedChangedFiles) if (!covered.has(file)) errors.push(`uncovered_file:${file}`);
	const { evidenceRevision: _ignored, ...revisionBody } = safePack;
	if (computeEvidenceRevision(revisionBody) !== safePack.evidenceRevision) errors.push("evidence_revision_mismatch");
	return errors;
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
