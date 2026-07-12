/**
 * Workflow documentation integrity test.
 *
 * Asserts that the project-level docs (workflow, evidence schema,
 * upgrade runbook) contain all required sections and references.
 *
 * This test reads the markdown files from the monorepo root `docs/`
 * directory and checks for known keywords and structural milestones.
 * At time of creation it is expected to FAIL — run `bun test` from
 * the monorepo root to verify documentation completeness.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(__dirname, "..", "..", "..", "..", "docs");

function readDoc(filename: string): string {
	const filePath = join(DOCS_DIR, filename);
	if (!existsSync(filePath)) {
		return ""; // file not yet created — test will fail
	}
	return readFileSync(filePath, "utf-8");
}

// ─── Document coverage map ─────────────────────────────────────────────

const REQUIRED_DOCS = ["advisor-compliance-workflow.md", "evidence-schema.md", "upstream-upgrade-runbook.md"];

describe("Docs — all required documents exist", () => {
	for (const doc of REQUIRED_DOCS) {
		it(`${doc} exists and is non-empty`, () => {
			const content = readDoc(doc);
			expect(content.length).toBeGreaterThan(200);
		});
	}
});

// ─── advisor-compliance-workflow.md checks ─────────────────────────────

describe("advisor-compliance-workflow.md — CLI command documentation", () => {
	const content = readDoc("advisor-compliance-workflow.md");

	it("documents /compliance start <tdd.md>", () => {
		expect(content).toMatch(/compliance\s+start/i);
		expect(content).toMatch(/tdd\.md/i);
	});

	it("documents /compliance status", () => {
		expect(content).toMatch(/compliance\s+status/i);
	});

	it("documents /compliance stop", () => {
		expect(content).toMatch(/compliance\s+stop/i);
	});

	it("documents /compliance resume <task_id>", () => {
		expect(content).toMatch(/compliance\s+resume/i);
	});

	it("documents /compliance history", () => {
		expect(content).toMatch(/compliance\s+history/i);
	});

	it("documents compliance_complete tool usage", () => {
		expect(content).toMatch(/compliance_complete/i);
	});

	it("explains pass / remediate / stalled semantics", () => {
		expect(content).toMatch(/\bpass\b/i);
		expect(content).toMatch(/remediate/i);
		expect(content).toMatch(/stalled/i);
	});

	it("explains extension disabled behavior", () => {
		expect(content).toMatch(/disabled/i);
	});

	it("mentions strict routing", () => {
		expect(content).toMatch(/strict\s*rout/i);
	});

	it("mentions PlanRun", () => {
		expect(content).toMatch(/plan.?run/i);
	});

	it("covers batch role assignment not migrating", () => {
		expect(content).toMatch(/batch\s*role/i);
	});

	it("covers installation methods (local dev, bun pack, .omp/extensions)", () => {
		expect(content).toMatch(/local dev/i);
		expect(content).toMatch(/bun pack|bun\s+pack/i);
		expect(content).toMatch(/\.omp\/extensions/i);
	});
});

// ─── evidence-schema.md checks ─────────────────────────────────────────

describe("evidence-schema.md — schema documentation", () => {
	const content = readDoc("evidence-schema.md");

	it("describes the JSONL evidence format", () => {
		expect(content).toMatch(/jsonl/i);
	});

	it("documents redaction / truncation strategy", () => {
		expect(content).toMatch(/redact/i);
	});

	it("documents that working directories are not submitted by default", () => {
		expect(content).toMatch(/not\s*submitted|not\s*upload|not\s*sent|local\s*only|default.*not.*submit/i);
	});

	it("documents user-selectable submission strategy", () => {
		expect(content).toMatch(/submit/i);
		expect(content).toMatch(/opt.?in|select|configurable|choose/i);
	});
});

// ─── upstream-upgrade-runbook.md checks ────────────────────────────────

describe("upstream-upgrade-runbook.md — upgrade procedure", () => {
	const content = readDoc("upstream-upgrade-runbook.md");

	it("requires a fresh worktree from upstream/v16.x", () => {
		expect(content).toMatch(/worktree/i);
	});

	it("runs baseline tests (Advisor, Extension, TaskTool)", () => {
		expect(content).toMatch(/advisor/i);
		expect(content).toMatch(/extension/i);
		expect(content).toMatch(/task.?tool/i);
	});

	it("runs independent extension unit tests and behavior fixtures", () => {
		expect(content).toMatch(/independen/i);
	});

	it("verifies extension disabled behavior", () => {
		expect(content).toMatch(/disabled/i);
	});

	it("verifies pass, remediate, stalled semantics", () => {
		expect(content).toMatch(/\bpass\b/i);
		expect(content).toMatch(/remediate/i);
		expect(content).toMatch(/stalled/i);
	});

	it("for bridge patches: compares only ComplianceVerdictTool and buildAdvisorRuntime diff", () => {
		expect(content).toMatch(/compliance.?verdict.?tool/i);
		expect(content).toMatch(/build.?advisor.?runtime/i);
	});

	it("when upstream API supersedes a bridge: regression test then delete", () => {
		expect(content).toMatch(/regression/i);
	});
});
