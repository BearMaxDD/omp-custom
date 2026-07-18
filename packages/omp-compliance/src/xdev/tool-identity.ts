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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJsonStringBytes(value: string, maxBytes: number): number | null {
	if (maxBytes < 2) return null;
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

interface ObjectEntry {
	key: string;
	value: unknown;
}

type SerializationFrame =
	| { kind: "value"; value: unknown }
	| { kind: "key"; value: string }
	| { kind: "token"; value: ":" | "," }
	| { kind: "close"; value: object; token: "]" | "}" };

export function canonicalJson(value: unknown): string | null {
	const parts: string[] = [];
	const active = new Set<object>();
	const stack: SerializationFrame[] = [{ kind: "value", value }];
	let usedBytes = 0;
	const append = (token: string): boolean => {
		const tokenBytes = Buffer.byteLength(token, "utf8");
		if (usedBytes + tokenBytes > CANONICAL_ARGS_MAX_BYTES) return false;
		parts.push(token);
		usedBytes += tokenBytes;
		return true;
	};

	try {
		while (stack.length > 0) {
			const frame = stack.pop();
			if (!frame) return null;
			if (frame.kind === "token") {
				if (!append(frame.value)) return null;
				continue;
			}
			if (frame.kind === "key") {
				const serialized = boundedJsonString(frame.value, CANONICAL_ARGS_MAX_BYTES - usedBytes);
				if (serialized === null || !append(serialized)) return null;
				continue;
			}
			if (frame.kind === "close") {
				if (!append(frame.token)) return null;
				active.delete(frame.value);
				continue;
			}

			const current = frame.value;
			if (current === null) {
				if (!append("null")) return null;
				continue;
			}
			if (typeof current === "string") {
				const serialized = boundedJsonString(current, CANONICAL_ARGS_MAX_BYTES - usedBytes);
				if (serialized === null || !append(serialized)) return null;
				continue;
			}
			if (typeof current === "boolean") {
				if (!append(String(current))) return null;
				continue;
			}
			if (typeof current === "number") {
				if (!Number.isFinite(current) || !append(String(current))) return null;
				continue;
			}
			if (typeof current !== "object" || active.has(current)) return null;

			const remainingBytes = CANONICAL_ARGS_MAX_BYTES - usedBytes;
			if (Array.isArray(current)) {
				if (remainingBytes < 2 || current.length > Math.floor((remainingBytes - 1) / 2)) return null;
				const values: unknown[] = [];
				for (let index = 0; index < current.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
					if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
					values.push(descriptor.value);
				}
				let enumerableIndex = 0;
				for (const key in current) {
					if (!Object.hasOwn(current, key) || key !== String(enumerableIndex)) return null;
					enumerableIndex++;
				}
				if (enumerableIndex !== current.length || !append("[")) return null;
				active.add(current);
				stack.push({ kind: "close", value: current, token: "]" });
				for (let index = values.length - 1; index >= 0; index--) {
					stack.push({ kind: "value", value: values[index] });
					if (index > 0) stack.push({ kind: "token", value: "," });
				}
				continue;
			}

			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) return null;
			const entries: ObjectEntry[] = [];
			let minimumBytes = 2;
			for (const key in current) {
				if (!Object.hasOwn(current, key)) return null;
				const separatorBytes = entries.length === 0 ? 0 : 1;
				const keyBytes = boundedJsonStringBytes(key, remainingBytes - minimumBytes - separatorBytes - 2);
				if (keyBytes === null) return null;
				minimumBytes += separatorBytes + keyBytes + 2;
				if (minimumBytes > remainingBytes) return null;
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
				entries.push({ key, value: descriptor.value });
			}
			entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
			if (!append("{")) return null;
			active.add(current);
			stack.push({ kind: "close", value: current, token: "}" });
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				stack.push({ kind: "value", value: entry.value });
				stack.push({ kind: "token", value: ":" });
				stack.push({ kind: "key", value: entry.key });
				if (index > 0) stack.push({ kind: "token", value: "," });
			}
		}
	} catch {
		return null;
	}

	return parts.join("");
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
