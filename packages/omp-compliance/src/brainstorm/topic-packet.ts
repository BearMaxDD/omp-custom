/**
 * Topic Packet Builder — constructs and renders a BrainstormTopicPacket
 * from a BrainstormTopicState and EvidenceSnapshot.
 *
 * The packet is the deterministic, bounded, XML-safe advisor context sent
 * alongside a brainstorm_review trigger.
 *
 * @see 2026-07-13-omp-advisor-brainstorm-topic-review-trd.md §5.2
 */

import type { EvidenceSnapshot } from "../signals/types";
import { buildTopicCodebaseEvidence } from "./codebase-evidence";
import type { BrainstormTopicPacket } from "./types";
import type { BrainstormTopicState } from "./types";

// ─── Build Topic Packet ────────────────────────────────────────────

/**
 * Build a BrainstormTopicPacket from the topic state and evidence snapshot.
 *
 * The packet contains all input fields, the computed codebase context, and
 * stable identifiers. No raw source code is embedded — only label/source
 * references to codebase evidence.
 */
export function buildTopicPacket(topic: BrainstormTopicState, snapshot: EvidenceSnapshot): BrainstormTopicPacket {
	const evidence = buildTopicCodebaseEvidence(topic.input.codebase_relevance, snapshot);

	return {
		schema_version: 1,
		topic_id: topic.topicId,
		input_hash: topic.inputHash,
		topic_kind: topic.input.topic_kind,
		title: topic.input.title,
		candidate_decision: topic.input.candidate_decision,
		constraints: [...topic.input.constraints],
		success_criteria: [...topic.input.success_criteria],
		unresolved_questions: [...(topic.input.unresolved_questions ?? [])],
		discussion_summary: topic.input.discussion_summary,
		codebase_context: {
			mode: evidence.mode,
			references: evidence.references,
		},
	};
}

// ─── Render Topic Packet ───────────────────────────────────────────

/**
 * Render a BrainstormTopicPacket to a deterministic, bounded, XML-safe
 * string for embedding in the advisor prompt.
 *
 * Fields are sorted in a fixed order. Each text field is capped at its
 * documented maximum length. Sensitive patterns (credentials, tokens)
 * are redacted.
 *
 * @returns a string ≤ 16,000 characters wrapping a <brainstorm-topic> block.
 */
export function renderTopicPacket(packet: BrainstormTopicPacket): string {
	const parts: string[] = [];
	parts.push("<brainstorm-topic>");

	// Deterministic field order — schema_version first, codebase_context last.
	appendField(parts, "schema_version", String(packet.schema_version));
	appendField(parts, "topic_id", packet.topic_id);
	appendField(parts, "input_hash", packet.input_hash);
	appendField(parts, "topic_kind", packet.topic_kind);
	appendField(parts, "title", packet.title, 200);
	appendField(parts, "candidate_decision", packet.candidate_decision, 4_000);
	appendListField(parts, "constraints", packet.constraints);
	appendListField(parts, "success_criteria", packet.success_criteria);
	appendListField(parts, "unresolved_questions", packet.unresolved_questions);
	appendField(parts, "discussion_summary", packet.discussion_summary, 8_000);

	parts.push("  <codebase_context>");
	appendField(parts, "mode", packet.codebase_context.mode);
	for (const ref of packet.codebase_context.references) {
		parts.push("    <reference>");
		appendField(parts, "label", ref.label);
		appendField(parts, "source", ref.source);
		parts.push("    </reference>");
	}
	parts.push("  </codebase_context>");

	parts.push("</brainstorm-topic>");

	const raw = parts.join("\n");
	return redactText(raw);
}

// ─── Redaction ─────────────────────────────────────────────────────

/**
 * Redact sensitive credential-like patterns from text.
 * Keeps the output safe for embedding in advisor prompts.
 *
 * This is intentionally simple — it matches well-known patterns such as
 * Authorization headers, Bearer tokens, API keys, and generic tokens.
 */
function redactText(text: string): string {
	return text
		.replace(/Authorization:\s*(\S+)\s+\S+/gi, "Authorization: $1 [REDACTED]")
		.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(/api[_-]?key['"]?\s*[:=]\s*['"]?\S+['"]?/gi, "api_key:[REDACTED]")
		.replace(/token['"]?\s*[:=]\s*['"]?\S+['"]?/gi, "token:[REDACTED]");
}

// ─── Field Helpers ─────────────────────────────────────────────────

/** Append a key: value field after XML-escaping and optional length cap. */
function appendField(parts: string[], key: string, value: string, maxLength?: number): void {
	const safe = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const trimmed = maxLength !== undefined ? safe.slice(0, maxLength) : safe;
	parts.push(`  ${key}: ${trimmed}`);
}

/** Append a list subsection with dash-prefixed items. */
function appendListField(parts: string[], key: string, items: string[]): void {
	parts.push(`  ${key}:`);
	for (const item of items) {
		const safe = item.replace(/</g, "&lt;").replace(/>/g, "&gt;");
		parts.push(`    - ${safe}`);
	}
}
