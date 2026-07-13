import { describe, expect, it } from "bun:test";
import { ADVISOR_ALLOWED_TOOLS, renderCompletionRules } from "../../src/advisor/default-rule-pack";
import type { ComplianceExecutionPolicy } from "../../src/contract/types";

// ─── Helpers ────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────

describe("renderCompletionRules", () => {
	it("includes global rules for any policy", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules).toContain("pass-meaning");
		expect(rules).toContain("remediate-requires-fix");
		expect(rules).toContain("idempotent-verdict");
		expect(rules).toContain("schema-compliance");
		expect(rules).toContain("tool-restrictions");
	});

	it("includes code task rules for code policy", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules).toContain("requiresCodebaseMcp");
		expect(rules).toContain("requiresSubagentDelegation");
		expect(rules).toContain("requiresVerification");
		expect(rules).toContain("contractChangedPaths");
	});

	it("includes code task section heading for code policy", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules).toContain("# Code Task Rules");
	});

	it("includes non-code task rules for non_code policy", () => {
		const rules = renderCompletionRules(nonCodePolicy);
		expect(rules).toContain("nonCodeEvidence");
		expect(rules).toContain("nonCodeVerification");
	});

	it("includes non-code task section heading for non_code policy", () => {
		const rules = renderCompletionRules(nonCodePolicy);
		expect(rules).toContain("# Non-Code Task Rules");
	});

	it("does NOT include code task rules for non_code policy", () => {
		const rules = renderCompletionRules(nonCodePolicy);
		expect(rules).not.toContain("requiresCodebaseMcp");
		expect(rules).not.toContain("requiresSubagentDelegation");
	});

	it("lists allowed tools", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules).toContain("Allowed Tools");
		for (const tool of ADVISOR_ALLOWED_TOOLS) {
			expect(rules).toContain(tool);
		}
	});

	it("allowed tools are exactly read, grep, glob, advise, compliance_verdict", () => {
		expect(ADVISOR_ALLOWED_TOOLS).toEqual(["read", "grep", "glob", "advise", "compliance_verdict"]);
	});

	it("produces deterministic output for the same policy", () => {
		const first = renderCompletionRules(codePolicy);
		const second = renderCompletionRules(codePolicy);
		expect(first).toBe(second);
	});

	it("returns a non-empty string", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules.length).toBeGreaterThan(100);
	});

	it("pass meaning rule says pass != command success", () => {
		const rules = renderCompletionRules(codePolicy);
		expect(rules).toContain("does NOT mean every command exited 0");
	});
});
