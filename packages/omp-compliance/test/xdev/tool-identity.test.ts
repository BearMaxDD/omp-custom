import { describe, expect, it, spyOn } from "bun:test";
import { isAdvisorCodebaseToolAllowed } from "../../src/xdev/codebase-tool-policy";
import {
	CANONICAL_ARGS_MAX_BYTES,
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

	it("规范化 HOST v17 createMCPToolName 生成的单下划线正式 FQN", () => {
		expectIdentity(
			canonicalizeToolIdentity({
				toolName: "mcp__codebase_memory_mcp_search_graph",
				args: { query: "host-v17" },
			}),
			{
				transport: "mcp",
				serverId: "codebase-memory-mcp",
				toolName: "search_graph",
				qualifiedName: "codebase-memory-mcp.search_graph",
				args: { query: "host-v17" },
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

	it("超大字符串在 JSON.stringify 完整分配前按 UTF-8 预算拒绝", () => {
		const huge = "超".repeat(CANONICAL_ARGS_MAX_BYTES);
		const stringify = spyOn(JSON, "stringify");
		try {
			expect(canonicalJson({ value: huge })).toBeNull();
			expect(stringify.mock.calls.some(([value]) => value === huge)).toBe(false);
		} finally {
			stringify.mockRestore();
		}
	});

	it("超长数组先检查长度，不进入 Object.keys 或元素遍历", () => {
		let reads = 0;
		const huge = Array.from({ length: 40_000 }, () =>
			Object.defineProperty({}, "value", {
				enumerable: true,
				get: () => {
					reads++;
					return 1;
				},
			}),
		);
		const keys = spyOn(Object, "keys");
		try {
			expect(canonicalJson(huge)).toBeNull();
			expect(keys.mock.calls.some(([value]) => value === huge)).toBe(false);
			expect(reads).toBe(0);
		} finally {
			keys.mockRestore();
		}
	});

	it("超宽对象按键预算拒绝，不先完整 Object.keys 或排序", () => {
		const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`key-${index}`, index]));
		const keys = spyOn(Object, "keys");
		const sort = spyOn(Array.prototype, "sort");
		try {
			expect(canonicalJson(wide)).toBeNull();
			expect(keys.mock.calls.some(([value]) => value === wide)).toBe(false);
			expect(sort).not.toHaveBeenCalled();
		} finally {
			keys.mockRestore();
			sort.mockRestore();
		}
	});

	it("大量节点只要规范 JSON 低于 64KiB 就应成功", () => {
		const manyNodes = Array.from({ length: 256 }, () => Array.from({ length: 32 }, () => null));

		expect(canonicalJson(manyNodes)).not.toBeNull();
		expect(canonicalArgsFingerprint(manyNodes)).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("1025 个零的数组低于 64KiB 时应成功规范化", () => {
		const value = Array.from({ length: 1025 }, () => 0);
		const canonical = canonicalJson(value);

		expect(canonical).not.toBeNull();
		expect(new TextEncoder().encode(canonical ?? "").byteLength).toBeLessThan(CANONICAL_ARGS_MAX_BYTES);
		expect(canonicalArgsFingerprint(value)).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("1025 键对象低于 64KiB 时应成功且排序稳定", () => {
		const entries = Array.from({ length: 1025 }, (_, index) => [`key-${String(index).padStart(4, "0")}`, 0] as const);
		const ascending = Object.fromEntries(entries);
		const descending = Object.fromEntries([...entries].reverse());
		const canonical = canonicalJson(descending);

		expect(canonical).not.toBeNull();
		expect(new TextEncoder().encode(canonical ?? "").byteLength).toBeLessThan(CANONICAL_ARGS_MAX_BYTES);
		expect(canonical).toBe(canonicalJson(ascending));
		expect(canonicalArgsFingerprint(descending)).toBe(canonicalArgsFingerprint(ascending));
	});

	it("33 层嵌套低于 64KiB 时应成功规范化", () => {
		let value: unknown = 0;
		for (let depth = 0; depth < 33; depth++) value = { child: value };

		expect(canonicalJson(value)).not.toBeNull();
		expect(canonicalArgsFingerprint(value)).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it.each(["object", "array"] as const)("%s accessor 不得执行 getter并必须 fail closed", (kind) => {
		let reads = 0;
		const value: Record<string, unknown> | unknown[] = kind === "array" ? [] : {};
		Object.defineProperty(value, kind === "array" ? "0" : "value", {
			enumerable: true,
			get: () => {
				reads++;
				return "forged";
			},
		});

		expect(canonicalJson(value)).toBeNull();
		expect(canonicalArgsFingerprint(value)).toBeNull();
		expect(reads).toBe(0);
	});

	it("Symbol own property 不得被忽略为相同的空对象", () => {
		const alpha = { [Symbol("alpha")]: 1 };
		const beta = { [Symbol("beta")]: 1 };

		expect(canonicalJson(alpha)).toBeNull();
		expect(canonicalJson(beta)).toBeNull();
		expect(canonicalArgsFingerprint(alpha)).toBeNull();
		expect(canonicalArgsFingerprint(beta)).toBeNull();
	});

	it.each(["object", "array"] as const)("%s 不可枚举 own property 必须 fail closed", (kind) => {
		const value: Record<string, unknown> | unknown[] = kind === "array" ? [1] : { visible: 1 };
		Object.defineProperty(value, "hidden", { configurable: true, value: 2 });

		expect(canonicalJson(value)).toBeNull();
		expect(canonicalArgsFingerprint(value)).toBeNull();
	});

	it.each(["object", "array"] as const)("%s Proxy 在任何反射 trap 执行前必须 fail closed", (kind) => {
		const traps = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
		const target: Record<string, unknown> | unknown[] = kind === "array" ? [1] : { value: 1 };
		const value = new Proxy(target, {
			getPrototypeOf: () => {
				traps.getPrototypeOf++;
				return Reflect.getPrototypeOf(target);
			},
			ownKeys: () => {
				traps.ownKeys++;
				return Reflect.ownKeys(target);
			},
			getOwnPropertyDescriptor: (_target, key) => {
				traps.getOwnPropertyDescriptor++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});

		expect(canonicalJson(value)).toBeNull();
		expect(canonicalArgsFingerprint(value)).toBeNull();
		expect(traps).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
	});

	it("xd 外层 args Proxy 在读取 path/content 前必须 fail closed", () => {
		const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
		const target = { path: "xd://search_graph", content: '{"query":"proxy"}' };
		const args = new Proxy(target, {
			get: () => {
				traps.get++;
				throw new Error("不得读取 Proxy 字段");
			},
			ownKeys: () => {
				traps.ownKeys++;
				throw new Error("不得枚举 Proxy 键");
			},
			getOwnPropertyDescriptor: () => {
				traps.getOwnPropertyDescriptor++;
				throw new Error("不得读取 Proxy descriptor");
			},
		});

		expect(() => canonicalizeToolIdentity({ toolName: "write", args })).not.toThrow();
		expect(canonicalizeToolIdentity({ toolName: "write", args })).toBeNull();
		expect(traps).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
	});

	it("xd 外层 path/content 必须是 enumerable data property 且整体满足 JSON 边界", () => {
		let reads = 0;
		const accessor = Object.defineProperty({ content: '{"query":"accessor"}' }, "path", {
			enumerable: true,
			get: () => {
				reads++;
				return "xd://search_graph";
			},
		});
		const hidden = Object.defineProperty({ content: '{"query":"hidden"}' }, "path", { value: "xd://search_graph" });
		const nonJson = { path: "xd://search_graph", content: '{"query":"invalid"}', extra: undefined };

		for (const args of [accessor, hidden, nonJson]) {
			expect(canonicalizeToolIdentity({ toolName: "write", args })).toBeNull();
		}
		expect(reads).toBe(0);
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
