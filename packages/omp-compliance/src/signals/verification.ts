/**
 * Verification Command Evidence Collector.
 *
 * Recognizes verification-related tool calls (e.g. bash, run) that
 * execute test or lint commands, and extracts exit codes and changed
 * path summaries from the results.
 *
 * Only commands that match known verification patterns are recorded:
 *   - test runners (bun test, jest, vitest)
 *   - linters (biome, eslint, prettier)
 *   - build commands (tsc, bun build)
 *
 * Other bash / run calls are ignored to avoid noise.
 */

import type { ToolCallRecord, ToolResultRecord, VerificationEvidence } from "./types";

/** Patterns that identify verification commands. */
const VERIFICATION_PATTERNS: ReadonlyArray<RegExp> = [
	/\bbun\s+test\b/,
	/\bjest\b/,
	/\bvitest\b/,
	/\bbiome\s+check\b/,
	/\bbiome\s+ci\b/,
	/\beslint\b/,
	/\btsc\b/,
	/\bbun\s+run\s+build\b/,
	/\bvitest\s+run\b/,
];

/**
 * Collect verification evidence from paired call/result entries.
 *
 * Filters tool calls whose toolName indicates command execution
 * (bash, run, exec) and whose params contain a verification-like
 * command string. Returns structured evidence records.
 */
export function collectVerifications(
	paired: ReadonlyArray<{ call: ToolCallRecord; result?: ToolResultRecord }>,
): VerificationEvidence[] {
	const results: VerificationEvidence[] = [];

	for (const { call, result } of paired) {
		const toolName = call.toolName;

		// Only match command-execution tools
		if (toolName !== "bash" && toolName !== "run" && toolName !== "exec") continue;

		const command = extractCommand(call.params);
		if (!command) continue;

		// Check if the command matches any verification pattern
		const isVerification = VERIFICATION_PATTERNS.some((pat) => pat.test(command));
		if (!isVerification) continue;

		// Extract exit code from result
		const exitCode = extractExitCode(result);

		// Extract changed paths from the result text
		const changedPaths = extractChangedPaths(result?.resultRef ?? "");

		results.push({
			command,
			exitCode,
			changedPaths,
			passed: exitCode === 0,
		});
	}

	return results;
}

// ─── Helpers ────────────────────────────────────────────────────

function extractCommand(params: Record<string, unknown>): string | undefined {
	return String(params.command ?? params.cmd ?? params.script ?? "");
}

function extractExitCode(result?: ToolResultRecord): number {
	if (!result) return -1;
	if (!result.success) return 1;

	// Try to extract exit code from resultRef (may be JSON)
	try {
		const parsed = JSON.parse(result.resultRef);
		if (typeof parsed.exitCode === "number") return parsed.exitCode;
		if (typeof parsed.code === "number") return parsed.code;
	} catch {
		// Not JSON, ignore
	}

	return 0;
}

function extractChangedPaths(text: string): string[] {
	if (!text) return [];
	const paths: string[] = [];
	const pathPattern = /[\w./-]+\.[a-z]+(?::\w[\w.]*)?/gi;
	const matched = text.match(pathPattern);
	if (matched) {
		for (const m of matched) {
			if (
				m.includes("/") &&
				(m.endsWith(".ts") ||
					m.endsWith(".tsx") ||
					m.endsWith(".js") ||
					m.endsWith(".jsx") ||
					m.endsWith(".py") ||
					m.endsWith(".go") ||
					m.endsWith(".rs") ||
					m.endsWith(".json") ||
					m.endsWith(".yaml") ||
					m.endsWith(".yml") ||
					m.endsWith(".md"))
			) {
				paths.push(m);
			}
		}
	}
	return paths;
}
