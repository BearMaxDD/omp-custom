/**
 * Smoke Test Runner — executes shell commands and records exit code, duration,
 * and potential truncation. Used as a pre-completion gate to verify basic
 * project integrity before the compliance snapshot is frozen.
 */

export interface SmokeTestConfig {
	command: string;
	timeoutMs: number;
}

export interface SmokeTestResult {
	command: string;
	exitCode: number;
	duration: number;
	/** true when output was truncated (or the process was killed by timeout). */
	truncated: boolean;
}

/**
 * Runs a batch of smoke-test commands via Bun.spawn, collecting structured
 * results. Every command receives at most `timeoutMs` milliseconds to complete.
 */
export class SmokeTestRunner {
	/**
	 * Execute all given configurations concurrently, awaiting every result.
	 *
	 * @param configs — list of commands + per-command timeouts
	 * @returns results in the same order as `configs`
	 */
	static async run(configs: SmokeTestConfig[]): Promise<SmokeTestResult[]> {
		const results = await Promise.all(configs.map((cfg) => SmokeTestRunner.runOne(cfg)));
		return results;
	}

	/**
	 * Execute a single smoke-test command.
	 *
	 * The process is spawned via Bun.spawn with stdin, stdout, and stderr
	 * piped.  If the command is not found or does not exit within `timeoutMs`,
	 * the result is marked as truncated with a non-zero exit code.
	 */
	static async runOne(config: SmokeTestConfig): Promise<SmokeTestResult> {
		const start = performance.now();

		try {
			const proc = Bun.spawn(config.command.split(" "), {
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Abort controller for the timeout
			const controller = new AbortController();
			const timer = setTimeout(() => {
				controller.abort();
				proc.kill(); // SIGTERM
			}, config.timeoutMs);

			let truncated = false;

			const exited = await proc.exited;
			clearTimeout(timer);
			const duration = Math.round(performance.now() - start);

			if (controller.signal.aborted) {
				truncated = true;
			}

			return {
				command: config.command,
				exitCode: exited,
				duration,
				truncated,
			};
		} catch {
			const duration = Math.round(performance.now() - start);

			// Process not found, killed, or other spawn error
			return {
				command: config.command,
				exitCode: -1,
				duration,
				truncated: true,
			};
		}
	}
}
