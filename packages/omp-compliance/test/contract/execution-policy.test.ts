import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { extractExecutionPolicy } from "../../src/contract/execution-policy";
import type { ComplianceExecutionPolicy } from "../../src/contract/types";

const fixturesDir = join(__dirname, "..", "fixtures", "contracts");

function loadFixture(name: string): string {
	return Bun.file(join(fixturesDir, name)).text();
}

describe("extractExecutionPolicy", () => {
	it("returns code defaults for structured code-task markdown", async () => {
		const md = await loadFixture("code-task.md");
		const policy = extractExecutionPolicy(md);

		expect(policy.taskKind).toBe("code");
		expect(policy.requiresCodebaseMcp).toBe(true);
		expect(policy.requiresSubagentDelegation).toBe(true);
	});

	it("returns non-code policy for exempt document", async () => {
		const md = await loadFixture("non-code-exempt.md");
		const policy = extractExecutionPolicy(md);

		expect(policy.taskKind).toBe("non_code");
		expect(policy.requiresCodebaseMcp).toBe(false);
		expect(policy.requiresSubagentDelegation).toBe(false);
	});

	it("returns default code policy for unstructured markdown", async () => {
		const md = await loadFixture("unstructured.md");
		const policy = extractExecutionPolicy(md);

		// Even unstructured markdown defaults to code policy
		expect(policy.taskKind).toBe("code");
		expect(policy.requiresCodebaseMcp).toBe(true);
		expect(policy.requiresSubagentDelegation).toBe(true);
	});

	it("returns default code policy for empty content", () => {
		const policy = extractExecutionPolicy("");
		expect(policy.taskKind).toBe("code");
	});

	it("returns default code policy for content without metadata", () => {
		const policy = extractExecutionPolicy("## Some section\n\nJust text");
		expect(policy.taskKind).toBe("code");
	});

	it("parses YAML front matter metadata correctly", () => {
		const md = `---
taskKind: non_code
requiresCodebaseMcp: false
requiresSubagentDelegation: false
---

# Content here
`;
		const policy = extractExecutionPolicy(md);
		expect(policy.taskKind).toBe("non_code");
		expect(policy.requiresCodebaseMcp).toBe(false);
		expect(policy.requiresSubagentDelegation).toBe(false);
	});

	it("is case-insensitive when parsing metadata keys", () => {
		const md = `---
taskkind: non_code
requiresCodebaseMcp: false
requiresSubagentDelegation: false
---
`;
		const policy = extractExecutionPolicy(md);
		expect(policy.taskKind).toBe("non_code");
	});
});
