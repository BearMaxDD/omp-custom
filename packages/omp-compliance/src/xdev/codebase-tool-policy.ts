export const CANONICAL_CODEBASE_SERVER_ID = "codebase-memory-mcp";

export const TRUSTED_CODEBASE_SERVER_IDS: ReadonlySet<string> = new Set([
	"codebase-memory-mcp",
	"codebase_memory_mcp",
	"codebase-memory",
]);

export const READONLY_CODEBASE_TOOLS: ReadonlySet<string> = new Set([
	"index_status",
	"get_architecture",
	"search_graph",
	"search_code",
	"trace_path",
	"get_code_snippet",
	"query_graph",
]);

export const WRITE_CODEBASE_TOOLS: ReadonlySet<string> = new Set(["index_repository"]);

export type CodebaseToolAccess = "read" | "write";

export function codebaseToolAccess(toolName: string): CodebaseToolAccess | null {
	if (READONLY_CODEBASE_TOOLS.has(toolName)) return "read";
	if (WRITE_CODEBASE_TOOLS.has(toolName)) return "write";
	return null;
}

export function isTrustedCodebaseServerId(serverId: string): boolean {
	return TRUSTED_CODEBASE_SERVER_IDS.has(serverId);
}

export function isAdvisorCodebaseToolAllowed(identity: {
	serverId: string;
	toolName: string;
	access: CodebaseToolAccess;
}): boolean {
	return (
		identity.serverId === CANONICAL_CODEBASE_SERVER_ID &&
		identity.access === "read" &&
		READONLY_CODEBASE_TOOLS.has(identity.toolName)
	);
}
