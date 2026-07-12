/**
 * Tests for buildTopicCodebaseEvidence — from EvidenceSnapshot to codebase
 * context metadata, references, and requested tool names.
 */

import { describe, expect, it } from "bun:test";
import { buildTopicCodebaseEvidence } from "../../src/brainstorm/codebase-evidence";
import { emptyEvidenceSnapshot, fullCodebaseSnapshot } from "./fixtures";

describe("buildTopicCodebaseEvidence", () => {
	it("does not require codebase evidence for a product-only topic", () => {
		const evidence = buildTopicCodebaseEvidence("none", emptyEvidenceSnapshot());
		expect(evidence).toEqual({ mode: "not_needed", references: [], requestedToolNames: [] });
	});

	it("maps verified graph references and requests only read-only MCP tools", () => {
		const evidence = buildTopicCodebaseEvidence("required", fullCodebaseSnapshot());
		expect(evidence.mode).toBe("available");
		expect(evidence.references).toContainEqual(
			expect.objectContaining({ label: "AgentSession.#buildAdvisorRuntime", source: "snippet" }),
		);
		expect(evidence.requestedToolNames.every(name => !name.endsWith("index_repository"))).toBe(true);
	});
});
