/**
 * Compliance Command — handles `/compliance start <tdd.md>`,
 * `/compliance stop`, `/compliance resume <task_id>`,
 * `/compliance status`, and `/compliance history`.
 *
 * Delegates lifecycle operations to ComplianceRuntime.
 * Status and history are READ-ONLY projections — no side effects.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ComplianceRuntime } from "../runtime/compliance-runtime";
import { readHistory } from "../status/history-reader";
import { toStatusViewModel } from "../status/status-view-model";

// ─── Command Registration ───────────────────────────────────────────

export type DoctorStatus = "ready" | "missing" | "error" | "rebind_required" | "project_mismatch";

export interface DoctorCheck {
	readonly status: DoctorStatus;
	readonly detail: string;
}

export type ComplianceDoctorReport = Readonly<
	Record<"protocol" | "advisor" | "xd" | "codebase" | "project" | "storage", DoctorCheck>
>;

export interface ComplianceCommandServices {
	doctor(context: ExtensionCommandContext): Promise<ComplianceDoctorReport>;
	rebind(context: ExtensionCommandContext): Promise<{ status: "bound"; projectId: string }>;
}

const USAGE =
	"/compliance start <tdd.md> | stop | resume <task_id> | status | history | doctor | rebind | override --reason <reason>";
const DOCTOR_COMPONENTS = ["protocol", "advisor", "xd", "codebase", "project", "storage"] as const;

function parseOverrideReason(args: readonly string[]): string {
	const reasonFlag = args.indexOf("--reason");
	if (reasonFlag < 0 || reasonFlag === args.length - 1) {
		throw new Error("Usage: /compliance override --reason <reason>");
	}
	let reason = args
		.slice(reasonFlag + 1)
		.join(" ")
		.trim();
	if (
		reason.length >= 2 &&
		((reason.startsWith('"') && reason.endsWith('"')) || (reason.startsWith("'") && reason.endsWith("'")))
	) {
		reason = reason.slice(1, -1).trim();
	}
	if (!reason || reason.length > 2048) throw new Error("Override reason must be bounded and non-empty");
	return reason;
}

/**
 * Register the /compliance command on the extension API.
 *
 * Subcommands:
 *   start <tdd_path>    — start a new managed code task
 *   stop                 — stop the current managed task (does not terminate OMP session)
 *   resume <task_id>     — resume a stalled task
 *   status               — show current task status (read-only)
 *   history              — show chronological event history (read-only)
 */
export function registerComplianceCommand(
	api: Pick<ExtensionAPI, "logger" | "registerCommand">,
	runtime: ComplianceRuntime | undefined,
	services: ComplianceCommandServices,
): void {
	api.registerCommand("compliance", {
		description: `Manage compliance tasks. Usage: ${USAGE}`,
		getArgumentCompletions: () =>
			["start", "stop", "resume", "status", "history", "doctor", "rebind", "override"].map((value) => ({
				value,
				label: value,
			})),
		handler: async (rawArgs: string, context: ExtensionCommandContext) => {
			const args: string[] = Array.isArray(rawArgs)
				? (rawArgs as string[])
				: rawArgs.trim().split(/\s+/).filter(Boolean);
			if (args.length === 0) {
				throw new Error(`Usage: ${USAGE}`);
			}

			const subcommand = args[0].toLowerCase();
			if (subcommand === "doctor") {
				const report = await services.doctor(context);
				for (const component of DOCTOR_COMPONENTS) {
					const check = report[component];
					api.logger.info(`Doctor ${component}: ${check.status} — ${check.detail}`);
				}
				return;
			}
			if (!runtime) {
				throw new Error("OMP Advisor Review Protocol v1 is required");
			}

			switch (subcommand) {
				case "start": {
					if (args.length < 2) {
						throw new Error("Usage: /compliance start <tdd.md>");
					}
					const tddPath = args.slice(1).join(" ");
					const result = await runtime.start(tddPath);
					api.logger.info(`Compliance task started: ${result.taskId} (status: ${result.status})`);
					break;
				}

				case "stop": {
					const result = await runtime.stop();
					if (result.stopped) {
						api.logger.info("Compliance task stopped");
					} else {
						api.logger.info("No active compliance task to stop");
					}
					break;
				}

				case "resume": {
					if (args.length < 2) {
						throw new Error("Usage: /compliance resume <task_id>");
					}
					const taskId = args[1];
					const result = await runtime.resume(taskId);
					api.logger.info(`Compliance task resumed: ${taskId} (status: ${result.status})`);
					break;
				}

				case "status": {
					const taskState = runtime.currentTaskState;
					if (!taskState) {
						api.logger.info("No active compliance task");
						break;
					}

					const snapshot = runtime.currentEvidenceSnapshot;
					const view = toStatusViewModel(taskState, snapshot);

					api.logger.info(`Status: ${view.status}`);
					api.logger.info(`TDD path: ${view.tddPath}`);
					api.logger.info(`Contract hash: ${view.contractHashShort}`);
					api.logger.info(`Attempt: ${view.attempt}`);
					api.logger.info(`Advisor available: ${view.advisor.available}`);

					if (view.lastVerdict) {
						api.logger.info(`Last verdict: ${view.lastVerdict.status}`);
						if (view.lastVerdict.summary) {
							api.logger.info(`Summary: ${view.lastVerdict.summary}`);
						}
					}

					if (view.requiredFixes.length > 0) {
						for (const fix of view.requiredFixes) {
							api.logger.info(`Required fix: ${fix}`);
						}
					}

					if (view.verificationSummary) {
						api.logger.info(`Verification: ${view.verificationSummary}`);
					}

					api.logger.info(
						`Evidence gaps — codebase-memory: ${view.evidence.codebaseMemory}, task-delegation: ${view.evidence.taskDelegation}`,
					);
					break;
				}

				case "history": {
					const taskState = runtime.currentTaskState;
					if (!taskState) {
						api.logger.info("No active compliance task");
						break;
					}

					const events = await readHistory(runtime.evidenceStore, taskState.taskId);
					if (events.length === 0) {
						api.logger.info("No history events found");
						break;
					}

					for (const evt of events) {
						api.logger.info(`[${evt.timestamp}] ${evt.event}: ${evt.summary}`);
					}
					break;
				}

				case "rebind": {
					const result = await services.rebind(context);
					api.logger.info(`Compliance project rebound: ${result.projectId} (status: ${result.status})`);
					break;
				}

				case "override": {
					const reason = parseOverrideReason(args);
					const state = await runtime.overrideCompletion({ actor: "user", operator: "user", reason });
					api.logger.info(`Compliance: 人工越权 (status: ${state.status})`);
					break;
				}

				default:
					throw new Error(`Unknown subcommand: ${subcommand}. Usage: ${USAGE}`);
			}
		},
	});
}
