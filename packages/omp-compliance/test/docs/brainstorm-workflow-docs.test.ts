/**
 * Brainstorm workflow documentation integrity test.
 *
 * Asserts that the advisor-brainstorm-workflow.md document contains all
 * required sections references for the Brainstorm Topic Review workflow:
 * CLI commands, tools, lifecycle states, decision card, and installation.
 *
 * This test reads the markdown file from the monorepo root `docs/`
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

const REQUIRED_DOCS = ["advisor-brainstorm-workflow.md"];

describe("Docs — all required documents exist", () => {
	for (const doc of REQUIRED_DOCS) {
		it(`${doc} exists and is non-empty`, () => {
			const content = readDoc(doc);
			expect(content.length).toBeGreaterThan(200);
		});
	}
});

// ─── advisor-brainstorm-workflow.md checks ─────────────────────────────

describe("advisor-brainstorm-workflow.md — CLI command documentation", () => {
	const content = readDoc("advisor-brainstorm-workflow.md");

	it("documents /brainstorm status command", () => {
		expect(content).toMatch(/brainstorm\s+status/i);
	});

	it("documents /brainstorm history command", () => {
		expect(content).toMatch(/brainstorm\s+history/i);
	});

	it("documents /brainstorm retry command", () => {
		expect(content).toMatch(/brainstorm\s+retry/i);
	});

	it("documents /brainstorm park command", () => {
		expect(content).toMatch(/brainstorm\s+park/i);
	});

	it("documents brainstorm_topic_ready tool", () => {
		expect(content).toMatch(/brainstorm_topic_ready/i);
	});

	it("documents brainstorm_decision tool", () => {
		expect(content).toMatch(/brainstorm_decision/i);
	});

	it("explains brainstorm_review advisor tool", () => {
		expect(content).toMatch(/brainstorm_review/i);
	});

	it("covers topic lifecycle states", () => {
		expect(content).toMatch(
			/drafting|ready_for_advisor_review|advisor_reviewing|awaiting_user_decision|review_unavailable|decided|parked/i,
		);
	});

	it("mentions decision card", () => {
		expect(content).toMatch(/decision.?card/i);
	});

	it("covers installation methods (local dev, bun pack, .omp/extensions)", () => {
		expect(content).toMatch(/local dev/i);
		expect(content).toMatch(/bun pack|bun\s+pack/i);
		expect(content).toMatch(/\.omp\/extensions/i);
	});
});
