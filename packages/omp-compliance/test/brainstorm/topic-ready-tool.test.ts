/**
 * Tests for topic-ready-tool — brainstorm_topic_ready tool validation
 * and registration pattern.
 */

import { describe, expect, it } from "bun:test";
import type { BrainstormRuntime } from "../../src/brainstorm/brainstorm-runtime";
import { createTopicReadyTool, validateTopicReadyInput } from "../../src/brainstorm/topic-ready-tool";

// ─── validateTopicReadyInput ───────────────────────────────────────────

describe("validateTopicReadyInput", () => {
	it("accepts a valid full input", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "architecture",
			title: "Advisor wiring approach",
			candidate_decision: "Reuse advisor_before_run with dedicated context.",
			constraints: ["User decides", "Read-only advisor"],
			success_criteria: ["Structured review", "Zero side effects on close"],
			codebase_relevance: "required",
			discussion_summary: "We discussed the approach and it converged.",
			unresolved_questions: ["How to handle timeouts?"],
		});
		expect(errors).toEqual([]);
	});

	it("accepts minimal required fields only", () => {
		const errors = validateTopicReadyInput({
			topic_kind: "risk",
			title: "Minimal topic",
			candidate_decision: "A test decision.",
		});
		expect(errors).toEqual([]);
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
});
