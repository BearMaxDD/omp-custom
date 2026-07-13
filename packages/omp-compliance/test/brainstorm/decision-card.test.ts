/**
 * Tests for decision-card — renderDecisionCard function.
 *
 * The decision card is a human-readable summary shown to the user
 * after the advisor has produced a review. It contains:
 *   - Current conclusion (candidate decision)
 *   - Advisor objections (high-impact findings)
 *   - Alternative options
 *   - User confirmation prompt
 */

import { describe, expect, it } from "bun:test";
import { renderDecisionCard } from "../../src/brainstorm/decision-card";
import { fullCodebaseSnapshot, makeTopicState, validReview, validTopicInput } from "./fixtures";

// ─── renderDecisionCard ──────────────────────────────────────────────

describe("renderDecisionCard", () => {
	it("preserves high-impact advisor findings and alternatives", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const reviewed = {
			...topic,
			status: "awaiting_user_decision" as const,
			review: validReview(topic),
		};
		const card = renderDecisionCard(reviewed);
		expect(card).toContain("当前结论");
		expect(card).toContain("Advisor 异议（高优先级）");
		expect(card).toContain("命名工具必须只读白名单");
		expect(card).toContain("可选替代方案");
		expect(card).toContain("需要用户明确选择");
	});

	it("includes the candidate decision in the card", () => {
		const topic = makeTopicState(validTopicInput({ candidate_decision: "采用分层架构" }), fullCodebaseSnapshot());
		const reviewed = {
			...topic,
			status: "awaiting_user_decision" as const,
			review: validReview(topic, {
				findings: [{ category: "risk", statement: "分层增加延迟", impact: "medium" }],
				alternatives: [
					{ name: "扁平架构", description: "减少层次", tradeoffs: ["耦合增加"], when_to_choose: "团队小" },
				],
			}),
		};
		const card = renderDecisionCard(reviewed);
		expect(card).toContain("当前结论");
		expect(card).toContain("采用分层架构");
		expect(card).toContain("分层增加延迟");
		expect(card).toContain("扁平架构");
		expect(card).toContain("需要用户明确选择");
	});

	it("handles a topic with an empty findings list", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const reviewed = {
			...topic,
			status: "awaiting_user_decision" as const,
			review: validReview(topic, {
				status: "support",
				findings: [],
				alternatives: [],
			}),
		};
		const card = renderDecisionCard(reviewed);
		expect(card).toContain("当前结论");
		expect(card).not.toContain("Advisor 异议");
		expect(card).toContain("无可用替代方案");
	});

	it("handles a topic without a review gracefully", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const card = renderDecisionCard(topic);
		expect(card).toContain("当前结论");
		expect(card).toContain("暂无可审查结果");
	});
});
