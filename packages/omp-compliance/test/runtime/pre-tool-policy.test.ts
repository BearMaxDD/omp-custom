import { describe, expect, it } from "bun:test";
import type { TaskContract } from "../../src/contract/types";
import { type CanonicalToolCall, type PreToolBlockedEvidence, PreToolPolicy } from "../../src/runtime/pre-tool-policy";
import type { CodebaseEvidencePack } from "../../src/signals/types";
import { canonicalArgsFingerprint, canonicalizeToolIdentity } from "../../src/xdev/tool-identity";

const REVISION = `sha256:${"a".repeat(64)}` as const;
const OTHER_REVISION = `sha256:${"b".repeat(64)}` as const;

function builtinCall(
	toolName: string,
	args: Record<string, unknown>,
	overrides: Partial<CanonicalToolCall> = {},
): CanonicalToolCall {
	const argsFingerprint = canonicalArgsFingerprint(args);
	if (!argsFingerprint) throw new Error("test args must be canonical");
	return {
		actor: "main",
		taskId: "task-13",
		callId: `call-${toolName}`,
		evidenceRevision: REVISION,
		identity: {
			transport: "builtin",
			serverId: "omp",
			toolName,
			qualifiedName: `omp.${toolName}`,
			args,
			argsFingerprint,
			access: "write",
		},
		...overrides,
	};
}

function codebaseCall(
	toolName: string,
	actor: "main" | "advisor" = "main",
	toolFqn = `mcp__codebase_memory_mcp__${toolName}`,
): CanonicalToolCall {
	const identity = canonicalizeToolIdentity({ toolName: toolFqn, args: { project: "omp-custom" } });
	if (!identity) throw new Error(`test identity must canonicalize: ${toolFqn}`);
	return {
		actor,
		taskId: "task-13",
		callId: `call-${toolName}`,
		evidenceRevision: REVISION,
		identity,
	};
}

function contract(affectedFiles: readonly string[] = ["src/existing.ts"]): TaskContract {
	return {
		schemaVersion: 1,
		source: "lightweight",
		taskId: "task-13",
		projectId: "omp-custom",
		gitHead: "d919e373fe16bbe04794ebad1558bd157d3b3fc2",
		affectedFiles,
		scope: ["Task 13"],
		acceptanceCriteria: ["policy matrix passes"],
		verificationCommands: ["bun test"],
		delegationRequired: false,
		revision: REVISION,
		contractHash: REVISION,
		createdAt: "2026-07-18T00:00:00.000Z",
	};
}

function pack(overrides: Partial<CodebaseEvidencePack> = {}): CodebaseEvidencePack {
	return {
		schemaVersion: 1,
		projectId: "omp-custom",
		taskContractRevision: REVISION,
		codebaseProjectId: "Users-mima1234-Code-super-omp-custom",
		indexRevision: "index-13",
		gitHead: "d919e373fe16bbe04794ebad1558bd157d3b3fc2",
		diffHash: REVISION,
		queriedAt: "2026-07-18T00:00:00.000Z",
		affectedFiles: ["src/existing.ts"],
		changedFiles: ["src/existing.ts"],
		newFiles: [],
		allowedNewFileRoots: ["src/generated"],
		unresolvedClaims: [],
		requiredSymbols: [],
		tools: [],
		symbols: [],
		traces: [],
		evidenceRevision: REVISION,
		...overrides,
	};
}

function recorder() {
	const records: PreToolBlockedEvidence[] = [];
	return { records, sink: { append: (record: PreToolBlockedEvidence) => records.push(record) } };
}

describe("PreToolPolicy decision matrix", () => {
	it.each(["edit", "write"])("blocks %s without a contract", (toolName) => {
		const { records, sink } = recorder();
		const decision = new PreToolPolicy(sink).evaluate(builtinCall(toolName, { path: "src/existing.ts" }), {
			evidenceRevision: REVISION,
		});

		expect(decision).toEqual({ allow: false, reason: "missing_contract" });
		expect(records).toEqual([
			{ event: "tool_call_blocked", task: "task-13", call: `call-${toolName}`, reason: "missing_contract" },
		]);
	});

	it("blocks a write without a Codebase Evidence Pack", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("write", { path: "src/existing.ts" }), {
			evidenceRevision: REVISION,
			contract: contract(),
		});

		expect(decision).toEqual({ allow: false, reason: "missing_codebase_evidence" });
	});

	it("blocks stale evidence revisions", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("edit", { path: "src/existing.ts" }, { evidenceRevision: OTHER_REVISION }),
			{ evidenceRevision: REVISION, contract: contract(), codebasePack: pack() },
		);

		expect(decision).toEqual({ allow: false, reason: "stale_evidence" });
	});

	it.each([
		["existing contract target", "src/existing.ts"],
		["new target under an allowed root", "src/generated/new.ts"],
	] as const)("allows an edit to an %s", (_label, path) => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("edit", { path }), {
			evidenceRevision: REVISION,
			contract: contract(),
			codebasePack: pack(),
		});

		expect(decision).toEqual({ allow: true });
	});

	it.each(["src/outside.ts", "../escape.ts", "/tmp/escape.ts", "src/generated/../escape.ts", "bad\0path"])(
		"blocks an out-of-scope or unsafe path: %s",
		(path) => {
			const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("write", { path }), {
				evidenceRevision: REVISION,
				contract: contract(),
				codebasePack: pack(),
			});

			expect(decision).toEqual({ allow: false, reason: "scope_violation" });
		},
	);

	it.each(["task", "hub"])("requires gates but does not invent a file target for %s", (toolName) => {
		const policy = new PreToolPolicy(recorder().sink);
		expect(
			policy.evaluate(builtinCall(toolName, { prompt: "delegate Task 14" }), { evidenceRevision: REVISION }),
		).toEqual({ allow: false, reason: "missing_contract" });
		expect(
			policy.evaluate(builtinCall(toolName, { prompt: "delegate Task 14" }), {
				evidenceRevision: REVISION,
				contract: contract(),
				codebasePack: pack(),
			}),
		).toEqual({ allow: true });
	});

	it("allows a proven read-only shell command without write gates", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("bash", { command: "git status --short" }),
			{
				evidenceRevision: REVISION,
			},
		);

		expect(decision).toEqual({ allow: true });
	});

	it("applies scope gates to explicit shell mutation targets", () => {
		const policy = new PreToolPolicy(recorder().sink);
		expect(
			policy.evaluate(builtinCall("bash", { command: "rm -- src/existing.ts" }), {
				evidenceRevision: REVISION,
				contract: contract(),
				codebasePack: pack(),
			}),
		).toEqual({ allow: true });
		expect(
			policy.evaluate(builtinCall("bash", { command: "touch src/outside.ts" }), {
				evidenceRevision: REVISION,
				contract: contract(),
				codebasePack: pack(),
			}),
		).toEqual({ allow: false, reason: "scope_violation" });
	});

	it.each([
		"bun test",
		"echo ok > src/existing.ts",
		"rm $(printf src/existing.ts)",
		"rm src/generated/*",
		"cp -t src/outside src/existing.ts",
		"rg --pre destructive-filter pattern src",
	])("fails closed when shell effects or targets cannot be proven: %s", (command) => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("bash", { command }), {
			evidenceRevision: REVISION,
			contract: contract(),
			codebasePack: pack(),
		});

		expect(decision).toEqual({ allow: false, reason: "scope_violation" });
	});
});

describe("PreToolPolicy canonical Codebase identities", () => {
	it("allows canonical main-agent read-only Codebase tools", () => {
		expect(
			new PreToolPolicy(recorder().sink).evaluate(codebaseCall("search_graph"), { evidenceRevision: REVISION }),
		).toEqual({ allow: true });
	});

	it("allows only Advisor canonical read-only allowlist tools", () => {
		const policy = new PreToolPolicy(recorder().sink);
		expect(policy.evaluate(codebaseCall("get_code_snippet", "advisor"), { evidenceRevision: REVISION })).toEqual({
			allow: true,
		});
		expect(policy.evaluate(codebaseCall("index_repository", "advisor"), { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "advisor_tool_forbidden",
		});
		expect(
			policy.evaluate(builtinCall("edit", { path: "src/existing.ts" }, { actor: "advisor" }), {
				evidenceRevision: REVISION,
			}),
		).toEqual({ allow: false, reason: "advisor_tool_forbidden" });
	});

	it("allows canonical main-agent index_repository and invalidates evidence without a Pack", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(codebaseCall("index_repository"), {
			evidenceRevision: REVISION,
		});

		expect(decision).toEqual({ allow: true, invalidatesEvidence: true });
	});

	it.each([
		["untrusted short name", "index_repository", undefined],
		["lookalike FQN", "mcp__evil__index_repository", "codebase-memory-mcp"],
		["lookalike server", "mcp__codebase_memory_mcp__index_repository", "codebase-memory-mcp-evil"],
	] as const)("does not canonicalize an index_repository %s", (_label, toolName, serverName) => {
		expect(canonicalizeToolIdentity({ toolName, serverName, args: { repo_path: "/repo" } })).toBeNull();
	});

	it("blocks forged canonical fields and unknown tools", () => {
		const forged = codebaseCall("index_repository");
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			{
				...forged,
				identity: { ...forged.identity, qualifiedName: "evil.index_repository" },
			},
			{ evidenceRevision: REVISION },
		);
		expect(decision).toEqual({ allow: false, reason: "invalid_input" });

		expect(
			new PreToolPolicy(recorder().sink).evaluate(builtinCall("custom_write_suffix", { path: "src/existing.ts" }), {
				evidenceRevision: REVISION,
			}),
		).toEqual({ allow: false, reason: "unknown_tool" });
	});
});

describe("PreToolPolicy fail-closed input and Evidence handling", () => {
	it("blocks Proxy, accessor, and oversized args", () => {
		const policy = new PreToolPolicy(recorder().sink);
		const proxied = builtinCall("write", { path: "src/existing.ts" });
		(proxied.identity as { args: unknown }).args = new Proxy({ path: "src/existing.ts" }, {});
		expect(policy.evaluate(proxied, { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "invalid_input",
		});

		const accessorArgs = {} as Record<string, unknown>;
		Object.defineProperty(accessorArgs, "path", { enumerable: true, get: () => "src/existing.ts" });
		const accessorCall = builtinCall("write", { path: "placeholder" });
		(accessorCall.identity as { args: unknown }).args = accessorArgs;
		expect(policy.evaluate(accessorCall, { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "invalid_input",
		});

		const oversized = builtinCall("write", { path: "src/existing.ts" });
		(oversized.identity as { args: unknown }).args = { path: "x".repeat(70 * 1024) };
		expect(policy.evaluate(oversized, { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "invalid_input",
		});
	});

	it("rejects accessor-bearing scope arrays without invoking them", () => {
		let invoked = false;
		const affectedFiles = ["src/existing.ts"];
		Object.defineProperty(affectedFiles, "hidden", {
			get: () => {
				invoked = true;
				return "src/outside.ts";
			},
		});
		const unsafeContract = contract();
		(unsafeContract as { affectedFiles: readonly string[] }).affectedFiles = affectedFiles;

		const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("write", { path: "src/existing.ts" }), {
			evidenceRevision: REVISION,
			contract: unsafeContract,
			codebasePack: pack(),
		});

		expect(decision).toEqual({ allow: false, reason: "invalid_input" });
		expect(invoked).toBe(false);
	});

	it("keeps the block decision when Evidence persistence throws", () => {
		const policy = new PreToolPolicy({
			append: () => {
				throw new Error("disk full");
			},
		});
		const decision = policy.evaluate(builtinCall("write", { path: "src/existing.ts" }), {
			evidenceRevision: REVISION,
		});

		expect(decision).toEqual({ allow: false, reason: "missing_contract", evidenceWriteFailed: true });
	});
});
