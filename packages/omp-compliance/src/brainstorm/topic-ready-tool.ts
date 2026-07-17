/**
 * Brainstorm Topic Ready Tool — registered as `brainstorm_topic_ready`.
 *
 * The main agent calls this tool when a brainstorming topic has converged
 * on a substantive candidate decision. The tool validates the input,
 * delegates to BrainstormRuntime.submitTopic(), and returns the result
 * to the main agent.
 *
 * Input schema matches BrainstormTopicReadyInput with strict validation.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BrainstormRuntime } from "./brainstorm-runtime";
import type { BrainstormTopicKind, BrainstormTopicReadyInput } from "./types";

// ─── Validation ────────────────────────────────────────────────────────

export interface TopicReadyValidationError {
	readonly field: string;
	readonly message: string;
}

const VALID_TOPIC_KINDS = new Set(["architecture", "scope", "contract", "migration", "risk", "implementation_route"]);
const VALID_RELEVANCE = new Set(["required", "optional", "none"]);

export type TopicReadyValidationResult =
	| { readonly ok: true; readonly value: BrainstormTopicReadyInput }
	| { readonly ok: false; readonly errors: TopicReadyValidationError[] };

function isTopicKind(value: unknown): value is BrainstormTopicKind {
	return typeof value === "string" && VALID_TOPIC_KINDS.has(value);
}

function isCodebaseRelevance(value: unknown): value is BrainstormTopicReadyInput["codebase_relevance"] {
	return typeof value === "string" && VALID_RELEVANCE.has(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate brainstorm_topic_ready tool parameters.
 *
 * Returns either typed input or validation errors.
 */
export function validateTopicReadyInput(raw: Record<string, unknown>): TopicReadyValidationResult {
	const errors: TopicReadyValidationError[] = [];

	// topic_kind — required, must be valid enum
	if (!isTopicKind(raw.topic_kind)) {
		errors.push({
			field: "topic_kind",
			message: `topic_kind must be one of: ${[...VALID_TOPIC_KINDS].join(" | ")}`,
		});
	}

	// title — required, string, max 200 chars
	if (typeof raw.title !== "string" || raw.title.length === 0) {
		errors.push({ field: "title", message: "title is required and must be a non-empty string" });
	} else if (raw.title.length > 200) {
		errors.push({ field: "title", message: "title must be at most 200 characters" });
	}

	// candidate_decision — required, string, max 4,000 chars
	if (typeof raw.candidate_decision !== "string" || raw.candidate_decision.length === 0) {
		errors.push({
			field: "candidate_decision",
			message: "candidate_decision is required and must be a non-empty string",
		});
	} else if (raw.candidate_decision.length > 4_000) {
		errors.push({ field: "candidate_decision", message: "candidate_decision must be at most 4,000 characters" });
	}

	// constraints — required, must be array of strings, max 30 items
	if (!isStringArray(raw.constraints)) {
		errors.push({ field: "constraints", message: "constraints is required and must be an array of strings" });
	} else if (raw.constraints.length > 30) {
		errors.push({ field: "constraints", message: "constraints must have at most 30 items" });
	}

	// success_criteria — required, array of strings, max 30 items
	if (!isStringArray(raw.success_criteria)) {
		errors.push({
			field: "success_criteria",
			message: "success_criteria is required and must be an array of strings",
		});
	} else if (raw.success_criteria.length > 30) {
		errors.push({ field: "success_criteria", message: "success_criteria must have at most 30 items" });
	}

	// unresolved_questions — optional, array of strings, max 30 items
	if (raw.unresolved_questions !== undefined) {
		if (!Array.isArray(raw.unresolved_questions) || !raw.unresolved_questions.every((i) => typeof i === "string")) {
			errors.push({ field: "unresolved_questions", message: "unresolved_questions must be an array of strings" });
		} else if (raw.unresolved_questions.length > 30) {
			errors.push({
				field: "unresolved_questions",
				message: "unresolved_questions must have at most 30 items",
			});
		}
	}

	// codebase_relevance — required, must be valid enum
	if (!isCodebaseRelevance(raw.codebase_relevance)) {
		errors.push({
			field: "codebase_relevance",
			message: `codebase_relevance is required and must be one of: ${[...VALID_RELEVANCE].join(" | ")}`,
		});
	}

	// discussion_summary — required, string, max 8,000 chars
	if (typeof raw.discussion_summary !== "string") {
		errors.push({ field: "discussion_summary", message: "discussion_summary is required and must be a string" });
	} else if (raw.discussion_summary.length > 8_000) {
		errors.push({ field: "discussion_summary", message: "discussion_summary must be at most 8,000 characters" });
	}

	if (errors.length > 0) return { ok: false, errors };

	return {
		ok: true,
		value: {
			topic_kind: raw.topic_kind as BrainstormTopicKind,
			title: raw.title as string,
			candidate_decision: raw.candidate_decision as string,
			constraints: raw.constraints as string[],
			success_criteria: raw.success_criteria as string[],
			unresolved_questions: isStringArray(raw.unresolved_questions) ? raw.unresolved_questions : undefined,
			codebase_relevance: raw.codebase_relevance as BrainstormTopicReadyInput["codebase_relevance"],
			discussion_summary: raw.discussion_summary as string,
		},
	};
}

// ─── Tool factory ──────────────────────────────────────────────────────

export interface TopicReadyToolDependencies {
	readonly runtime: BrainstormRuntime;
	readonly sessionId: () => string;
}

/**
 * Create the brainstorm_topic_ready tool definition.
 *
 * The tool validates input, delegates to BrainstormRuntime.submitTopic(),
 * and returns a structured result to the main agent.
 */
export function createTopicReadyTool(deps: TopicReadyToolDependencies): ToolDefinition {
	return {
		name: "brainstorm_topic_ready",
		label: "Brainstorm Topic Ready",
		description:
			"Submit a substantive brainstorm topic for independent advisor review. " +
			"Call only when the conversation has converged on a well-formed candidate decision.",
		loadMode: "essential",
		approval: "write",
		parameters: {
			type: "object",
			properties: {
				topic_kind: {
					type: "string",
					enum: ["architecture", "scope", "contract", "migration", "risk", "implementation_route"],
					description: "The category of the brainstorm topic.",
				},
				title: { type: "string", maxLength: 200, description: "Short descriptive title." },
				candidate_decision: {
					type: "string",
					maxLength: 4_000,
					description: "The main conclusion the brainstorm has converged on.",
				},
				constraints: {
					type: "array",
					items: { type: "string" },
					maxItems: 30,
					description: "Constraints bounding the decision.",
				},
				success_criteria: {
					type: "array",
					items: { type: "string" },
					maxItems: 30,
					description: "Success criteria the decision must meet.",
				},
				codebase_relevance: {
					type: "string",
					enum: ["required", "optional", "none"],
					description: "Whether codebase context is needed for the advisor review.",
				},
				discussion_summary: {
					type: "string",
					maxLength: 8_000,
					description: "Free-text summary of prior discussion.",
				},
				unresolved_questions: {
					type: "array",
					items: { type: "string" },
					maxItems: 30,
					description: "Open questions for the advisor.",
				},
			},
			required: [
				"topic_kind",
				"title",
				"candidate_decision",
				"constraints",
				"success_criteria",
				"codebase_relevance",
				"discussion_summary",
			],
		},
		execute: async (
			_toolCallId,
			params: Record<string, unknown>,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const validation = validateTopicReadyInput(params);
			if (!validation.ok) {
				return toToolResult({ ok: false, errors: validation.errors }, true);
			}

			try {
				const result = await deps.runtime.submitTopic(validation.value);
				return toToolResult({ ok: true, result });
			} catch (err) {
				return toToolResult(
					{
						ok: false,
						errors: [{ field: "_handler", message: `submitTopic failed: ${String(err)}` }],
					},
					true,
				);
			}
		},
	};
}

function toToolResult(details: Record<string, unknown>, isError = false): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
		isError,
	};
}
