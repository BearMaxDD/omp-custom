/**
 * Remediation Message Injection.
 *
 * When the Advisor issues a "remediation_required" verdict, this module
 * injects a structured message into the main agent's next turn via
 * sendMessage. The message includes the task id, contract hash, each
 * finding with its reason and required fix, and references to supporting
 * evidence.
 *
 * Rules:
 *  - Only injects when the verdict status is "remediation_required"
 *    with at least one requiredFix.
 *  - Invalid or empty verdicts are silently ignored — no message sent.
 *  - When the task is stalled, automatic injection stops.
 */

import type { SHA256Hash } from "../contract/types";
import type { CustomMessagePayload, ExtensionAPI } from "../types";

// ─── Remediation Parameters ─────────────────────────────────────────

/** A single finding requiring remediation. */
export interface RemediationFinding {
	id: string;
	reason: string;
	requiredFix: string;
	evidenceRefs: string[];
}

/** Full remediation payload sent to the main agent. */
export interface RemediationPayload {
	taskId: string;
	contractHash: SHA256Hash;
	findings: RemediationFinding[];
}

// ─── Injection ──────────────────────────────────────────────────────

/**
 * Inject a remediation message into the main agent's next turn.
 *
 * Sends a structured compliance_remediation message via the extension
 * API, delivered as the next turn with triggerTurn so the agent
 * immediately sees the required fixes.
 *
 * @param api  — the extension API for sendMessage
 * @param payload — remediation data (taskId, contractHash, findings)
 * @returns true if the message was sent, false if conditions not met
 */
export function injectRemediation(api: ExtensionAPI, payload: RemediationPayload): boolean {
	// Guard: no findings → nothing to inject
	if (!payload.findings || payload.findings.length === 0) {
		return false;
	}

	const message: CustomMessagePayload<RemediationPayload> = {
		customType: "compliance_remediation",
		content: "Compliance fix required",
		display: true,
		attribution: "agent",
		details: payload,
	};

	api.sendMessage(message, {
		deliverAs: "nextTurn",
		triggerTurn: true,
	});

	return true;
}
