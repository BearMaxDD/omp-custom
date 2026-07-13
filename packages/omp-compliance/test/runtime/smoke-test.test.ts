import { describe, expect, it } from "bun:test";
import { SmokeTestRunner, type SmokeTestConfig, type SmokeTestResult } from "../../src/runtime/smoke-test-runner";

describe("SmokeTestRunner", () => {
	it("should execute a simple command and report exit code 0", async () => {
		const results = await SmokeTestRunner.run([
			{ command: "echo hello", timeoutMs: 5_000 },
		]);

		expect(results).toHaveLength(1);
		expect(results[0].command).toBe("echo hello");
		expect(results[0].exitCode).toBe(0);
		expect(results[0].duration).toBeGreaterThanOrEqual(0);
		expect(results[0].truncated).toBe(false);
	});

	it("should report non-zero exit code for failing commands", async () => {
		// `false` exits 1
		const results = await SmokeTestRunner.run([
			{ command: "false", timeoutMs: 5_000 },
		]);

		expect(results).toHaveLength(1);
		expect(results[0].exitCode).not.toBe(0);
	});

	it("should handle timeout and mark result as truncated", async () => {
		const results = await SmokeTestRunner.run([
			// `sleep 10` should be killed by a very short timeout
			{ command: "sleep 10", timeoutMs: 100 },
		]);

		expect(results).toHaveLength(1);
		expect(results[0].truncated).toBe(true);
		// When killed, the exit code may be non-zero or the process may be
		// terminated with a signal
		expect(results[0].duration).toBeLessThan(10_000);
	});

	it("should handle empty config array", async () => {
		const results = await SmokeTestRunner.run([]);
		expect(results).toHaveLength(0);
	});

	it("should execute multiple commands concurrently and return all results", async () => {
		const configs: SmokeTestConfig[] = [
			{ command: "echo a", timeoutMs: 5_000 },
			{ command: "echo b", timeoutMs: 5_000 },
			{ command: "echo c", timeoutMs: 5_000 },
		];

		const results = await SmokeTestRunner.run(configs);

		expect(results).toHaveLength(3);
		results.forEach((r) => {
			expect(r.exitCode).toBe(0);
			expect(r.truncated).toBe(false);
		});
	});
});
