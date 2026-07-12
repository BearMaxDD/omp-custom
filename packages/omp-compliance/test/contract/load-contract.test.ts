import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareContractRevision, loadComplianceContract } from "../../src/contract/load-contract";
import { ContractLoadError } from "../../src/contract/types";

const fixturesDir = join(__dirname, "..", "fixtures", "contracts");
const repoRoot = resolve(join(__dirname, "..", ".."));

function fixturePath(name: string): string {
	return join(fixturesDir, name);
}

describe("loadComplianceContract", () => {
	it("loads a structured code-task TDD with complete summary", () => {
		const contract = loadComplianceContract(fixturePath("code-task.md"), repoRoot);

		expect(contract.taskId).toBe("code-task");
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.sourceText.length).toBeGreaterThan(0);
		expect(contract.summaryStatus).toBe("complete");

		// Code-task default policy
		expect(contract.policy.taskKind).toBe("code");
		expect(contract.policy.requiresCodebaseMcp).toBe(true);
		expect(contract.policy.requiresSubagentDelegation).toBe(true);

		// Summary sections extracted
		expect(contract.summary.goal).toBeDefined();
		expect(contract.summary.goal).toContain("用户注册");
		expect(contract.summary.scope.length).toBeGreaterThan(0);
		expect(contract.summary.files.length).toBeGreaterThan(0);
		expect(contract.summary.tests.length).toBeGreaterThan(0);
		expect(contract.summary.verification.length).toBeGreaterThan(0);
		expect(contract.summary.completionCriteria.length).toBeGreaterThan(0);

		// Path normalised relative to repo root
		expect(contract.tddPath).toContain("fixtures/contracts/code-task.md");
		expect(contract.tddPath.startsWith("/")).toBe(false);
	});

	it("loads a non-code exempt TDD with overridden policy", () => {
		const contract = loadComplianceContract(fixturePath("non-code-exempt.md"), repoRoot);

		expect(contract.taskId).toBe("non-code-exempt");
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.summaryStatus).toBe("complete");

		// Non-code policy from metadata
		expect(contract.policy.taskKind).toBe("non_code");
		expect(contract.policy.requiresCodebaseMcp).toBe(false);
		expect(contract.policy.requiresSubagentDelegation).toBe(false);
	});

	it("loads unstructured markdown with incomplete summary", () => {
		const contract = loadComplianceContract(fixturePath("unstructured.md"), repoRoot);

		expect(contract.taskId).toBe("unstructured");
		expect(contract.contractHash).toMatch(/^sha256:[a-f0-9]{64}$/);

		// No structured sections → incomplete summary
		expect(contract.summaryStatus).toBe("incomplete");

		// Source text is always preserved
		expect(contract.sourceText.length).toBeGreaterThan(0);

		// Default policy for unclassified content
		expect(contract.policy.taskKind).toBe("code");
	});

	it("rejects a file outside the repo root (absolute path escape)", () => {
		expect(() => {
			loadComplianceContract("/etc/passwd", repoRoot);
		}).toThrow(ContractLoadError);
	});

	it("rejects a non-existent file", () => {
		expect(() => {
			loadComplianceContract(fixturePath("does-not-exist.md"), repoRoot);
		}).toThrow(ContractLoadError);
	});

	it("rejects a symlink that escapes the repo root", () => {
		const symlinkPath = fixturePath("escape-link.md");
		try {
			// Create a symlink pointing outside the repo root
			try {
				if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
			} catch {
				// ignore
			}
			// Use absolute path outside repo
			writeFileSync("/tmp/omp-escape-test.md", "# escape");
			try {
				Bun.spawnSync(["ln", "-s", "/tmp/omp-escape-test.md", symlinkPath]);
			} catch {
				// macOS might need different approach
			}

			expect(() => {
				loadComplianceContract(symlinkPath, repoRoot);
			}).toThrow(ContractLoadError);
		} finally {
			try {
				if (existsSync(symlinkPath)) unlinkSync(symlinkPath);
			} catch {
				// ignore
			}
			try {
				unlinkSync("/tmp/omp-escape-test.md");
			} catch {
				// ignore
			}
		}
	});

	it("rejects a file when realpathSync fails (broken symlink)", () => {
		const brokenLinkPath = fixturePath("broken-link.md");
		try {
			try {
				if (existsSync(brokenLinkPath)) unlinkSync(brokenLinkPath);
			} catch {
				// ignore
			}
			// Create a symlink pointing to a non-existent target.
			// existsSync returns true (the symlink node exists),
			// but realpathSync throws ENOENT.
			Bun.spawnSync(["ln", "-s", "/tmp/omp-nonexistent-target.md", brokenLinkPath]);

			expect(() => {
				loadComplianceContract(brokenLinkPath, repoRoot);
			}).toThrow(ContractLoadError);
		} finally {
			try {
				if (existsSync(brokenLinkPath)) unlinkSync(brokenLinkPath);
			} catch {
				// ignore
			}
		}
	});
});

describe("compareContractRevision", () => {
	it("returns no change when comparing identical contracts", () => {
		const contract = loadComplianceContract(fixturePath("code-task.md"), repoRoot);
		const change = compareContractRevision(contract, contract);

		expect(change.contentChanged).toBe(false);
		expect(change.oldHash).toBe(change.newHash);
		expect(change.changedSections).toHaveLength(0);
	});

	it("detects differences between two distinct contracts", () => {
		const code = loadComplianceContract(fixturePath("code-task.md"), repoRoot);
		const nonCode = loadComplianceContract(fixturePath("non-code-exempt.md"), repoRoot);

		// Re-use same reference for comparison
		const change = compareContractRevision(code, nonCode);

		expect(change.contentChanged).toBe(true);
		expect(change.oldHash).not.toBe(change.newHash);
		expect(change.changedSections.length).toBeGreaterThan(0);
		expect(change.changeSummary.length).toBeGreaterThan(0);
	});

	it("detects content change after modifying the fixture file", () => {
		const target = fixturePath("code-task.md");
		const original = loadComplianceContract(target, repoRoot);

		// Append a comment to the fixture (will be reverted)
		const originalContent = original.sourceText;
		const modifiedContent = `${originalContent}\n<!-- modified -->\n`;

		try {
			writeFileSync(target, modifiedContent, "utf-8");

			const modified = loadComplianceContract(target, repoRoot);
			const change = compareContractRevision(original, modified);

			expect(change.contentChanged).toBe(true);
			expect(change.oldHash).not.toBe(change.newHash);
		} finally {
			// Restore original content
			writeFileSync(target, originalContent, "utf-8");
		}
	});
});
