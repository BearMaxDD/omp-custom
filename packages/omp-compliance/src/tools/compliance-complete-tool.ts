/**
 * Compliance Complete Tool — registered as the `compliance_complete` tool.
 *
 * Validates the completion parameters with a zod-like schema, then
 * delegates to the ComplianceRuntime to build the snapshot and
 * transition to advisor_reviewing. Never self-approves — the result
 * is always "advisor_reviewing".
 *
 * Parameter schema (validated inline):
 *   summary: string, 1-4000 chars, required
 *   claimed_verification: string[], max 30 items, each max 500 chars, optional
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ComplianceRuntime } from "../runtime/compliance-runtime";

// ─── Parameter validation ───────────────────────────────────────────

export interface CompletionToolParams {
	summary: string;
	claimed_verification?: string[];
}

export interface ValidationError {
	field: string;
	message: string;
}

/**
 * Validate compliance_complete tool parameters.
 *
 * Returns an array of ValidationError. Empty array = valid.
 */
export function validateCompletionParams(raw: Record<string, unknown>): ValidationError[] {
	const errors: ValidationError[] = [];

	if (raw.summary === undefined || raw.summary === null) {
		errors.push({ field: "summary", message: "summary is required" });
	} else if (typeof raw.summary !== "string") {
		errors.push({ field: "summary", message: "summary must be a string" });
	} else {
		const s = raw.summary as string;
		if (s.length < 1) {
			errors.push({ field: "summary", message: "summary must be at least 1 character" });
		} else if (s.length > 4000) {
			errors.push({ field: "summary", message: "summary must be at most 4000 characters" });
		}
	}

	if (raw.claimed_verification !== undefined && raw.claimed_verification !== null) {
		if (!Array.isArray(raw.claimed_verification)) {
			errors.push({ field: "claimed_verification", message: "claimed_verification must be an array" });
		} else {
			const arr = raw.claimed_verification as unknown[];
			if (arr.length > 30) {
				errors.push({ field: "claimed_verification", message: "claimed_verification must have at most 30 items" });
			}
			for (let i = 0; i < arr.length; i++) {
				if (typeof arr[i] !== "string") {
					errors.push({ field: `claimed_verification[${i}]`, message: "each item must be a string" });
				} else if ((arr[i] as string).length > 500) {
					errors.push({ field: `claimed_verification[${i}]`, message: "each item must be at most 500 characters" });
				}
			}
		}
	}

	return errors;
}

// ─── Tool registration ──────────────────────────────────────────────

/**
 * Register the compliance_complete tool on the extension API.
 *
 * The tool:
 *  1. Validates params against the schema
 *  2. Calls runtime.requestCompletion to build the snapshot and
 *     transition to advisor_reviewing
 *  3. Returns { status: "advisor_reviewing", completionSnapshot }
 */
export function registerComplianceCompleteTool(
	api: Pick<ExtensionAPI, "registerTool">,
	runtime: ComplianceRuntime,
): void {
	const tool: ToolDefinition = {
		name: "compliance_complete",
		label: "Compliance Complete",
		description:
			"Notify the compliance system that a task has been completed. " +
			"Requires a summary of what was done. " +
			"Returns advisor_reviewing status — the Advisor will review and issue a verdict.",
		loadMode: "essential",
		approval: "write",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					minLength: 1,
					maxLength: 4_000,
					description: "Summary of the completed work.",
				},
				claimed_verification: {
					type: "array",
					items: { type: "string", maxLength: 500 },
					maxItems: 30,
					description: "Verification commands or checks claimed by the main agent.",
				},
			},
			required: ["summary"],
			additionalProperties: false,
		},
		execute: async (
			_toolCallId,
			params: Record<string, unknown>,
		): Promise<AgentToolResult<Record<string, unknown>>> => {
			const errors = validateCompletionParams(params);
			if (errors.length > 0) {
				return toToolResult(
					{
						success: false,
						error: "Validation failed",
						validationErrors: errors,
					},
					true,
				);
			}

			const { summary, claimed_verification } = params as unknown as CompletionToolParams;

			try {
				const result = await runtime.requestCompletion({
					summary,
					claimedVerification: claimed_verification,
				});
				return toToolResult({
					success: true,
					status: result.status,
					completionSnapshot: result.completionSnapshot,
					reviewId: result.reviewId,
					receipt: result.receipt,
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return toToolResult(
					{
						success: false,
						error: message,
					},
					true,
				);
			}
		},
	};
	api.registerTool(tool);
}

function toToolResult(details: Record<string, unknown>, isError = false): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
		isError,
	};
}
