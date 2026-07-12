/**
 * Tests for main-agent-guidance — per-turn brainstorm topic submission
 * guidance injected into the main agent's system prompt.
 */

import { describe, expect, it } from "bun:test";
import {
	appendBrainstormGuidance,
	renderMainAgentBrainstormGuidance,
} from "../../src/brainstorm/main-agent-guidance";

describe("renderMainAgentBrainstormGuidance", () => {
	it("lists all topic kinds in the guidance text", () => {
		const guidance = renderMainAgentBrainstormGuidance();
		for (const kind of [
			"architecture",
			"scope",
			"contract",
			"migration",
			"risk",
			"implementation_route",
		]) {
			expect(guidance).toContain(kind);
		}
	});

	it("mentions candidate_decision field", () => {
		const guidance = renderMainAgentBrainstormGuidance();
		expect(guidance).toContain("candidate_decision");
	});

	it("mentions success_criteria field", () => {
		const guidance = renderMainAgentBrainstormGuidance();
		expect(guidance).toContain("success_criteria");
	});

	it("instructs not to call for trivial topics", () => {
		const guidance = renderMainAgentBrainstormGuidance();
		expect(guidance).toContain("Do not call");
		expect(guidance).toContain("wording");
		expect(guidance).toContain("simple clarification");
		expect(guidance).toContain("factual lookup");
	});
});

describe("appendBrainstormGuidance", () => {
	it("appends guidance to the end of the system prompt array", () => {
		const original = ["Existing prompt", "More context"];
		const result = appendBrainstormGuidance({ systemPrompt: original });

		expect(result.systemPrompt.length).toBe(original.length + 1);
		expect(result.systemPrompt[0]).toBe("Existing prompt");
		expect(result.systemPrompt[1]).toBe("More context");
		expect(result.systemPrompt[2]).toContain("Brainstorm Topic Review");
	});

	it("does not mutate the input array", () => {
		const original = ["Original"];
		const snapshot = [...original];
		appendBrainstormGuidance({ systemPrompt: original });
		expect(original).toEqual(snapshot);
	});
});
