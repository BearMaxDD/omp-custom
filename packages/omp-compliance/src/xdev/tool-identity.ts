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
	access: CodebaseToolAccess;
}

export interface ToolIdentityInput {
	toolName: string;
	serverName?: string;
	args: unknown;
}

const HELP_CONTENT_RE = /^(?:|\?|help|describe)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		for (const delimiter of ["__", "_"] as const) {
			const prefix = `mcp__${serverPart}${delimiter}`;
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
	if (!access) return null;
	return {
		transport,
		serverId: CANONICAL_CODEBASE_SERVER_ID,
		toolName,
		qualifiedName: `${CANONICAL_CODEBASE_SERVER_ID}.${toolName}`,
		args,
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
