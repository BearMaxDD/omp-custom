/**
 * Shared test fixtures for Brainstorm topic tests.
 *
 * All tests MUST import from this file rather than inventing their own
 * field names or values. This central fixture ensures consistency across
 * the brainstorm test suite.
 */

import { computeTopicFingerprint, normalizeTopicInput } from "../../src/brainstorm/topic-fingerprint";
import type { BrainstormReview, BrainstormTopicReadyInput, BrainstormTopicState } from "../../src/brainstorm/types";
import type { EvidenceSnapshot } from "../../src/signals/types";

// ─── Input Fixtures ──────────────────────────────────────────────────

/**
 * Create a valid brainstorm topic input with optional overrides.
 *
 * Default values represent a realistic architecture decision scenario.
 * Use `overrides` to produce edge cases (blank fields, excessive lists, etc.)
 * without repeating the full shape.
 */
export function validTopicInput(overrides: Partial<BrainstormTopicReadyInput> = {}): BrainstormTopicReadyInput {
	return {
		topic_kind: "architecture",
		title: "Advisor 专题评审接线",
		candidate_decision: "复用 advisor_before_run 专用审查链路",
		constraints: ["用户最终决定", "Advisor 保持只读"],
		success_criteria: ["结构化 review", "扩展关闭零副作用"],
		unresolved_questions: [],
		codebase_relevance: "required",
		discussion_summary: "主代理已经完成候选方案和约束收敛。",
		...overrides,
	};
}

// ─── Evidence Snapshots ──────────────────────────────────────────────

/** An empty evidence snapshot — no tool calls, no codebase queries. */
export function emptyEvidenceSnapshot(): EvidenceSnapshot {
	return {
		calls: [],
		results: [],
		codebaseMemory: { indexReady: false, queries: [], references: [] },
		subagentDelegations: [],
		verifications: [],
	};
}

/** A full evidence snapshot with codebase-memory queries and references. */
export function fullCodebaseSnapshot(): EvidenceSnapshot {
	return {
		...emptyEvidenceSnapshot(),
		codebaseMemory: {
			indexReady: true,
			queries: ["search_graph", "get_code_snippet"],
			references: ["AgentSession.#buildAdvisorRuntime", "ExtensionRunner.emitBeforeRun"],
		},
	};
}

// ─── Review Fixture ──────────────────────────────────────────────────

/**
 * Create a valid brainstorm review for a given topic state.
 *
 * Defaults to a "challenge" review with one risk finding. Use
 * `overrides` to produce other review statuses or edge cases.
 */
export function validReview(topic: BrainstormTopicState, overrides: Partial<BrainstormReview> = {}): BrainstormReview {
	return {
		schema_version: 1,
		topic_id: topic.topicId,
		input_hash: topic.inputHash,
		status: "challenge",
		summary: "候选方案可行，但需要限制动态工具权限。",
		findings: [{ category: "risk", statement: "命名工具必须只读白名单", impact: "high" }],
		alternatives: [],
		recommendation: "复用 Hook，同时增加只读工具白名单。",
		confidence: "high",
		...overrides,
	};
}

// ─── State Fixture ───────────────────────────────────────────────────

/**
 * Create a valid BrainstormTopicState ready for advisor review.
 *
 * Accepts an optional custom input and evidence snapshot. If not provided,
 * defaults are used. The returned state has a computed fingerprint and
 * status `ready_for_advisor_review`.
 */
export function makeTopicState(
	input: BrainstormTopicReadyInput = validTopicInput(),
	evidence: EvidenceSnapshot = fullCodebaseSnapshot(),
): BrainstormTopicState {
	const normalized = normalizeTopicInput(input);
	return {
		topicId: "topic-01",
		inputHash: computeTopicFingerprint(normalized, evidence.codebaseMemory.references),
		status: "ready_for_advisor_review",
		attempt: 1,
		input: normalized,
	};
}
