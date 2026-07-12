import { describe, expect, it, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { buildCompletionSnapshot } from "../../src/runtime/completion-gate";
import type { ExtensionAPI } from "../../src/types";
import type { ComplianceVerdict } from "../../src/state/types";

// ─── Minimal Fake API for runtime tests ─────────────────────────────

class MinimalAPI implements ExtensionAPI {
	public sentMessages: unknown[] = [];
	public entries: Array<{ type: string; data?: unknown }> = [];

	registerTool(): void {}
	registerCommand(): void {}
	on(): void {}

	sendMessage(
		message: unknown,
		_options?: { triggerTurn?: boolean; deliverAs?: string },
	): void {
		this.sentMessages.push(message);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: customType, data });
	}

	logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ─── Test Setup ─────────────────────────────────────────────────────

let tmpDir: string;
let api: MinimalAPI;
let store: EvidenceStore;
let collector: CollectorRuntime;
let runtime: ComplianceRuntime;

function validVerdict(opts: {
	status: "pass" | "remediation_required";
	summary?: string;
	requiredFixes?: string[];
}): ComplianceVerdict {
	return {
		status: opts.status,
		summary: opts.summary,
		requiredFixes: opts.requiredFixes,
		schemaValid: true,
	};
}

function finding(requiredFix: string): string {
	return requiredFix;
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `omp-runtime-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });

	// Write a minimal TDD file
	writeFileSync(
		join(tmpDir, "tdd.md"),
		[
			"# Goal: Build feature",
			"",
			"## Scope",
			"- core module",
			"",
			"## Files",
			"- src/index.ts",
			"",
			"## Tests",
			"- bun test",
			"",
			"## Verification",
			"- biome check",
			"",
			"## Completion",
			"- all passing",
			"",
		].join("\n"),
		"utf-8",
	);

	const evidenceDir = join(tmpDir, ".omp", "evidence");
	mkdirSync(evidenceDir, { recursive: true });

	api = new MinimalAPI();
	store = new EvidenceStore(evidenceDir);
	collector = new CollectorRuntime();
	runtime = new ComplianceRuntime(store, collector, api, tmpDir);
});

// ─── Tests: Start ───────────────────────────────────────────────────

describe("ComplianceRuntime — start", () => {
	it("should start a managed code task and return task id", async () => {
		const result = await runtime.start("tdd.md");
		expect(result.taskId).toBeDefined();
		expect(result.taskId.length).toBeGreaterThan(0);
		expect(result.status).toBe("active");
	});

	it("should write active evidence record on start", async () => {
		const { taskId } = await runtime.start("tdd.md");
		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "active")).toBe(true);
	});

	it("should send compliance_managed message on start", async () => {
		await runtime.start("tdd.md");
		expect(api.sentMessages.length).toBeGreaterThan(0);
	});

	it("should throw when starting a second task while one is active", async () => {
		await runtime.start("tdd.md");
		expect(runtime.start("tdd.md")).rejects.toThrow("already active");
	});
});

// ─── Tests: Stop ────────────────────────────────────────────────────

describe("ComplianceRuntime — stop", () => {
	it("should stop an active task and record stopped event", async () => {
		const { taskId } = await runtime.start("tdd.md");
		const result = await runtime.stop();
		expect(result.stopped).toBe(true);
		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "stopped")).toBe(true);
	});

	it("should return false when no task is active", async () => {
		const result = await runtime.stop();
		expect(result.stopped).toBe(false);
	});
});

// ─── Tests: Resume ──────────────────────────────────────────────────

describe("ComplianceRuntime — resume", () => {
	it("should throw when no stalled task matches the given id", async () => {
		expect(runtime.resume("non-existent")).rejects.toThrow("No stalled task");
	});

	it("should throw when task is not stalled", async () => {
		const { taskId } = await runtime.start("tdd.md");
		expect(runtime.resume(taskId)).rejects.toThrow("not stalled");
	});
});

// ─── Tests: Request Completion ──────────────────────────────────────

describe("ComplianceRuntime — requestCompletion", () => {
	it("完成请求只进入 advisor_reviewing，不会自行通过", async () => {
		await runtime.start("tdd.md");
		runtime.recordVerification({ command: "bun test", exitCode: 0 });
		const result = await runtime.requestCompletion({ summary: "已完成" });

		expect(result.status).toBe("advisor_reviewing");
		expect(result.completionSnapshot).toBeDefined();
		expect(result.completionSnapshot.codebaseMemory).toBeDefined();
		expect(result.completionSnapshot.verifications).toBeDefined();
	});

	it("should throw when no task is active", async () => {
		expect(
			runtime.requestCompletion({ summary: "Done" }),
		).rejects.toThrow("No active compliance task");
	});

	it("should throw when task is not in active status", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		expect(
			runtime.requestCompletion({ summary: "Again" }),
		).rejects.toThrow("Cannot request completion");
	});

	it("should include agent claim params in the snapshot", async () => {
		await runtime.start("tdd.md");
		const result = await runtime.requestCompletion({
			summary: "Completed feature X",
			claimedVerification: ["test passes", "lint clean"],
		});

		expect(result.completionSnapshot.agentClaim.summary).toBe("Completed feature X");
		expect(result.completionSnapshot.agentClaim.claimedVerification).toEqual([
			"test passes",
			"lint clean",
		]);
	});
});

// ─── Tests: Accept Verdict (Pass) ───────────────────────────────────

describe("ComplianceRuntime — acceptVerdict (pass)", () => {
	it("should transition to completed on pass verdict", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(validVerdict({ status: "pass", summary: "All good" }));

		expect(runtime.currentTaskState?.status).toBe("completed");
	});

	it("should write completed evidence record", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(validVerdict({ status: "pass", summary: "OK" }));

		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "completed")).toBe(true);
	});

	it("should not inject remediation message on pass", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;
		await runtime.acceptVerdict(validVerdict({ status: "pass", summary: "OK" }));

		// No new messages should be sent for pass verdict
		expect(api.sentMessages.length).toBe(beforeCount);
	});
});

// ─── Tests: Accept Verdict (Remediation) ────────────────────────────

describe("ComplianceRuntime — acceptVerdict (remediation)", () => {
	it("remediate 自动回送 required_fix，并允许无限次再次完成", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "第一次" });

		await runtime.acceptVerdict(
			validVerdict({
				status: "remediation_required",
				summary: "Needs more testing",
				requiredFixes: [finding("补测试")],
			}),
		);

		// Status should be remediation_required
		expect(runtime.currentTaskState?.status).toBe("remediation_required");

		// The injectRemediation should have sent a message with the required fix
		const hasFixMessage = api.sentMessages.some((m) => {
			if (m && typeof m === "object" && "data" in m) {
				const data = (m as Record<string, unknown>).data as Record<string, unknown>;
				return Array.isArray(data?.findings) &&
					(data.findings as Array<{ requiredFix: string }>).some(
						(f: { requiredFix: string }) => f.requiredFix === "补测试",
					);
			}
			return false;
		});
		expect(hasFixMessage).toBe(true);

		// resumeAfterRemediation should return "active"
		const status = runtime.resumeAfterRemediation();
		expect(status).toBe("active");
	});

	it("should not inject remediation when requiredFixes is empty", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;
		await runtime.acceptVerdict(
			validVerdict({ status: "remediation_required", requiredFixes: [] }),
		);

		// No new messages for empty fixes
		expect(api.sentMessages.length).toBe(beforeCount);
	});

	it("should not inject when verdict schema is invalid", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		const beforeCount = api.sentMessages.length;
		await runtime.acceptVerdict({
			status: "remediation_required",
			summary: "Fix needed",
			requiredFixes: ["do something"],
			schemaValid: false,
		});

		// No injection for invalid schema — stays in advisor_reviewing
		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
		expect(api.sentMessages.length).toBe(beforeCount);
	});

	it("should write remediation evidence on remediation verdict", async () => {
		const { taskId } = await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		await runtime.acceptVerdict(
			validVerdict({
				status: "remediation_required",
				summary: "Fix issues",
				requiredFixes: ["fix foo", "fix bar"],
			}),
		);

		const evidence = await store.readAll(taskId);
		expect(evidence.some((e) => e.event === "remediation_required")).toBe(true);
	});

	it("should handle unknown verdict status as protocol error", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });

		await runtime.acceptVerdict({
			// @ts-expect-error testing invalid status
			status: "invalid_status",
			schemaValid: true,
		});

		expect(runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});
});

// ─── Tests: resumeAfterRemediation ──────────────────────────────────

describe("ComplianceRuntime — resumeAfterRemediation", () => {
	it("should throw when no task is active", () => {
		expect(() => runtime.resumeAfterRemediation()).toThrow("No active compliance task");
	});

	it("should throw when task is not remediation_required", async () => {
		await runtime.start("tdd.md");
		expect(() => runtime.resumeAfterRemediation()).toThrow("Cannot resume from status");
	});

	it("should increment attempt on resume", async () => {
		await runtime.start("tdd.md");
		await runtime.requestCompletion({ summary: "Done" });
		await runtime.acceptVerdict(
			validVerdict({
				status: "remediation_required",
				requiredFixes: ["fix it"],
			}),
		);

		const attemptBefore = runtime.currentTaskState!.attempt;
		runtime.resumeAfterRemediation();
		expect(runtime.currentTaskState!.attempt).toBe(attemptBefore + 1);
	});
});
