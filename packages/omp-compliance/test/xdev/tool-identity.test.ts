import { describe, expect, it } from "bun:test";
import { isAdvisorCodebaseToolAllowed } from "../../src/xdev/codebase-tool-policy";
import {
	type CanonicalToolIdentity,
	canonicalArgsFingerprint,
	canonicalJson,
	canonicalizeToolIdentity,
} from "../../src/xdev/tool-identity";

function expectIdentity(actual: CanonicalToolIdentity | null, expected: Partial<CanonicalToolIdentity>): void {
	expect(actual).not.toBeNull();
	expect(actual).toMatchObject(expected);
}

describe("canonicalizeToolIdentity", () => {
	it("规范化带可信 serverName 的 direct search_graph", () => {
		expectIdentity(
			canonicalizeToolIdentity({
				toolName: "search_graph",
				serverName: "codebase-memory-mcp",
				args: { query: "ToolEventCollector" },
			}),
			{
				transport: "direct",
				serverId: "codebase-memory-mcp",
				toolName: "search_graph",
				qualifiedName: "codebase-memory-mcp.search_graph",
				args: { query: "ToolEventCollector" },
				access: "read",
			},
		);
	});

	it("规范化 MCP FQN", () => {
		expectIdentity(
			canonicalizeToolIdentity({
				toolName: "mcp__codebase_memory_mcp__search_graph",
				args: { query: "normalizeCodebaseMemory" },
			}),
			{
				transport: "mcp",
				serverId: "codebase-memory-mcp",
				toolName: "search_graph",
				qualifiedName: "codebase-memory-mcp.search_graph",
				args: { query: "normalizeCodebaseMemory" },
				access: "read",
			},
		);
	});

	it("canonical JSON 按键排序且 fingerprint 与对象插入顺序无关", () => {
		const a = { z: [3, { b: true, a: null }], a: "value" };
		const b = { a: "value", z: [3, { a: null, b: true }] };
		expect(canonicalJson(a)).toBe('{"a":"value","z":[3,{"a":null,"b":true}]}');
		expect(canonicalArgsFingerprint(a)).toBe(canonicalArgsFingerprint(b));
		expect(canonicalArgsFingerprint(a)).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("canonical JSON 对非 JSON 值、循环和异常 getter fail closed", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const throwing = Object.defineProperty({}, "value", {
			enumerable: true,
			get: () => {
				throw new Error("getter failed");
			},
		});
		for (const value of [
			cyclic,
			{ value: 1n },
			{ value: undefined },
			{ value: Number.NaN },
			{ value: () => undefined },
			throwing,
		]) {
			expect(() => canonicalJson(value)).not.toThrow();
			expect(canonicalJson(value)).toBeNull();
			expect(canonicalArgsFingerprint(value)).toBeNull();
		}
	});

	it("规范化 xd 外层 write", () => {
		expectIdentity(
			canonicalizeToolIdentity({
				toolName: "write",
				args: { path: "xd://search_graph", content: JSON.stringify({ query: "collector" }) },
			}),
			{
				transport: "xdev",
				serverId: "codebase-memory-mcp",
				toolName: "search_graph",
				qualifiedName: "codebase-memory-mcp.search_graph",
				args: { query: "collector" },
				access: "read",
			},
		);
	});

	it("拒绝非可信 server 冒充 search_graph", () => {
		expect(
			canonicalizeToolIdentity({
				toolName: "search_graph",
				serverName: "evil-codebase-memory-mcp",
				args: { query: "spoof" },
			}),
		).toBeNull();
		expect(
			canonicalizeToolIdentity({
				toolName: "mcp__evil_codebase_memory_mcp__search_graph",
				args: { query: "spoof" },
			}),
		).toBeNull();
	});

	it("仅接受精确 server alias 和精确工具集合", () => {
		expectIdentity(
			canonicalizeToolIdentity({
				toolName: "query_graph",
				serverName: "codebase_memory_mcp",
				args: {},
			}),
			{ serverId: "codebase-memory-mcp", toolName: "query_graph", access: "read" },
		);
		expectIdentity(canonicalizeToolIdentity({ toolName: "search_graph", serverName: "codebase-memory", args: {} }), {
			serverId: "codebase-memory-mcp",
			toolName: "search_graph",
		});
		expect(
			canonicalizeToolIdentity({ toolName: "delete_project", serverName: "codebase-memory-mcp", args: {} }),
		).toBeNull();
		expect(canonicalizeToolIdentity({ toolName: "mcp__codebase_memory_mcp_search_graph", args: {} })).toBeNull();
		expect(canonicalizeToolIdentity({ toolName: "mcp__other_codebase_memory_mcp__search_graph", args: {} })).toBeNull();
	});

	it("index_repository 是 write 且永不进入 Advisor 只读 allowlist", () => {
		const identity = canonicalizeToolIdentity({
			toolName: "index_repository",
			serverName: "codebase-memory-mcp",
			args: { repo_path: "/repo" },
		});
		expectIdentity(identity, { toolName: "index_repository", access: "write" });
		expect(identity && isAdvisorCodebaseToolAllowed(identity)).toBe(false);
	});

	it.each([
		"index_status",
		"get_architecture",
		"search_graph",
		"search_code",
		"trace_path",
		"get_code_snippet",
		"query_graph",
	])("Advisor 只读 allowlist 接受 %s", (toolName) => {
		const identity = canonicalizeToolIdentity({ toolName, serverName: "codebase-memory-mcp", args: {} });
		expect(identity && isAdvisorCodebaseToolAllowed(identity)).toBe(true);
	});
});
