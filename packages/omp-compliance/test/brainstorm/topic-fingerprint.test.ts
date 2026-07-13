import { describe, expect, it } from "bun:test";
import { computeTopicFingerprint, normalizeTopicInput } from "../../src/brainstorm/topic-fingerprint";

const input = {
	topic_kind: "architecture" as const,
	title: "专题评审传输",
	candidate_decision: "复用 advisor_before_run",
	constraints: ["用户最终决定", "只读 Advisor"],
	success_criteria: ["结构化 review", "扩展关闭零副作用"],
	unresolved_questions: [],
	codebase_relevance: "required" as const,
	discussion_summary: "已经完成方案 A/B/C 对比。",
};

describe("topic fingerprint", () => {
	it("ignores list order and surrounding whitespace", () => {
		const reordered = { ...input, constraints: [" 只读 Advisor ", "用户最终决定"] };
		expect(computeTopicFingerprint(input, [])).toBe(computeTopicFingerprint(reordered, []));
	});

	it("changes when a substantive constraint or code reference changes", () => {
		expect(computeTopicFingerprint(input, [])).not.toBe(
			computeTopicFingerprint({ ...input, constraints: [...input.constraints, "单专题串行"] }, []),
		);
		expect(computeTopicFingerprint(input, ["AgentSession.#buildAdvisorRuntime"])).not.toBe(
			computeTopicFingerprint(input, ["ExtensionRunner.emitBeforeRun"]),
		);
	});

	it("rejects non-substantive topic input", () => {
		expect(() => normalizeTopicInput({ ...input, candidate_decision: " " })).toThrow("candidate_decision");
	});
});
