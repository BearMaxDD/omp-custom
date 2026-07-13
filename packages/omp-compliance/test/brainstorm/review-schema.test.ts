import { describe, expect, it } from "bun:test";
import { parseBrainstormReview } from "../../src/brainstorm/review-schema";
import { fullCodebaseSnapshot, makeTopicState, validReview, validTopicInput } from "./fixtures";

describe("parseBrainstormReview", () => {
	it("accepts support, challenge, and insufficient_evidence only", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		for (const status of ["support", "challenge", "insufficient_evidence"] as const) {
			expect(
				parseBrainstormReview({ ...validReview(topic), status }, { topicId: topic.topicId, inputHash: topic.inputHash })
					.status,
			).toBe(status);
		}
	});

	it("rejects pass status", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const raw = { ...validReview(topic), status: "pass" };
		expect(() => parseBrainstormReview(raw, { topicId: topic.topicId, inputHash: topic.inputHash })).toThrow("status");
	});

	it("rejects remediate status", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const raw = { ...validReview(topic), status: "remediate" };
		expect(() => parseBrainstormReview(raw, { topicId: topic.topicId, inputHash: topic.inputHash })).toThrow("status");
	});

	it("rejects compliance identity fields", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const context = { topicId: topic.topicId, inputHash: topic.inputHash };
		expect(() => parseBrainstormReview({ ...validReview(topic), task_id: "task-1" }, context)).toThrow();
		expect(() => parseBrainstormReview({ ...validReview(topic), contract_hash: "sha256:abc" }, context)).toThrow();
		expect(() => parseBrainstormReview({ ...validReview(topic), attempt: 1 }, context)).toThrow();
	});

	it("rejects stale topic identity", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const context = { topicId: topic.topicId, inputHash: topic.inputHash };
		expect(() =>
			parseBrainstormReview({ ...validReview(topic), input_hash: "sha256:stale" as const }, context),
		).toThrow("input_hash");
	});

	it("rejects missing status", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const { status: _, ...noStatus } = validReview(topic);
		expect(() => parseBrainstormReview(noStatus, { topicId: topic.topicId, inputHash: topic.inputHash })).toThrow(
			"status",
		);
	});
});

it("rejects non-string evidence_refs elements", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const ctx = { topicId: topic.topicId, inputHash: topic.inputHash };
	const raw = {
		...validReview(topic),
		findings: [{ category: "risk", statement: "test", impact: "high", evidence_refs: [123] }],
	};
	expect(() => parseBrainstormReview(raw as unknown as Record<string, unknown>, ctx)).toThrow("evidence_refs");
});

it("rejects non-sha256: input_hash strings", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const ctx = { topicId: topic.topicId, inputHash: topic.inputHash };
	expect(() => parseBrainstormReview({ ...validReview(topic), input_hash: "md5:abc" }, ctx)).toThrow("input_hash");
});

it("rejects non-string tradeoffs elements", () => {
	const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
	const ctx = { topicId: topic.topicId, inputHash: topic.inputHash };
	const raw = {
		...validReview(topic),
		alternatives: [{ name: "alt", description: "desc", tradeoffs: [123], when_to_choose: "when" }],
	};
	expect(() => parseBrainstormReview(raw as unknown as Record<string, unknown>, ctx)).toThrow("tradeoffs");
});
