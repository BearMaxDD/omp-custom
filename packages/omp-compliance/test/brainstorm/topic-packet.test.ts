/**
 * Tests for buildTopicPacket and renderTopicPacket — constructing bounded
 * XML-safe advisor context from a BrainstormTopicState and EvidenceSnapshot.
 */

import { describe, expect, it } from "bun:test";
import { buildTopicPacket, renderTopicPacket } from "../../src/brainstorm/topic-packet";
import { emptyEvidenceSnapshot, fullCodebaseSnapshot, makeTopicState, validTopicInput } from "./fixtures";
import type { BrainstormTopicPacket } from "../../src/brainstorm/types";

// ─── Packet helpers for edge cases ──────────────────────────────────

/** Build a packet with a title exceeding 200 chars to test truncation. */
function longTitlePacket(): BrainstormTopicPacket {
	return {
		schema_version: 1,
		topic_id: "topic-99",
		input_hash: "sha256:abc",
		topic_kind: "architecture",
		title: "A".repeat(500),
		candidate_decision: "test",
		constraints: [],
		success_criteria: [],
		unresolved_questions: [],
		discussion_summary: "short discussion",
		codebase_context: { mode: "not_needed", references: [] },
	};
}

/** Build a packet with a discussion_summary exceeding 8,000 chars to test truncation. */
function longSummaryPacket(): BrainstormTopicPacket {
	return {
		schema_version: 1,
		topic_id: "topic-99",
		input_hash: "sha256:abc",
		topic_kind: "architecture",
		title: "Short title",
		candidate_decision: "test",
		constraints: [],
		success_criteria: [],
		unresolved_questions: [],
		discussion_summary: "B".repeat(10_000),
		codebase_context: { mode: "not_needed", references: [] },
	};
}

/** Build a packet with sensitive patterns in the discussion_summary. */
function sensitiveContentPacket(): BrainstormTopicPacket {
	const topic = makeTopicState(
		validTopicInput({
			discussion_summary: "Key: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\n"
				+ "Also api_key=sk-abc123def456 and token=xyz789",
		}),
		fullCodebaseSnapshot(),
	);
	return buildTopicPacket(topic, fullCodebaseSnapshot());
}

/** Build a packet with no unresolved questions. */
function noUnresolvedPacket(): BrainstormTopicPacket {
	const topic = makeTopicState(
		validTopicInput({ unresolved_questions: undefined }),
		emptyEvidenceSnapshot(),
	);
	return buildTopicPacket(topic, emptyEvidenceSnapshot());
}

/** Build a packet with empty codebase references (optional, no refs). */
function noRefsPacket(): BrainstormTopicPacket {
	const topic = makeTopicState(
		validTopicInput({ codebase_relevance: "none" }),
		emptyEvidenceSnapshot(),
	);
	return buildTopicPacket(topic, emptyEvidenceSnapshot());
}

// ─── Suite ──────────────────────────────────────────────────────────

describe("buildTopicPacket / renderTopicPacket", () => {
	it("builds deterministic bounded XML-safe advisor context", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const packet = buildTopicPacket(topic, fullCodebaseSnapshot());
		const rendered = renderTopicPacket(packet);
		expect(rendered).toContain("<brainstorm-topic>");
		expect(rendered).toContain("topic_id:");
		expect(rendered).not.toContain("Authorization:");
		expect(rendered.length).toBeLessThanOrEqual(16_000);
	});

	// ── Redaction ──────────────────────────────────────────────────

	it("redacts Bearer tokens from discussion_summary", () => {
		const rendered = renderTopicPacket(sensitiveContentPacket());
		expect(rendered).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
		expect(rendered).toContain("Bearer [REDACTED]");
	});

	it("redacts api_key patterns from discussion_summary", () => {
		const rendered = renderTopicPacket(sensitiveContentPacket());
		expect(rendered).not.toContain("sk-abc123def456");
		expect(rendered).toContain("api_key:[REDACTED]");
	});

	it("redacts generic token patterns from discussion_summary", () => {
		const rendered = renderTopicPacket(sensitiveContentPacket());
		expect(rendered).not.toContain("xyz789");
		expect(rendered).toContain("token:[REDACTED]");
	});

	// ── Field capping ──────────────────────────────────────────────

	it("caps title at 200 characters", () => {
		const rendered = renderTopicPacket(longTitlePacket());
		const titleLine = rendered.split("\n").find(l => l.startsWith("  title:"));
		expect(titleLine).toBeDefined();
		const titleValue = titleLine!.replace("  title: ", "");
		expect(titleValue.length).toBeLessThanOrEqual(200);
	});

	it("caps discussion_summary at 8,000 characters", () => {
		const rendered = renderTopicPacket(longSummaryPacket());
		const summaryLine = rendered.split("\n").find(l => l.startsWith("  discussion_summary:"));
		expect(summaryLine).toBeDefined();
		const summaryValue = summaryLine!.replace("  discussion_summary: ", "");
		expect(summaryValue.length).toBeLessThanOrEqual(8_000);
	});

	// ── Edge cases ─────────────────────────────────────────────────

	it("renders clean codebase_context when no codebase references exist", () => {
		const rendered = renderTopicPacket(noRefsPacket());
		expect(rendered).toContain("<codebase_context>");
		expect(rendered).not.toContain("<reference>");
	});

	it("handles unresolved_questions: undefined without crashing", () => {
		const rendered = renderTopicPacket(noUnresolvedPacket());
		expect(rendered).toContain("unresolved_questions:");
	});

	// ── Determinism ────────────────────────────────────────────────

	it("produces identical output on repeated renders with the same packet", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const packet = buildTopicPacket(topic, fullCodebaseSnapshot());
		const first = renderTopicPacket(packet);
		const second = renderTopicPacket(packet);
		expect(second).toBe(first);
	});
});
