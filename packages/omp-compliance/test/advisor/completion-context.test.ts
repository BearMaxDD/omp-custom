import { describe, expect, it } from "bun:test";
import { buildCompletionContext } from "../../src/advisor/completion-context";
import type { ComplianceExecutionPolicy, SHA256Hash } from "../../src/contract/types";
import type { CompletionSnapshot } from "../../src/runtime/completion-gate";

// ─── Helpers ────────────────────────────────────────────────────────

const DEFAULT_HASH = "sha256:abc123def456" as SHA256Hash;

const codePolicy: ComplianceExecutionPolicy = {
	taskKind: "code",
	requiresCodebaseMcp: true,
	requiresSubagentDelegation: true,
};

const nonCodePolicy: ComplianceExecutionPolicy = {
	taskKind: "non_code",
	requiresCodebaseMcp: false,
	requiresSubagentDelegation: false,
};

function sampleSnapshot(overrides: Partial<CompletionSnapshot> = {}): CompletionSnapshot {
	return {
		taskId: "code-task",
		timestamp: "2026-07-13T12:00:00.000Z",
		attempt: 1,
		contract: {
			hash: DEFAULT_HASH,
			tddPath: ".omp/tdd/code-task.md",
			summary: {
				goal: "Implement the login feature",
				scope: ["Add authentication", "Handle errors"],
				files: ["src/login.ts", "src/auth.ts"],
				tests: ["login.test.ts"],
				verification: ["bun test"],
				completionCriteria: ["All tests pass"],
			},
		},
		codebaseMemory: {
			indexReady: true,
			queries: ["find login component", "search auth patterns"],
			references: ["src/login.ts", "src/auth.ts"],
		},
		verifications: [
			{ command: "bun test", exitCode: 0, passed: true },
			{ command: "bun run build", exitCode: 0, passed: true },
		],
		delegations: [{ agentId: "AuthLoader", taskSummary: "Load auth module" }],
		diffFingerprint: "abc123",
		agentClaim: {
			summary: "Implemented login with JWT auth",
			claimedVerification: ["bun test", "bun run build"],
		},
		remediation: {
			open: [],
			closed: [],
		},
		evidenceFacts: {
			codebaseMemoryUsed: "present",
			taskDelegationUsed: "present",
			verificationRun: "present",
		},
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("buildCompletionContext", () => {
	it("returns XML wrapped in compliance-task tags", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toStartWith("<compliance-task>");
		expect(xml).toEndWith("</compliance-task>");
	});

	it("includes task_id field", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("<task_id>code-task</task_id>");
	});

	it("includes tdd_path field", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("<tdd_path>.omp/tdd/code-task.md</tdd_path>");
	});

	it("includes contract_hash field", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain(`<contract_hash>${DEFAULT_HASH}</contract_hash>`);
	});

	it("includes execution_policy field", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain(
			"<execution_policy>taskKind=code, requiresCodebaseMcp=true, requiresSubagentDelegation=true</execution_policy>",
		);
	});

	it("includes contract_summary with goal", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("goal: Implement the login feature");
	});

	it("includes verification_summary", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("passed");
		expect(xml).toContain("bun test");
	});

	it("includes codebase_memory_evidence", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("indexReady=true");
	});

	it("includes subagent_delegation_evidence", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("AuthLoader");
	});

	it('shows "none" for empty verifications', () => {
		const xml = buildCompletionContext(sampleSnapshot({ verifications: [] }), codePolicy);
		expect(xml).toContain("none");
	});

	it('shows "none" for empty delegations', () => {
		const xml = buildCompletionContext(sampleSnapshot({ delegations: [] }), codePolicy);
		expect(xml).toContain("<subagent_delegation_evidence>none</subagent_delegation_evidence>");
	});

	it('shows "none" for empty prior remediation', () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("<prior_remediation>none</prior_remediation>");
	});

	it("includes prior remediation when present", () => {
		const xml = buildCompletionContext(
			sampleSnapshot({
				remediation: {
					open: [{ id: "fix-1", requiredFix: "Add auth middleware" }],
					closed: [],
				},
			}),
			codePolicy,
		);
		expect(xml).toContain("fix-1");
		expect(xml).toContain("Add auth middleware");
	});

	it("includes completion_claim", () => {
		const xml = buildCompletionContext(sampleSnapshot(), codePolicy);
		expect(xml).toContain("<completion_claim>Implemented login with JWT auth</completion_claim>");
	});

	it("enforces max XML length by truncating oversized payloads", () => {
		// Build a snapshot with a very long goal to trigger truncation
		const longGoal = "x".repeat(10_000);
		const xml = buildCompletionContext(
			sampleSnapshot({
				contract: {
					hash: DEFAULT_HASH,
					tddPath: ".omp/tdd/code-task.md",
					summary: {
						goal: longGoal,
						scope: [],
						files: [],
						tests: [],
						verification: [],
						completionCriteria: [],
					},
				},
				verifications: [],
				delegations: [],
			}),
			codePolicy,
		);
		// Should still produce valid XML tags
		expect(xml).toStartWith("<compliance-task>");
		expect(xml).toEndWith("</compliance-task>");
		// Should be truncated to max length
		expect(xml.length).toBeLessThanOrEqual(8_040);
	});

	it("renders non-code policy correctly", () => {
		const xml = buildCompletionContext(sampleSnapshot(), nonCodePolicy);
		expect(xml).toContain(
			"<execution_policy>taskKind=non_code, requiresCodebaseMcp=false, requiresSubagentDelegation=false</execution_policy>",
		);
	});

	it("escapes XML special characters in values", () => {
		const xml = buildCompletionContext(
			sampleSnapshot({
				agentClaim: {
					summary: "Implemented <login> & auth",
				},
			}),
			codePolicy,
		);
		expect(xml).toContain("&lt;login&gt;");
		expect(xml).toContain("&amp;");
	});
});
