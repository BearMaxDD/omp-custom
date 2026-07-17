/**
 * Brainstorm Decision Tool — registered as `brainstorm_decision`.
 *
 * The main agent calls this tool when the user has explicitly chosen
 * a decision outcome for a brainstorm topic. The tool requires
 * `user_confirmed: true` — advisor 'support' alone cannot auto-decide.
 *
 * Input schema:
 *   topic_id: string (required)
 *   decision: "accept_candidate" | "accept_alternative" | "reopen" | "park" (required)
 *   selected_alternative?: string (required when decision is "accept_alternative")
 *   rationale?: string, max 4000 chars
 *   user_confirmed: boolean (required, must be true)
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TopicCoordinator } from "./topic-coordinator";

// ─── Validation Types ────────────────────────────────────────────────

export interface DecisionValidationError {
	readonly field: string;
	readonly message: string;
}

const VALID_DECISIONS = new Set(["accept_candidate", "accept_alternative", "reopen", "park"]);

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate brainstorm_decision tool parameters.
 *
 * Returns an array of ValidationError. Empty array = valid.
 * Enforces user_confirmed: true at the validation layer.
 */
export function validateDecisionInput(raw: Record<string, unknown>): DecisionValidationError[] {
	const errors: DecisionValidationError[] = [];

	// topic_id — required, non-empty string
	if (typeof raw.topic_id !== "string" || raw.topic_id.length === 0) {
		errors.push({ field: "topic_id", message: "topic_id is required and must be a non-empty string" });
	}

	// decision — required, valid enum value
	if (typeof raw.decision !== "string" || !VALID_DECISIONS.has(raw.decision)) {
		errors.push({
			field: "decision",
			message: "decision must be one of: accept_candidate, accept_alternative, reopen, park",
		});
	}

	// user_confirmed — required, must be true
	if (raw.user_confirmed !== true) {
		errors.push({ field: "user_confirmed", message: "user_confirmed must be true — user must explicitly confirm" });
	}

	// selected_alternative — required when decision is "accept_alternative"
	if (raw.decision === "accept_alternative") {
		if (typeof raw.selected_alternative !== "string" || raw.selected_alternative.length === 0) {
			errors.push({
				field: "selected_alternative",
				message: "selected_alternative is required when decision is accept_alternative",
			});
		}
	}

	// rationale — optional, max 4000 chars
	if (raw.rationale !== undefined && raw.rationale !== null) {
		if (typeof raw.rationale !== "string") {
			errors.push({ field: "rationale", message: "rationale must be a string" });
		} else if (raw.rationale.length > 4_000) {
			errors.push({ field: "rationale", message: "rationale must be at most 4,000 characters" });
		}
	}

	return errors;
}

// ─── Tool Dependencies ───────────────────────────────────────────────

export interface DecisionToolDependencies {
	readonly coordinator: TopicCoordinator;
}

// ─── Tool Factory ────────────────────────────────────────────────────

/**
 * Create the brainstorm_decision tool definition.
 *
 * The handler validates input, enforces user_confirmed: true, then
 * delegates to TopicCoordinator.recordDecision() with the structured
 * BrainstormDecision.
 */
export function createDecisionTool(deps: DecisionToolDependencies): ToolDefinition {
	return {
		name: "brainstorm_decision",
		label: "Brainstorm Decision",
		description:
			"Record the user's explicit decision on a brainstorm topic. " +
			"Requires user_confirmed: true — advisor support alone cannot decide. " +
			"Use after showing the decision card to the user.",
		loadMode: "essential",
		approval: "write",
		parameters: {
			type: "object",
			properties: {
				topic_id: {
					type: "string",
					description: "The topic ID from the brainstorm topic.",
				},
				decision: {
					type: "string",
					enum: ["accept_candidate", "accept_alternative", "reopen", "park"],
					description: "The user's decision outcome.",
				},
				selected_alternative: {
					type: "string",
					description: "Required when decision is accept_alternative — name of the chosen alternative.",
				},
				rationale: {
					type: "string",
					maxLength: 4_000,
					description: "Optional free-text rationale for the decision.",
				},
				user_confirmed: {
					type: "boolean",
					description: "Must be true — the user must explicitly confirm this decision.",
				},
			},
			required: ["topic_id", "decision", "user_confirmed"],
		},
		execute: async (
			_toolCallId,
			params: Record<string, unknown>,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const errors = validateDecisionInput(params);
			if (errors.length > 0) {
				return toToolResult({ ok: false, errors }, true);
			}

			try {
				const topicId = params.topic_id as string;
				const decision = params.decision as "accept_candidate" | "accept_alternative" | "reopen" | "park";
				const selectedAlternative = params.selected_alternative as string | undefined;
				const rationale = params.rationale as string | undefined;

				await deps.coordinator.recordDecision(topicId, {
					topic_id: topicId,
					decision,
					selected_alternative: selectedAlternative,
					rationale,
					ts: new Date().toISOString(),
				});

				return toToolResult({ ok: true });
			} catch (err) {
				return toToolResult(
					{
						ok: false,
						errors: [{ field: "_handler", message: `recordDecision failed: ${(err as Error).message}` }],
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
