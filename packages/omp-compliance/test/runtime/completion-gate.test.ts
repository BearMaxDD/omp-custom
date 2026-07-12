import { describe, expect, it } from "bun:test";
import { buildCompletionSnapshot } from "../../src/runtime/completion-gate";
import type { CompletionSnapshot, EvidenceFacts, AgentClaim } from "../../src/runtime/completion-gate";
import type { ComplianceContract, ContractSummary, SHA256Hash } from "../../src/contract/types";
import type { EvidenceSnapshot, CodebaseMemoryEvidence, VerificationEvidence, TaskDelegationEvidence } from "../../src/signals/types";
import type { ComplianceVerdict, TaskState } from "../../src/state/types";

// ─── Helpers ────────────────────────────────────────────────────────

const DEFAULT_HASH = "sha256:abc123def456" as SHA256Hash;

function sampleContract(overrides: Partial<ComplianceContract> = {}): ComplianceContract {
	return {
		taskId: "test-task",
		tddPath: "test/tdd.md",
		contractHash: DEFAULT_HASH,
		sourceText: "# Test TDD",
		summary: {
			goal: "Build the feature",
			scope: ["core module"],
			files: ["src/index.ts"],
			tests: ["src/index.test.ts"],
			verification: ["bun test"],
			completionCriteria: ["all tests pass"],
		},
		summaryStatus: "complete",
		policy: {
			taskKind: "code",
			requiresCodebaseMcp: true,
			requiresSubagentDelegation: true,
		},
		...overrides,
	};
}

function sampleSignals(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
	return {
		calls: [],
		results: [],
		codebaseMemory: {
			indexReady: true,
			queries: ["search_code", "get_code_snippet"],
			references: ["src/module.ts"],
		},
		subagentDelegations: [
			{
				agentId: "sub-1",
				taskSummary: "implement module",
				exitCode: 0,
				aborted: false,
				durationMs: 1000,
				outputRefs: [],
				codebaseReferences: [],
				status: "completed",
			},
		],
		verifications: [
			{
				command: "bun test",
				exitCode: 0,
				changedPaths: [],
				passed: true,
			},
		],
		...overrides,
	};
}

function activeTaskState(overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "task-1",
		status: "advisor_reviewing",
		attempt: 1,
		contractHash: DEFAULT_HASH,
		tddPath: "test/tdd.md",
		worktreeFingerprint: "fp-abc",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		consecutiveStalledFingerprints: 0,
		...overrides,
	};
}

function remediationTaskState(overrides: Partial<TaskState> = {}): TaskState {
	return activeTaskState({
		status: "remediation_required",
		lastVerdict: {
			status: "remediation_required",
			summary: "fix test coverage",
			requiredFixes: ["add tests for edge cases", "fix lint errors"],
			schemaValid: true,
		},
		...overrides,
	});
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("CompletionGate — buildCompletionSnapshot", () => {
	it("should include all required fields in the snapshot", () => {
		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-test-001",
			{ summary: "Done" },
		);

		expect(snapshot).toBeDefined();
		expect(snapshot.taskId).toBe("task-1");
		expect(snapshot.timestamp).toBeDefined();
		expect(snapshot.attempt).toBe(1);
		expect(snapshot.contract).toBeDefined();
		expect(snapshot.contract.hash).toBe(DEFAULT_HASH);
		expect(snapshot.contract.tddPath).toBe("test/tdd.md");
		expect(snapshot.contract.summary.goal).toBe("Build the feature");
		expect(snapshot.codebaseMemory).toBeDefined();
		expect(snapshot.verifications).toBeDefined();
		expect(snapshot.delegations).toBeDefined();
		expect(snapshot.diffFingerprint).toBe("fp-test-001");
		expect(snapshot.agentClaim).toBeDefined();
		expect(snapshot.agentClaim.summary).toBe("Done");
		expect(snapshot.remediation).toBeDefined();
		expect(snapshot.remediation.open).toBeDefined();
		expect(snapshot.remediation.closed).toBeDefined();
		expect(snapshot.evidenceFacts).toBeDefined();
	});

	it("should include agent claim with optional claimed_verification", () => {
		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-002",
			{
				summary: "Implemented feature",
				claimedVerification: ["bun test passes", "biome check clean"],
			},
		);

		expect(snapshot.agentClaim.summary).toBe("Implemented feature");
		expect(snapshot.agentClaim.claimedVerification).toEqual([
			"bun test passes",
			"biome check clean",
		]);
	});

	it("should compute evidenceFacts correctly when all evidence present", () => {
		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-003",
			{ summary: "Done" },
		);

		expect(snapshot.evidenceFacts.codebaseMemoryUsed).toBe("present");
		expect(snapshot.evidenceFacts.taskDelegationUsed).toBe("present");
		expect(snapshot.evidenceFacts.verificationRun).toBe("present");
	});

	it("should compute evidenceFacts as 'missing' when no evidence exists", () => {
		const emptySignals = sampleSignals({
			codebaseMemory: { indexReady: false, queries: [], references: [] },
			subagentDelegations: [],
			verifications: [],
		});

		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			emptySignals,
			"fp-004",
			{ summary: "Done" },
		);

		expect(snapshot.evidenceFacts.codebaseMemoryUsed).toBe("missing");
		expect(snapshot.evidenceFacts.taskDelegationUsed).toBe("missing");
		expect(snapshot.evidenceFacts.verificationRun).toBe("missing");
	});

	it("should compute verificationRun as 'partial' when verifications failed", () => {
		const failedSignals = sampleSignals({
			verifications: [
				{ command: "bun test", exitCode: 0, changedPaths: [], passed: true },
				{ command: "biome check", exitCode: 1, changedPaths: [], passed: false },
			],
		});

		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			failedSignals,
			"fp-005",
			{ summary: "Done" },
		);

		expect(snapshot.evidenceFacts.verificationRun).toBe("partial");
	});

	it("should include open remediation when task is remediation_required", () => {
		const snapshot = buildCompletionSnapshot(
			remediationTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-006",
			{ summary: "Fixed issues" },
		);

		expect(snapshot.remediation.open).toHaveLength(2);
		expect(snapshot.remediation.open[0].requiredFix).toBe("add tests for edge cases");
		expect(snapshot.remediation.open[1].requiredFix).toBe("fix lint errors");
	});

	it("should have empty open remediation when task is not remediation_required", () => {
		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-007",
			{ summary: "Done" },
		);

		expect(snapshot.remediation.open).toHaveLength(0);
	});

	it("should NEVER produce pass or remediate in the snapshot", () => {
		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sampleSignals(),
			"fp-008",
			{ summary: "Done" },
		);

		// The snapshot object should not have verdict-like fields
		const keys = Object.keys(snapshot);
		expect(keys).not.toContain("verdict");
		expect(keys).not.toContain("status");
		expect(keys).not.toContain("passed");
		expect(keys).not.toContain("requiresRemediation");

		// The evidenceFacts only describe presence, not pass/fail of policy
		expect(snapshot.evidenceFacts.verificationRun).toBeOneOf(["present", "missing", "partial"]);
	});

	it("should copy signal details into the snapshot", () => {
		const sigs = sampleSignals({
			codebaseMemory: {
				indexReady: true,
				queries: ["search_graph", "trace_path"],
				references: ["src/core.ts", "src/utils.ts"],
			},
			verifications: [
				{ command: "bun test", exitCode: 0, changedPaths: [], passed: true },
			],
			subagentDelegations: [
				{ agentId: "sub-alpha", taskSummary: "write tests", exitCode: 0, aborted: false, durationMs: 500, outputRefs: [], codebaseReferences: [], status: "completed" },
			],
		});

		const snapshot = buildCompletionSnapshot(
			activeTaskState(),
			sampleContract(),
			sigs,
			"fp-009",
			{ summary: "Done" },
		);

		expect(snapshot.codebaseMemory.queries).toContain("search_graph");
		expect(snapshot.codebaseMemory.references).toContain("src/core.ts");
		expect(snapshot.verifications[0].command).toBe("bun test");
		expect(snapshot.delegations[0].agentId).toBe("sub-alpha");
	});
});
