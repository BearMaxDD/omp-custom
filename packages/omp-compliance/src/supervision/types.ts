/**
 * Types for the supervision engine and detectors.
 *
 * The supervision engine monitors tool-call events and produces
 * structured findings (advisories + evidence) via registered hooks.
 */

export type Severity = "nit" | "concern" | "blocker";

export interface SupervisionFinding {
	id: string;
	detector: string;
	severity: Severity;
	message: string;
	timestamp: string;
}

export interface SupervisionHook {
	readonly id: string;
	onToolResult?(event: { toolName: string; success: boolean }): SupervisionFinding | undefined;
}
