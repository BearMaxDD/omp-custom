import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	CANONICAL_CODEBASE_SERVER_ID,
	type CodebaseToolAccess,
	codebaseToolAccess,
	isTrustedCodebaseServerId,
} from "./codebase-tool-policy";

export interface CanonicalToolIdentity {
	transport: "direct" | "mcp" | "xdev";
	serverId: string;
	toolName: string;
	qualifiedName: string;
	args: Record<string, unknown>;
	argsFingerprint: `sha256:${string}`;
	access: CodebaseToolAccess;
}

export interface ToolIdentityInput {
	toolName: string;
	serverName?: string;
	args: unknown;
}

const HELP_CONTENT_RE = /^(?:|\?|help|describe)$/i;
export const CANONICAL_ARGS_MAX_BYTES = 64 * 1024;
const CANONICAL_ARGS_MAX_DEPTH = 32;
const CANONICAL_ARGS_MAX_NODES = 4096;
const CANONICAL_ARGS_MAX_KEYS = 4096;
const CANONICAL_ARGS_MAX_OBJECT_KEYS = 1024;
const CANONICAL_ARGS_MAX_ARRAY_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CanonicalizeState {
	remainingNodes: number;
	remainingKeys: number;
}

function boundedJsonStringBytes(value: string, maxBytes: number): number | null {
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x0c ||
			code === 0x0a ||
			code === 0x0d ||
			code === 0x09
		) {
			bytes += 2;
		} else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
			if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					bytes += 4;
					index++;
				} else {
					bytes += 6;
				}
			} else {
				bytes += 6;
			}
		} else if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else {
			bytes += 3;
		}
		if (bytes > maxBytes) return null;
	}
	return bytes;
}

function boundedJsonString(value: string, maxBytes: number): string | null {
	return boundedJsonStringBytes(value, maxBytes) === null ? null : JSON.stringify(value);
}

function consumeKey(state: CanonicalizeState): boolean {
	if (state.remainingKeys <= 0) return false;
	state.remainingKeys--;
	return true;
}

function canonicalizeJsonValue(
	value: unknown,
	ancestors: Set<object>,
	state: CanonicalizeState,
	depth: number,
	maxBytes: number,
): string | null {
	if (depth > CANONICAL_ARGS_MAX_DEPTH || state.remainingNodes <= 0 || maxBytes <= 0) return null;
	state.remainingNodes--;
	if (value === null) return "null";
	if (typeof value === "string") return boundedJsonString(value, maxBytes);
	if (typeof value === "boolean") return maxBytes >= 4 + Number(value) ? String(value) : null;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		const serialized = String(value);
		return Buffer.byteLength(serialized, "utf8") <= maxBytes ? serialized : null;
	}
	if (typeof value !== "object") return null;
	if (ancestors.has(value)) return null;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > CANONICAL_ARGS_MAX_ARRAY_LENGTH) return null;
			let expectedIndex = 0;
			for (const key in value) {
				if (!consumeKey(state) || !Object.hasOwn(value, key) || key !== String(expectedIndex)) return null;
				expectedIndex++;
			}
			if (expectedIndex !== value.length) return null;
			const items: string[] = [];
			let bytes = 2;
			for (const item of value) {
				const separatorBytes = items.length === 0 ? 0 : 1;
				const canonical = canonicalizeJsonValue(item, ancestors, state, depth + 1, maxBytes - bytes - separatorBytes);
				if (canonical === null) return null;
				bytes += Buffer.byteLength(canonical, "utf8") + separatorBytes;
				if (bytes > maxBytes) return null;
				items.push(canonical);
			}
			return `[${items.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const keys: string[] = [];
		let serializedKeyBytes = 2;
		for (const key in value) {
			if (!consumeKey(state) || !Object.hasOwn(value, key)) return null;
			if (keys.length >= CANONICAL_ARGS_MAX_OBJECT_KEYS) return null;
			const keyBytes = boundedJsonStringBytes(key, maxBytes - serializedKeyBytes);
			if (keyBytes === null) return null;
			serializedKeyBytes += keyBytes + (keys.length === 0 ? 0 : 1);
			keys.push(key);
		}
		keys.sort();
		const fields: string[] = [];
		let bytes = 2;
		for (const key of keys) {
			const separatorBytes = fields.length === 0 ? 0 : 1;
			const keyJson = boundedJsonString(key, maxBytes - bytes - separatorBytes);
			if (keyJson === null) return null;
			const overhead = separatorBytes + Buffer.byteLength(keyJson, "utf8") + 1;
			const canonical = canonicalizeJsonValue(
				(value as Record<string, unknown>)[key],
				ancestors,
				state,
				depth + 1,
				maxBytes - bytes - overhead,
			);
			if (canonical === null) return null;
			const field = `${keyJson}:${canonical}`;
			bytes += Buffer.byteLength(field, "utf8") + separatorBytes;
			if (bytes > maxBytes) return null;
			fields.push(field);
		}
		return `{${fields.join(",")}}`;
	} catch {
		return null;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string | null {
	return canonicalizeJsonValue(
		value,
		new Set(),
		{ remainingNodes: CANONICAL_ARGS_MAX_NODES, remainingKeys: CANONICAL_ARGS_MAX_KEYS },
		0,
		CANONICAL_ARGS_MAX_BYTES,
	);
}

export function canonicalArgsFingerprint(value: unknown): `sha256:${string}` | null {
	const canonical = canonicalJson(value);
	if (canonical === null) return null;
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function parseXdevArgs(args: unknown): { toolName: string; args: Record<string, unknown> } | null {
	if (!isRecord(args) || typeof args.path !== "string" || typeof args.content !== "string") return null;
	const path = args.path.trim();
	if (!path.toLowerCase().startsWith("xd://")) return null;
	const toolName = path.slice("xd://".length);
	if (!toolName || /[/?#\\]/.test(toolName) || toolName === "." || toolName === "..") return null;
	const content = args.content.trim();
	if (HELP_CONTENT_RE.test(content)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	return isRecord(parsed) ? { toolName, args: parsed } : null;
}

function sanitizedServerId(serverId: string): string {
	return serverId
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function parseMcpFqn(toolName: string): { serverId: string; toolName: string } | null {
	if (!toolName.startsWith("mcp__")) return null;
	for (const serverId of ["codebase-memory-mcp", "codebase_memory_mcp", "codebase-memory"] as const) {
		const serverPart = sanitizedServerId(serverId);
		for (const separator of ["_", "__"] as const) {
			const prefix = `mcp__${serverPart}${separator}`;
			if (!toolName.startsWith(prefix)) continue;
			const candidate = toolName.slice(prefix.length);
			if (codebaseToolAccess(candidate)) return { serverId, toolName: candidate };
		}
	}
	return null;
}

function identity(
	transport: CanonicalToolIdentity["transport"],
	toolName: string,
	args: Record<string, unknown>,
): CanonicalToolIdentity | null {
	const access = codebaseToolAccess(toolName);
	const argsFingerprint = canonicalArgsFingerprint(args);
	if (!access || !argsFingerprint) return null;
	return {
		transport,
		serverId: CANONICAL_CODEBASE_SERVER_ID,
		toolName,
		qualifiedName: `${CANONICAL_CODEBASE_SERVER_ID}.${toolName}`,
		args,
		argsFingerprint,
		access,
	};
}

export function canonicalizeToolIdentity(input: ToolIdentityInput): CanonicalToolIdentity | null {
	const xdev = input.toolName === "write" ? parseXdevArgs(input.args) : null;
	if (xdev) return identity("xdev", xdev.toolName, xdev.args);

	if (!isRecord(input.args)) return null;
	const mcp = parseMcpFqn(input.toolName);
	if (mcp) {
		if (input.serverName !== undefined && !isTrustedCodebaseServerId(input.serverName)) return null;
		return identity("mcp", mcp.toolName, input.args);
	}

	if (!input.serverName || !isTrustedCodebaseServerId(input.serverName)) return null;
	return identity("direct", input.toolName, input.args);
}
