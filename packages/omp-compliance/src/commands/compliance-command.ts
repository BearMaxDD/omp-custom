/**
 * Compliance Command — handles `/compliance start <tdd.md>`,
 * `/compliance stop`, and `/compliance resume <task_id>`.
 *
 * Delegates all operations to the ComplianceRuntime.
 */

import type { ExtensionAPI } from "../types";
import type { ComplianceRuntime } from "../runtime/compliance-runtime";

// ─── Command Registration ───────────────────────────────────────────

/**
 * Register the /compliance command on the extension API.
 *
 * Subcommands:
 *   start <tdd_path>   — start a new managed code task
 *   stop                — stop the current managed task
 *   resume <task_id>    — resume a stalled task
 */
export function registerComplianceCommand(
	api: ExtensionAPI,
	runtime: ComplianceRuntime,
): void {
	api.registerCommand("compliance", {
		description:
			"Start, stop, or resume a managed compliance task. " +
			"Usage: /compliance start <tdd.md> | stop | resume <task_id>",
		getArgumentCompletions: () => ["start", "stop", "resume"],
		handler: async (args: string[]) => {
			if (args.length === 0) {
				throw new Error(
					"Usage: /compliance start <tdd.md> | stop | resume <task_id>",
				);
			}

			const subcommand = args[0].toLowerCase();

			switch (subcommand) {
				case "start": {
					if (args.length < 2) {
						throw new Error(
							"Usage: /compliance start <tdd.md>",
						);
					}
					const tddPath = args.slice(1).join(" ");
					const result = await runtime.start(tddPath);
					api.logger.info(
						`Compliance task started: ${result.taskId} (status: ${result.status})`,
					);
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
						throw new Error(
							"Usage: /compliance resume <task_id>",
						);
					}
					const taskId = args[1];
					const result = await runtime.resume(taskId);
					api.logger.info(
						`Compliance task resumed: ${taskId} (status: ${result.status})`,
					);
					break;
				}

				default:
					throw new Error(
						`Unknown subcommand: ${subcommand}. ` +
						"Usage: /compliance start <tdd.md> | stop | resume <task_id>",
					);
			}
		},
	});
}
