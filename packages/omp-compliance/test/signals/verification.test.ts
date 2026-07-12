import { describe, expect, it } from "bun:test";
import type { ToolCallRecord, ToolResultRecord } from "../../src/signals/types";
import {
	collectVerifications,
	extractChangedPaths,
	extractCommand,
	extractExitCode,
} from "../../src/signals/verification";

// ── Helper builders ──────────────────────────────────────────────

function bashCall(command: string, toolCallId = "call-1"): ToolCallRecord {
	return {
		toolName: "bash",
		toolCallId,
		params: { command },
		timestamp: "2025-01-01T00:00:00.000Z",
	};
}

function runCall(command: string, toolCallId = "call-1"): ToolCallRecord {
	return {
		toolName: "run",
		toolCallId,
		params: { command },
		timestamp: "2025-01-01T00:00:00.000Z",
	};
}

function nonToolCall(toolName: string): ToolCallRecord {
	return {
		toolName,
		toolCallId: "call-x",
		params: { command: "bun test" },
		timestamp: "2025-01-01T00:00:00.000Z",
	};
}

function succeededResult(toolCallId: string, resultRef = ""): ToolResultRecord {
	return {
		toolCallId,
		success: true,
		resultRef,
		timestamp: "2025-01-01T00:00:01.000Z",
	};
}

function failedResult(toolCallId: string, resultRef = ""): ToolResultRecord {
	return {
		toolCallId,
		success: false,
		resultRef,
		timestamp: "2025-01-01T00:00:01.000Z",
	};
}

// ── extractCommand ───────────────────────────────────────────────

describe("extractCommand", () => {
	it("extracts from command key", () => {
		expect(extractCommand({ command: "bun test" })).toBe("bun test");
	});

	it("extracts from cmd key as fallback", () => {
		expect(extractCommand({ cmd: "jest" })).toBe("jest");
	});

	it("extracts from script key as fallback", () => {
		expect(extractCommand({ script: "vitest run" })).toBe("vitest run");
	});

	it("prefers command over cmd and script", () => {
		expect(extractCommand({ command: "bun test", cmd: "jest", script: "echo" })).toBe("bun test");
	});

	it("returns empty string when no key present", () => {
		expect(extractCommand({})).toBe("");
	});

	it("coerces non-string values to string", () => {
		expect(extractCommand({ command: 42 })).toBe("42");
	});
});

// ── extractExitCode ─────────────────────────────────────────────

describe("extractExitCode", () => {
	it("returns -1 when result is undefined", () => {
		expect(extractExitCode(undefined)).toBe(-1);
	});

	it("returns 1 when success is false", () => {
		expect(extractExitCode(failedResult("c1"))).toBe(1);
	});

	it("returns 0 when success is true and resultRef is not JSON", () => {
		expect(extractExitCode(succeededResult("c1", "all good"))).toBe(0);
	});

	it("extracts exitCode from JSON resultRef", () => {
		expect(extractExitCode(succeededResult("c1", JSON.stringify({ exitCode: 42 })))).toBe(42);
	});

	it("extracts code from JSON resultRef when exitCode is absent", () => {
		expect(extractExitCode(succeededResult("c1", JSON.stringify({ code: 7 })))).toBe(7);
	});

	it("prefers exitCode over code in JSON resultRef", () => {
		expect(extractExitCode(succeededResult("c1", JSON.stringify({ exitCode: 0, code: 1 })))).toBe(0);
	});

	it("returns 0 when JSON has neither exitCode nor code", () => {
		expect(extractExitCode(succeededResult("c1", JSON.stringify({ pid: 123 })))).toBe(0);
	});

	it("returns 0 for non-numeric exitCode", () => {
		expect(extractExitCode(succeededResult("c1", JSON.stringify({ exitCode: "ok" })))).toBe(0);
	});
});

// ── extractChangedPaths ─────────────────────────────────────────

describe("extractChangedPaths", () => {
	it("returns empty array for empty text", () => {
		expect(extractChangedPaths("")).toEqual([]);
	});

	it("returns empty array for text without paths", () => {
		expect(extractChangedPaths("no paths here")).toEqual([]);
	});

	it("extracts .ts paths with directory separator", () => {
		const paths = extractChangedPaths("src/foo.ts passed");
		expect(paths).toEqual(["src/foo.ts"]);
	});

	it("extracts multiple paths from text", () => {
		const text = "src/a.ts and src/b.go changed";
		expect(extractChangedPaths(text)).toEqual(["src/a.ts", "src/b.go"]);
	});

	it("filters out extensions not in the allowlist", () => {
		const text = "src/a.ts src/b.exe src/c.dll";
		expect(extractChangedPaths(text)).toEqual(["src/a.ts"]);
	});

	it("requires a / in the path", () => {
		const text = "a.ts standalone.ts";
		expect(extractChangedPaths(text)).toEqual([]);
	});

	it("recognizes .tsx, .js, .jsx, .py, .go, .rs, .json, .yaml, .yml, .md", () => {
		const text = "a.tsx b.js c.jsx d.py e.go f.rs g.json h.yaml i.yml j.md";
		const allPaths = text
			.split(" ")
			.map((p) => `dir/${p}`)
			.join(" ");
		const result = extractChangedPaths(allPaths);
		expect(result).toEqual([
			"dir/a.tsx",
			"dir/b.js",
			"dir/c.jsx",
			"dir/d.py",
			"dir/e.go",
			"dir/f.rs",
			"dir/g.json",
			"dir/h.yaml",
			"dir/i.yml",
			"dir/j.md",
		]);
	});
});

// ── collectVerifications ────────────────────────────────────────

describe("collectVerifications", () => {
	it("returns empty when no tool calls match", () => {
		const result = collectVerifications([]);
		expect(result).toEqual([]);
	});

	it("ignores non-bash/run/exec tool names", () => {
		const result = collectVerifications([
			{
				call: nonToolCall("read"),
			},
		]);
		expect(result).toEqual([]);
	});

	it("ignores commands that don't match verification patterns", () => {
		const result = collectVerifications([
			{
				call: bashCall("echo hello"),
			},
		]);
		expect(result).toEqual([]);
	});

	it("records a matched bun test command", () => {
		const result = collectVerifications([
			{
				call: bashCall("bun test"),
				result: succeededResult("call-1", "src/a.ts ok"),
			},
		]);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("bun test");
		expect(result[0].exitCode).toBe(0);
		expect(result[0].passed).toBe(true);
		expect(result[0].changedPaths).toEqual(["src/a.ts"]);
	});

	it("records a matched biome check command", () => {
		const result = collectVerifications([
			{
				call: bashCall("biome check src/"),
				result: succeededResult("call-1"),
			},
		]);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("biome check src/");
	});

	it("records matched jest command", () => {
		const result = collectVerifications([{ call: bashCall("jest --coverage") }]);
		expect(result).toHaveLength(1);
		expect(result[0].command).toBe("jest --coverage");
		expect(result[0].exitCode).toBe(-1); // no result
		expect(result[0].passed).toBe(false);
	});

	it("records matched vitest command", () => {
		const result = collectVerifications([{ call: bashCall("vitest run src/") }]);
		expect(result).toHaveLength(1);
	});

	it("records matched tsc command", () => {
		const result = collectVerifications([{ call: runCall("tsc --noEmit") }]);
		expect(result).toHaveLength(1);
	});

	it("records matched eslint command", () => {
		const result = collectVerifications([{ call: bashCall("eslint src/") }]);
		expect(result).toHaveLength(1);
	});

	it("records matched bun run build command", () => {
		const result = collectVerifications([{ call: bashCall("bun run build") }]);
		expect(result).toHaveLength(1);
	});

	it("marks failed exit code correctly", () => {
		const result = collectVerifications([
			{
				call: bashCall("bun test"),
				result: failedResult("call-1"),
			},
		]);
		expect(result).toHaveLength(1);
		expect(result[0].exitCode).toBe(1);
		expect(result[0].passed).toBe(false);
	});

	it("processes multiple calls", () => {
		const result = collectVerifications([
			{
				call: bashCall("bun test", "c1"),
				result: succeededResult("c1", "src/a.ts ok"),
			},
			{
				call: bashCall("biome check src/", "c2"),
				result: succeededResult("c2", "src/b.tsx fixed"),
			},
			{
				call: bashCall("echo skip", "c3"),
			},
		]);
		expect(result).toHaveLength(2);
		expect(result[0].command).toBe("bun test");
		expect(result[1].command).toBe("biome check src/");
	});
});
