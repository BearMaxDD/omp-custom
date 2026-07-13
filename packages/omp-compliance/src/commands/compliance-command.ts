/**
 * Compliance Command — handles `/compliance start <tdd.md>`,
 * `/compliance stop`, `/compliance resume <task_id>`,
 * `/compliance status`, and `/compliance history`.
 *
 * Delegates lifecycle operations to ComplianceRuntime.
 * Status and history are READ-ONLY projections — no side effects.
 */

import type { ComplianceRuntime } from "../runtime/compliance-runtime";
import { readHistory } from "../status/history-reader";
import { toStatusViewModel } from "../status/status-view-model";
import type { ExtensionAPI } from "../types";

// ─── Command Registration ───────────────────────────────────────────

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
export function registerComplianceCommand(api: ExtensionAPI, runtime: ComplianceRuntime): void {
	api.registerCommand("compliance", {
		description:
			"Manage compliance tasks. " + "Usage: /compliance start <tdd.md> | stop | resume <task_id> | status | history",
		getArgumentCompletions: () => ["start", "stop", "resume", "status", "history"],
		handler: async (args: string[]) => {
			if (args.length === 0) {
				throw new Error("Usage: /compliance start <tdd.md> | stop | resume <task_id> | status | history");
			}

			const subcommand = args[0].toLowerCase();

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

				default:
					throw new Error(
						`Unknown subcommand: ${subcommand}. Usage: /compliance start <tdd.md> | stop | resume <task_id> | status | history`,
					);
			}
		},
	});
}
