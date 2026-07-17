/**
 * Tests for topic-ready-tool — brainstorm_topic_ready tool validation
 * and registration pattern.
 */

import { describe, expect, it } from "bun:test";
import type { BrainstormRuntime } from "../../src/brainstorm/brainstorm-runtime";
import {
	createTopicReadyTool,
	validateTopicReadyInput as validateTopicReady,
} from "../../src/brainstorm/topic-ready-tool";

const validateTopicReadyInput = (raw: Record<string, unknown>) => {
	const validation = validateTopicReady(raw);
	return validation.ok ? [] : validation.errors;
};

// ─── validateTopicReadyInput ───────────────────────────────────────────

describe("validateTopicReadyInput", () => {
	it("accepts a valid full input", () => {
		const validation = validateTopicReady({
			topic_kind: "architecture",
			title: "Advisor wiring approach",
			candidate_decision: "Reuse advisor_before_run with dedicated context.",
			constraints: ["User decides", "Read-only advisor"],
			success_criteria: ["Structured review", "Zero side effects on close"],
			codebase_relevance: "required",
			discussion_summary: "We discussed the approach and it converged.",
			unresolved_questions: ["How to handle timeouts?"],
		});
		expect(validation).toEqual({
			ok: true,
			value: {
				topic_kind: "architecture",
				title: "Advisor wiring approach",
				candidate_decision: "Reuse advisor_before_run with dedicated context.",
				constraints: ["User decides", "Read-only advisor"],
				success_criteria: ["Structured review", "Zero side effects on close"],
				codebase_relevance: "required",
				discussion_summary: "We discussed the approach and it converged.",
				unresolved_questions: ["How to handle timeouts?"],
			},
		});
	});

	it("rejects non-string codebase_relevance", () => {
		const validation = validateTopicReady({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			codebase_relevance: 42,
		});
		expect(validation.ok).toBe(false);
		if (!validation.ok) expect(validation.errors.some((error) => error.field === "codebase_relevance")).toBe(true);
	});

	it("keeps schema required fields aligned with validator requirements", () => {
		const tool = createTopicReadyTool({
			runtime: {} as unknown as BrainstormRuntime,
			sessionId: () => "session-1",
		});
		const required = [
			"topic_kind",
			"title",
			"candidate_decision",
			"constraints",
			"success_criteria",
			"codebase_relevance",
			"discussion_summary",
		];
		const validInput: Record<string, unknown> = {
			topic_kind: "risk",
			title: "Required fields",
			candidate_decision: "Keep the public contract strict.",
			constraints: [],
			success_criteria: [],
			codebase_relevance: "none",
			discussion_summary: "The required contract is settled.",
		};

		expect((tool.parameters as { required?: string[] }).required).toEqual(required);
		for (const field of required) {
			const input = { ...validInput };
			delete input[field];
			const errors = validateTopicReadyInput(input);
			expect(errors.some((error) => error.field === field)).toBe(true);
		}
		expect(validateTopicReadyInput(validInput)).toEqual([]);
	});

	it("rejects missing topic_kind", () => {
		const errors = validateTopicReadyInput({
			title: "Test",
			candidate_decision: "Test decision.",
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].field).toBe("topic_kind");
	});

	it("rejects invalid topic_kind", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "nonexistent",
			title: "Test",
			candidate_decision: "Test decision.",
		});
		expect(errors.some((e) => e.field === "topic_kind")).toBe(true);
	});

	it("rejects missing title", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			candidate_decision: "Test decision.",
		});
		expect(errors.some((e) => e.field === "title")).toBe(true);
	});

	it("rejects title over 200 characters", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "x".repeat(201),
			candidate_decision: "Test decision.",
		});
		expect(errors.some((e) => e.field === "title")).toBe(true);
	});

	it("rejects missing candidate_decision", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
		});
		expect(errors.some((e) => e.field === "candidate_decision")).toBe(true);
	});

	it("rejects candidate_decision over 4,000 characters", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "x".repeat(4_001),
		});
		expect(errors.some((e) => e.field === "candidate_decision")).toBe(true);
	});

	it("rejects constraints over 30 items", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			constraints: Array.from({ length: 31 }, (_, i) => `Constraint ${i}`),
		});
		expect(errors.some((e) => e.field === "constraints")).toBe(true);
	});

	it("rejects non-array constraints", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			constraints: "not an array",
		});
		expect(errors.some((e) => e.field === "constraints")).toBe(true);
	});

	it("rejects invalid codebase_relevance", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			codebase_relevance: "always",
		});
		expect(errors.some((e) => e.field === "codebase_relevance")).toBe(true);
	});

	it("rejects discussion_summary over 8,000 characters", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			discussion_summary: "x".repeat(8_001),
		});
		expect(errors.some((e) => e.field === "discussion_summary")).toBe(true);
	});

	it("rejects unresolved_questions over 30 items", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Test title",
			candidate_decision: "Test decision.",
			unresolved_questions: Array.from({ length: 31 }, (_, i) => `Q${i}`),
		});
		expect(errors.some((e) => e.field === "unresolved_questions")).toBe(true);
	});
});

// ─── createTopicReadyTool ──────────────────────────────────────────────

describe("createTopicReadyTool", () => {
	it("creates a tool definition with the correct name", () => {
		const tool = createTopicReadyTool({
			runtime: {} as unknown as BrainstormRuntime,
			sessionId: () => "session-1",
		});
		expect(tool.name).toBe("brainstorm_topic_ready");
		expect(tool.description).toBeTruthy();
	});

	it("creates a tool definition with parameters schema", () => {
		const tool = createTopicReadyTool({
			runtime: {} as unknown as BrainstormRuntime,
			sessionId: () => "session-1",
		});
		expect(tool.parameters).toBeTruthy();
		expect(typeof tool.parameters === "object").toBe(true);
	});

	it("returns validation errors from execute for invalid input", async () => {
		const tool = createTopicReadyTool({
			runtime: {
				submitTopic: async () => ({ status: "created", topic: {}, reviewId: "br-test" }),
			} as unknown as BrainstormRuntime,
			sessionId: () => "session-1",
		});

		const result = await tool.execute("topic-ready-test", {}, undefined, undefined, {} as never);
		expect(result.details).toHaveProperty("ok", false);
		expect(result.details).toHaveProperty("errors");
		expect((result.details as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
		expect(result.isError).toBe(true);
	});

	it("stringifies non-Error submit failures", async () => {
		const tool = createTopicReadyTool({
			runtime: {
				submitTopic: async () => {
					throw "topic exploded";
				},
			} as unknown as BrainstormRuntime,
			sessionId: () => "session-1",
		});

		const result = await tool.execute(
			"topic-ready-test",
			{
				topic_kind: "risk",
				title: "Failure",
				candidate_decision: "Exercise error handling.",
				constraints: [],
				success_criteria: [],
				codebase_relevance: "none",
				discussion_summary: "Exercise the handler failure path.",
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(JSON.stringify(result.details)).toContain("topic exploded");
	});
});
