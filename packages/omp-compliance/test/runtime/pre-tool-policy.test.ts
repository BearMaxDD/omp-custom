import { describe, expect, it } from "bun:test";
import type { TaskContract } from "../../src/contract/types";
import { createLightweightTaskContract } from "../../src/contracts/task-contract";
import { type CanonicalToolCall, type PreToolBlockedEvidence, PreToolPolicy } from "../../src/runtime/pre-tool-policy";
import {
	computeEvidenceRevision,
	createCodebaseEvidencePack,
	createTrustedCodebaseValidationContext,
} from "../../src/signals/codebase-memory";
import { createControlledCollectorRuntime } from "../../src/signals/collector-runtime";
import type { CodebaseEvidencePack, TrustedCodebaseValidationContext } from "../../src/signals/types";
import { READONLY_CODEBASE_TOOLS } from "../../src/xdev/codebase-tool-policy";
import { canonicalArgsFingerprint, canonicalizeToolIdentity } from "../../src/xdev/tool-identity";

const REVISION = `sha256:${"a".repeat(64)}` as const;
const OTHER_REVISION = `sha256:${"b".repeat(64)}` as const;
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CODEBASE_PROJECT_ID = "Users-mima1234-Code-super-omp-custom";
const PROJECT_ROOT = "/Users/mima1234/Code/super/.worktrees/omp-custom-v17-adapter";
const PROJECT_CONTEXT = Object.freeze({
	projectId: PROJECT_ID,
	root: PROJECT_ROOT,
	codebaseProject: CODEBASE_PROJECT_ID,
});
const GIT_HEAD = "d919e373fe16bbe04794ebad1558bd157d3b3fc2";
const QUERIED_AT = "2099-07-18T08:00:00.000Z";

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
	args: Record<string, unknown> = toolName === "index_repository"
		? { repo_path: PROJECT_ROOT }
		: { project: CODEBASE_PROJECT_ID },
): CanonicalToolCall {
	const identity = canonicalizeToolIdentity({ toolName: toolFqn, args });
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
	return createLightweightTaskContract({
		risk: "low",
		changesPublicBehavior: false,
		projectId: PROJECT_ID,
		gitHead: GIT_HEAD,
		taskId: "task-13",
		affectedFiles,
		scope: ["Task 13"],
		acceptanceCriteria: ["policy matrix passes"],
		verificationCommands: ["bun test"],
		createdAt: "2026-07-18T00:00:00.000Z",
	});
}

function trustedEvidence(
	taskContract = contract(),
	allowedNewFileRoots: readonly string[] = ["src/generated"],
	newFiles: readonly string[] = [],
): {
	contract: TaskContract;
	trustedCodebaseContext: TrustedCodebaseValidationContext;
	codebasePack: CodebaseEvidencePack;
	evidenceRevision: `sha256:${string}`;
	projectContext: typeof PROJECT_CONTEXT;
} {
	const controlled = createControlledCollectorRuntime();
	const fixtures = [
		{
			toolName: "index_status",
			id: "index",
			input: { project: CODEBASE_PROJECT_ID },
			content: '{"status":"ready","revision":"index-13"}',
			details: { status: "ready", revision: "index-13" },
		},
		{
			toolName: "search_graph",
			id: "search",
			input: { project: CODEBASE_PROJECT_ID, query: "demo.existing" },
			content: "file:src/existing.ts",
			details: { results: [{ qualified_name: "demo.existing", file_path: "src/existing.ts" }] },
		},
		{
			toolName: "get_code_snippet",
			id: "snippet",
			input: { project: CODEBASE_PROJECT_ID, qualified_name: "demo.existing" },
			content: "file:src/existing.ts",
			details: { qualified_name: "demo.existing", file_path: "src/existing.ts", line: 10 },
		},
	] as const;
	for (const fixture of fixtures) {
		const toolName = `mcp__codebase_memory_mcp__${fixture.toolName}`;
		controlled.runtime.recordToolCall(
			{ type: "tool_call", toolName, toolCallId: fixture.id, input: fixture.input },
			undefined as never,
		);
		controlled.runtime.recordToolResult(
			{
				type: "tool_result",
				toolName,
				toolCallId: fixture.id,
				input: fixture.input,
				content: [{ type: "text", text: fixture.content }],
				isError: false,
				details: fixture.details,
			},
			undefined as never,
		);
	}
	const trustedCodebaseContext = createTrustedCodebaseValidationContext(controlled.reader, {
		taskContract,
		codebaseProjectId: CODEBASE_PROJECT_ID,
		currentDiffHash: `sha256:${"e".repeat(64)}`,
		indexRevision: "index-13",
		queriedAt: QUERIED_AT,
		changedFiles: newFiles,
		newFiles,
		allowedNewFileRoots,
		unresolvedClaims: [],
		requiredSymbols: [],
	});
	const codebasePack = createCodebaseEvidencePack(trustedCodebaseContext);
	return {
		contract: taskContract,
		trustedCodebaseContext,
		codebasePack,
		evidenceRevision: codebasePack.evidenceRevision,
		projectContext: PROJECT_CONTEXT,
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
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			event: "tool_call_blocked",
			task: "task-13",
			call: `call-${toolName}`,
			actor: "main",
			canonicalServer: "omp",
			canonicalTool: toolName,
			qualifiedName: `omp.${toolName}`,
			callEvidenceRevision: REVISION,
			reason: "missing_contract",
			remediationHint: "A pre-tool policy requirement was not satisfied.",
			remediationAction: "Provide a valid TaskContract before retrying the tool call.",
		});
	});

	it("blocks a write without a Codebase Evidence Pack", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("write", { path: "src/existing.ts" }), {
			evidenceRevision: REVISION,
			contract: contract(),
		});

		expect(decision).toEqual({ allow: false, reason: "missing_codebase_evidence" });
	});

	it("blocks a write without the trusted Task 12 capability", () => {
		const valid = trustedEvidence();
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{
				evidenceRevision: valid.evidenceRevision,
				contract: valid.contract,
				codebasePack: valid.codebasePack,
			},
		);

		expect(decision).toEqual({ allow: false, reason: "missing_codebase_evidence" });
	});

	it("blocks stale evidence revisions", () => {
		const valid = trustedEvidence();
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("edit", { path: "src/existing.ts" }, { evidenceRevision: OTHER_REVISION }),
			valid,
		);

		expect(decision).toEqual({ allow: false, reason: "stale_evidence" });
	});

	it("allows an edit to an existing contract target", () => {
		const valid = trustedEvidence();
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("edit", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			valid,
		);

		expect(decision).toEqual({ allow: true });
	});

	it("allows only new files explicitly captured by the trusted Codebase Pack", () => {
		const valid = trustedEvidence(contract(), ["src/generated"], ["src/generated/new.ts"]);
		const policy = new PreToolPolicy(recorder().sink);
		expect(
			policy.evaluate(
				builtinCall("write", { path: "src/generated/new.ts" }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			),
		).toEqual({ allow: true });
		expect(
			policy.evaluate(
				builtinCall("write", { path: "src/generated/unlisted.ts" }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			),
		).toEqual({ allow: false, reason: "scope_violation" });
	});

	it.each(["src/outside.ts", "../escape.ts", "/tmp/escape.ts", "src/generated/../escape.ts", "bad\0path"])(
		"blocks an out-of-scope or unsafe path: %s",
		(path) => {
			const valid = trustedEvidence();
			const decision = new PreToolPolicy(recorder().sink).evaluate(
				builtinCall("write", { path }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			);

			expect(decision).toEqual({ allow: false, reason: "scope_violation" });
		},
	);

	it.each(["task", "hub"])("requires gates but does not invent a file target for %s", (toolName) => {
		const policy = new PreToolPolicy(recorder().sink);
		const valid = trustedEvidence();
		expect(
			policy.evaluate(builtinCall(toolName, { prompt: "delegate Task 14" }), { evidenceRevision: REVISION }),
		).toEqual({ allow: false, reason: "missing_contract" });
		expect(
			policy.evaluate(
				builtinCall(toolName, { prompt: "delegate Task 14" }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			),
		).toEqual({ allow: true });
	});

	it("allows a proven read-only shell command without write gates", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("bash", { command: "cat src/existing.ts" }),
			{
				evidenceRevision: REVISION,
			},
		);

		expect(decision).toEqual({ allow: true });
	});

	it.each(["rg --hostname-bin=/tmp/helper --hyperlink-format=file pattern src", "rg pattern src"])(
		"does not treat ripgrep as intrinsically read-only: %s",
		(command) => {
			const decision = new PreToolPolicy(recorder().sink).evaluate(builtinCall("bash", { command }), {
				evidenceRevision: REVISION,
			});

			expect(decision).toEqual({ allow: false, reason: "missing_contract" });
		},
	);

	it.each(["git diff --check", "git show HEAD", "git log -1"])(
		"does not prove a Git command read-only from its subcommand name: %s",
		(command) => {
			const policy = new PreToolPolicy(recorder().sink);
			expect(
				policy.evaluate(builtinCall("bash", { command }), {
					evidenceRevision: REVISION,
				}),
			).toEqual({ allow: false, reason: "missing_contract" });

			const valid = trustedEvidence();
			expect(
				policy.evaluate(builtinCall("bash", { command }, { evidenceRevision: valid.evidenceRevision }), valid),
			).toEqual({ allow: false, reason: "scope_violation" });
		},
	);

	it("does not treat git status as read-only without a controlled environment", () => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("bash", { command: "git status --short" }),
			{
				evidenceRevision: REVISION,
			},
		);

		expect(decision).toEqual({ allow: false, reason: "missing_contract" });
	});

	it.each(["file -C -m src/existing.magic", "file --compile --magic-file src/existing.magic"])(
		"does not treat a file magic compilation command as read-only: %s",
		(command) => {
			const policy = new PreToolPolicy(recorder().sink);
			const decision = policy.evaluate(builtinCall("bash", { command }), {
				evidenceRevision: REVISION,
			});

			expect(decision).toEqual({ allow: false, reason: "missing_contract" });

			const valid = trustedEvidence();
			expect(
				policy.evaluate(builtinCall("bash", { command }, { evidenceRevision: valid.evidenceRevision }), valid),
			).toEqual({ allow: false, reason: "scope_violation" });
		},
	);

	it("applies scope gates to explicit shell mutation targets", () => {
		const policy = new PreToolPolicy(recorder().sink);
		const valid = trustedEvidence();
		expect(
			policy.evaluate(
				builtinCall("bash", { command: "rm -- src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			),
		).toEqual({ allow: true });
		expect(
			policy.evaluate(
				builtinCall("bash", { command: "touch src/outside.ts" }, { evidenceRevision: valid.evidenceRevision }),
				valid,
			),
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
		const valid = trustedEvidence();
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("bash", { command }, { evidenceRevision: valid.evidenceRevision }),
			valid,
		);

		expect(decision).toEqual({ allow: false, reason: "scope_violation" });
	});
});

describe("PreToolPolicy canonical Codebase identities", () => {
	it.each([...READONLY_CODEBASE_TOOLS])("binds the canonical read-only %s tool to the current project", (toolName) => {
		const policy = new PreToolPolicy(recorder().sink);
		const context = { evidenceRevision: REVISION, projectContext: PROJECT_CONTEXT };
		expect(policy.evaluate(codebaseCall(toolName), context)).toEqual({ allow: true });
		expect(policy.evaluate(codebaseCall(toolName, "advisor"), context)).toEqual({ allow: true });
		expect(policy.evaluate(codebaseCall(toolName), { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "project_identity_mismatch",
		});
		expect(policy.evaluate(codebaseCall(toolName, "main", undefined, {}), context)).toEqual({
			allow: false,
			reason: "project_identity_mismatch",
		});
		expect(
			policy.evaluate(codebaseCall(toolName, "advisor", undefined, { project: "other-project" }), context),
		).toEqual({ allow: false, reason: "project_identity_mismatch" });
	});

	it.each([
		["non-canonical root", { ...PROJECT_CONTEXT, root: `${PROJECT_ROOT}/../omp-custom-v17-adapter` }],
		["relative root", { ...PROJECT_CONTEXT, root: "Users/mima1234/Code/super" }],
		["empty Codebase project", { ...PROJECT_CONTEXT, codebaseProject: "" }],
		["oversized Codebase project", { ...PROJECT_CONTEXT, codebaseProject: "x".repeat(513) }],
	] as const)("rejects a %s in the current project identity", (_label, projectContext) => {
		expect(
			new PreToolPolicy(recorder().sink).evaluate(codebaseCall("search_graph"), {
				evidenceRevision: REVISION,
				projectContext,
			}),
		).toEqual({ allow: false, reason: "project_identity_mismatch" });
	});

	it("allows only Advisor canonical read-only allowlist tools", () => {
		const policy = new PreToolPolicy(recorder().sink);
		expect(
			policy.evaluate(codebaseCall("index_repository", "advisor"), {
				evidenceRevision: REVISION,
				projectContext: PROJECT_CONTEXT,
			}),
		).toEqual({ allow: false, reason: "advisor_tool_forbidden" });
		expect(
			policy.evaluate(builtinCall("edit", { path: "src/existing.ts" }, { actor: "advisor" }), {
				evidenceRevision: REVISION,
			}),
		).toEqual({ allow: false, reason: "advisor_tool_forbidden" });
	});

	it("allows canonical main-agent index_repository and invalidates evidence without a Pack", () => {
		const policy = new PreToolPolicy(recorder().sink);
		const decision = policy.evaluate(codebaseCall("index_repository"), {
			evidenceRevision: REVISION,
			projectContext: PROJECT_CONTEXT,
		});

		expect(decision).toEqual({ allow: true, invalidatesEvidence: true });
		expect(policy.evaluate(codebaseCall("index_repository"), { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "project_identity_mismatch",
		});
	});

	it.each([
		["missing repo_path", {}],
		["other repository", { repo_path: "/Users/mima1234/Code/other" }],
		["symlink alias", { repo_path: "/tmp/omp-custom-v17-adapter-link" }],
		["relative repository", { repo_path: "Users/mima1234/Code/super" }],
		["parent traversal", { repo_path: `${PROJECT_ROOT}/../omp-custom-v17-adapter` }],
		["non-canonical slash", { repo_path: `${PROJECT_ROOT}/` }],
		["cross-repo mode", { repo_path: PROJECT_ROOT, mode: "cross-repo-intelligence" }],
		["foreign target_projects", { repo_path: PROJECT_ROOT, target_projects: ["other-project"] }],
	] as const)("blocks index_repository for %s", (_label, args) => {
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			codebaseCall("index_repository", "main", undefined, args),
			{ evidenceRevision: REVISION, projectContext: PROJECT_CONTEXT },
		);

		expect(decision).toEqual({ allow: false, reason: "project_identity_mismatch" });
	});

	it("binds an active trusted context to the current project identity", () => {
		const valid = trustedEvidence();
		const policy = new PreToolPolicy(recorder().sink);
		expect(
			policy.evaluate(codebaseCall("search_graph"), {
				...valid,
				projectContext: { ...PROJECT_CONTEXT, projectId: "other-project" },
			}),
		).toEqual({ allow: false, reason: "project_identity_mismatch" });
		expect(
			policy.evaluate(builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }), {
				...valid,
				projectContext: { ...PROJECT_CONTEXT, codebaseProject: "other-project" },
			}),
		).toEqual({ allow: false, reason: "project_identity_mismatch" });
	});

	it.each([
		["main read", "main", "search_graph"],
		["Advisor read", "advisor", "search_graph"],
		["main index", "main", "index_repository"],
	] as const)("binds %s to the active trusted task", (_label, actor, toolName) => {
		const valid = trustedEvidence();
		const { records, sink } = recorder();
		const decision = new PreToolPolicy(sink).evaluate(
			{
				...codebaseCall(toolName, actor),
				taskId: "other-task",
				evidenceRevision: valid.evidenceRevision,
			},
			valid,
		);

		expect(decision).toEqual({ allow: false, reason: "task_identity_mismatch" });
		expect(records[0]).toMatchObject({
			contractRevision: valid.contract.revision,
			packEvidenceRevision: valid.codebasePack.evidenceRevision,
			contextEvidenceRevision: valid.evidenceRevision,
			reason: "task_identity_mismatch",
		});
	});

	it("allows current-project index rebuild with only a valid active contract while binding its task", () => {
		const activeContract = contract();
		const policy = new PreToolPolicy(recorder().sink);
		const context = {
			evidenceRevision: REVISION,
			projectContext: PROJECT_CONTEXT,
			contract: activeContract,
		};
		expect(policy.evaluate(codebaseCall("index_repository"), context)).toEqual({
			allow: true,
			invalidatesEvidence: true,
		});
		expect(policy.evaluate({ ...codebaseCall("index_repository"), taskId: "other-task" }, context)).toEqual({
			allow: false,
			reason: "task_identity_mismatch",
		});

		const forgedContract = { ...activeContract, revision: REVISION, contractHash: REVISION };
		expect(policy.evaluate(codebaseCall("index_repository"), { ...context, contract: forgedContract })).toEqual({
			allow: false,
			reason: "invalid_codebase_evidence",
		});
	});

	it.each(["search_graph", "index_status"])(
		"allows current-project read-only Pack bootstrap for active-task tool %s",
		(toolName) => {
			const activeContract = contract();
			const policy = new PreToolPolicy(recorder().sink);
			const context = {
				evidenceRevision: REVISION,
				projectContext: PROJECT_CONTEXT,
				contract: activeContract,
			};

			expect(policy.evaluate(codebaseCall(toolName), context)).toEqual({ allow: true });
			expect(policy.evaluate({ ...codebaseCall(toolName), taskId: "other-task" }, context)).toEqual({
				allow: false,
				reason: "task_identity_mismatch",
			});
		},
	);

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
			{ evidenceRevision: REVISION, projectContext: PROJECT_CONTEXT },
		);
		expect(decision).toEqual({ allow: false, reason: "invalid_input" });

		expect(
			new PreToolPolicy(recorder().sink).evaluate(builtinCall("custom_write_suffix", { path: "src/existing.ts" }), {
				evidenceRevision: REVISION,
			}),
		).toEqual({ allow: false, reason: "unknown_tool" });
	});
});

describe("PreToolPolicy trusted Codebase evidence gate", () => {
	it.each([
		["edit", { path: "src/existing.ts" }],
		["write", { path: "src/existing.ts" }],
		["bash", { command: "rm -- src/existing.ts" }],
		["task", { prompt: "delegate Task 14" }],
		["hub", { prompt: "delegate Task 14" }],
	] as Array<[string, Record<string, unknown>]>)(
		"rejects cross-task reuse for the side-effecting %s tool",
		(toolName, args) => {
			const valid = trustedEvidence();
			const { records, sink } = recorder();
			const decision = new PreToolPolicy(sink).evaluate(
				builtinCall(toolName, args, {
					taskId: "other-task",
					evidenceRevision: valid.evidenceRevision,
				}),
				valid,
			);

			expect(decision).toEqual({ allow: false, reason: "task_identity_mismatch" });
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				task: "other-task",
				canonicalTool: toolName,
				contractRevision: valid.contract.revision,
				packEvidenceRevision: valid.codebasePack.evidenceRevision,
				reason: "task_identity_mismatch",
				remediationAction: "Use a tool call task identity that matches the validated trusted TaskContract.",
			});
		},
	);

	it("rejects an ordinary object pretending to be the Task 12 capability", () => {
		const valid = trustedEvidence();
		const forgedCapability = JSON.parse(JSON.stringify(valid.trustedCodebaseContext));
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, trustedCodebaseContext: forgedCapability },
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
	});

	it("rejects a separately valid contract that is not bound to the trusted context", () => {
		const valid = trustedEvidence();
		const otherContract = createLightweightTaskContract({
			risk: "low",
			changesPublicBehavior: false,
			projectId: PROJECT_ID,
			gitHead: GIT_HEAD,
			taskId: "other-task",
			affectedFiles: ["src/existing.ts"],
			scope: ["other"],
			acceptanceCriteria: ["other"],
			verificationCommands: ["bun test"],
			createdAt: "2026-07-18T00:00:00.000Z",
		});
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, contract: otherContract },
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
	});

	it("rejects a contract whose revision was forged", () => {
		const valid = trustedEvidence();
		const forgedContract = { ...valid.contract, revision: REVISION, contractHash: REVISION };
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, contract: forgedContract },
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
	});

	it("rejects recomputed Pack revisions that expand trusted new-file roots", () => {
		const valid = trustedEvidence();
		const expanded = { ...valid.codebasePack, allowedNewFileRoots: ["src/generated", "src/escape"] };
		const { evidenceRevision: _oldRevision, ...expandedBody } = expanded;
		const forgedPack = { ...expandedBody, evidenceRevision: computeEvidenceRevision(expandedBody) };
		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/escape/owned.ts" }, { evidenceRevision: forgedPack.evidenceRevision }),
			{
				evidenceRevision: forgedPack.evidenceRevision,
				contract: valid.contract,
				codebasePack: forgedPack,
				trustedCodebaseContext: valid.trustedCodebaseContext,
			},
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
	});
});

describe("PreToolPolicy fail-closed input and Evidence handling", () => {
	it("fails closed on high-cardinality args and context without executing accessors", () => {
		let invoked = false;
		const highCardinalityArgs = Object.create(null) as Record<string, unknown>;
		for (let index = 0; index < 20_000; index++) highCardinalityArgs[`field_${index}`] = "value";
		Object.defineProperty(highCardinalityArgs, "lateAccessor", {
			enumerable: true,
			get: () => {
				invoked = true;
				return "PASSWORD_SHOULD_NOT_RUN";
			},
		});
		const highCardinalityCall = builtinCall("write", { path: "src/existing.ts" });
		(highCardinalityCall.identity as { args: unknown }).args = highCardinalityArgs;
		expect(new PreToolPolicy(recorder().sink).evaluate(highCardinalityCall, { evidenceRevision: REVISION })).toEqual({
			allow: false,
			reason: "invalid_input",
		});

		const highCardinalityContext = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(highCardinalityContext, "evidenceRevision", {
			enumerable: true,
			value: REVISION,
		});
		for (let index = 0; index < 20_000; index++) highCardinalityContext[`unknown_${index}`] = index;
		Object.defineProperty(highCardinalityContext, "unknownAccessor", {
			enumerable: true,
			get: () => {
				invoked = true;
				return "Authorization SHOULD_NOT_RUN";
			},
		});
		expect(
			new PreToolPolicy(recorder().sink).evaluate(
				builtinCall("write", { path: "src/existing.ts" }),
				highCardinalityContext as never,
			),
		).toEqual({ allow: false, reason: "missing_contract" });
		expect(invoked).toBe(false);
	});

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
		const valid = trustedEvidence();
		const unsafeContract = { ...valid.contract, affectedFiles };

		const decision = new PreToolPolicy(recorder().sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, contract: unsafeContract },
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
		expect(invoked).toBe(false);
	});

	it("records bounded canonical metadata and stable remediation without raw args", () => {
		const { records, sink } = recorder();
		const args = { path: "src/existing.ts", content: "TOP_SECRET_CONTENT" };
		const call = builtinCall("write", args);
		new PreToolPolicy(sink).evaluate(call, { evidenceRevision: REVISION });

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actor: "main",
			canonicalServer: "omp",
			canonicalTool: "write",
			qualifiedName: "omp.write",
			argsFingerprint: call.identity.argsFingerprint,
			callEvidenceRevision: REVISION,
			reason: "missing_contract",
			remediationHint: "A pre-tool policy requirement was not satisfied.",
			remediationAction: "Provide a valid TaskContract before retrying the tool call.",
		});
		const serialized = JSON.stringify(records[0]);
		expect(serialized).not.toContain("TOP_SECRET_CONTENT");
		expect(serialized).not.toContain("content");
		expect(serialized.length).toBeLessThan(4096);
	});

	it("records contract, context, and Pack revisions on a gated denial", () => {
		const valid = trustedEvidence();
		const { records, sink } = recorder();
		new PreToolPolicy(sink).evaluate(
			builtinCall("write", { path: "src/outside.ts" }, { evidenceRevision: valid.evidenceRevision }),
			valid,
		);

		expect(records[0]).toMatchObject({
			contractRevision: valid.contract.revision,
			contextEvidenceRevision: valid.evidenceRevision,
			packEvidenceRevision: valid.codebasePack.evidenceRevision,
			reason: "scope_violation",
			remediationAction: "Restrict mutation targets to the trusted contract and Codebase evidence scope.",
		});
	});

	it("records revisions only after their Contract and Pack validations succeed", () => {
		const valid = trustedEvidence();
		const forgedContractRevision = `sha256:${"c".repeat(64)}` as const;
		const forgedPackRevision = `sha256:${"d".repeat(64)}` as const;

		const invalidContract = {
			...valid.contract,
			revision: forgedContractRevision,
			contractHash: forgedContractRevision,
		};
		const invalidContractEvidence = recorder();
		const invalidContractDecision = new PreToolPolicy(invalidContractEvidence.sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, contract: invalidContract },
		);
		expect(invalidContractDecision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
		expect(invalidContractEvidence.records[0].contractRevision).toBeUndefined();
		expect(invalidContractEvidence.records[0].packEvidenceRevision).toBeUndefined();
		expect(invalidContractEvidence.records[0].contextEvidenceRevision).toBeUndefined();
		expect(JSON.stringify(invalidContractEvidence.records[0])).not.toContain(forgedContractRevision);

		const invalidPack = { ...valid.codebasePack, evidenceRevision: forgedPackRevision };
		const invalidPackEvidence = recorder();
		const invalidPackDecision = new PreToolPolicy(invalidPackEvidence.sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { evidenceRevision: valid.evidenceRevision }),
			{ ...valid, codebasePack: invalidPack },
		);
		expect(invalidPackDecision).toEqual({ allow: false, reason: "invalid_codebase_evidence" });
		expect(invalidPackEvidence.records[0].contractRevision).toBe(valid.contract.revision);
		expect(invalidPackEvidence.records[0].packEvidenceRevision).toBeUndefined();
		expect(invalidPackEvidence.records[0].contextEvidenceRevision).toBeUndefined();
		expect(JSON.stringify(invalidPackEvidence.records[0])).not.toContain(forgedPackRevision);
	});

	it("uses safe Evidence placeholders without invoking invalid accessors", () => {
		let invoked = false;
		const identity = Object.defineProperty({}, "toolName", {
			enumerable: true,
			get: () => {
				invoked = true;
				return "write";
			},
		});
		const invalidCall = { ...builtinCall("write", { path: "src/existing.ts" }), identity };
		const { records, sink } = recorder();
		const decision = new PreToolPolicy(sink).evaluate(invalidCall as CanonicalToolCall, {
			evidenceRevision: REVISION,
		});

		expect(decision).toEqual({ allow: false, reason: "invalid_input" });
		expect(invoked).toBe(false);
		expect(records[0]).toMatchObject({
			canonicalServer: "<invalid-server>",
			canonicalTool: "<invalid-tool>",
			qualifiedName: "<invalid-qualified-name>",
			argsFingerprint: "<invalid-args-fingerprint>",
		});
	});

	it("does not persist unvalidated or sensitive call identity fields", () => {
		const rawSecrets = [
			"token=task-secret",
			"Authorization Bearer call-secret",
			"https://user:password@example.test/repo",
			"PASSWORD_TOOL_SECRET",
		];
		const invalidCall = builtinCall("write", { path: "src/existing.ts" });
		const invalidIdentity = {
			...invalidCall.identity,
			serverId: rawSecrets[2],
			toolName: rawSecrets[3],
			qualifiedName: `${rawSecrets[2]}.${rawSecrets[3]}`,
		};
		const { records, sink } = recorder();
		const decision = new PreToolPolicy(sink).evaluate(
			{ ...invalidCall, taskId: rawSecrets[0], callId: rawSecrets[1], identity: invalidIdentity },
			{ evidenceRevision: REVISION },
		);

		expect(decision).toEqual({ allow: false, reason: "invalid_input" });
		expect(records[0]).toMatchObject({
			task: "<invalid-task>",
			call: "<invalid-call>",
			canonicalServer: "<invalid-server>",
			canonicalTool: "<invalid-tool>",
			qualifiedName: "<invalid-qualified-name>",
		});
		const serialized = JSON.stringify(records[0]);
		for (const secret of rawSecrets) expect(serialized).not.toContain(secret);
	});

	it("redacts sensitive task and call identifiers on an otherwise valid canonical call", () => {
		const sensitiveTask = "token=valid-task-secret";
		const sensitiveCall = "PASSWORD_valid-call-secret";
		const { records, sink } = recorder();
		const decision = new PreToolPolicy(sink).evaluate(
			builtinCall("write", { path: "src/existing.ts" }, { taskId: sensitiveTask, callId: sensitiveCall }),
			{ evidenceRevision: REVISION },
		);

		expect(decision).toEqual({ allow: false, reason: "missing_contract" });
		expect(records[0].task).toStartWith("<redacted:sha256:");
		expect(records[0].call).toStartWith("<redacted:sha256:");
		const serialized = JSON.stringify(records[0]);
		expect(serialized).not.toContain(sensitiveTask);
		expect(serialized).not.toContain(sensitiveCall);
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
