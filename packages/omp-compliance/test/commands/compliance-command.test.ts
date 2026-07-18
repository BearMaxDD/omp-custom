import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import type { RegisteredCommand } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { ComplianceReviewDependencies } from "../../src/advisor/review-envelope";
import { registerComplianceCommand } from "../../src/commands/compliance-command";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import { createStrictRuntimeDependencies } from "../support/strict-runtime-dependencies";

// ─── Fake ExtensionAPI for command testing ──────────────────────────

class FakeCommandAPI {
	public readonly sentMessages: unknown[] = [];
	public readonly entries: Array<{ type: string; data?: unknown }> = [];
	public readonly logs: string[] = [];
	public registeredCommands: Array<{ name: string; handler: (args: string[]) => Promise<void> }> = [];

	registerTool(): void {
		// no-op for command test
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.registeredCommands.push({
			name,
			handler: (args) => options.handler(args.join(" "), {} as Parameters<RegisteredCommand["handler"]>[1]),
		});
	}

	on(): void {
		// no-op
	}

	sendMessage(message: unknown, _options?: { triggerTurn?: boolean; deliverAs?: string }): void {
		this.sentMessages.push(message);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ type: customType, data });
	}
	requestAdvisorReview = (_request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> =>
		Promise.resolve({ status: "accepted" as const, reviewId: "test-review" });
	logger = {
		info: (msg: string) => {
			this.logs.push(msg);
		},
		warn: () => {},
		error: () => {},
		debug: () => {},
	};

	toAPI(): FakeCommandAPI {
		return this;
	}
}

// ─── Test Fixture ───────────────────────────────────────────────────

let tmpDir: string;
let api: FakeCommandAPI;
let runtime: ComplianceRuntime;
let store: EvidenceStore;
let collector: CollectorRuntime;

beforeEach(() => {
	// Create a temp workspace for each test
	tmpDir = join(tmpdir(), `omp-compliance-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });

	// Create a minimal TDD file
	const tddContent = [
		"# Test Goal: Build feature",
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
	].join("\n");
	writeFileSync(join(tmpDir, "tdd.md"), tddContent, "utf-8");
	Bun.spawnSync(["git", "init"], { cwd: tmpDir });
	Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: tmpDir });
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tmpDir });
	Bun.spawnSync(["git", "add", "tdd.md"], { cwd: tmpDir });
	Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: tmpDir });

	// Set up clean infra
	const evidenceDir = join(tmpDir, ".omp", "evidence");
	mkdirSync(evidenceDir, { recursive: true });

	api = new FakeCommandAPI();
	store = new EvidenceStore(evidenceDir);
	collector = new CollectorRuntime();
	const registry = new ComplianceReviewRegistry();
	const reviewDeps: ComplianceReviewDependencies = {
		sessionId: () => "test-session",
		registry,
		requestAdvisorReview: (_req: AdvisorReviewRequest) =>
			Promise.resolve({ status: "accepted" as const, reviewId: "test-review" }),
	};
	runtime = new ComplianceRuntime(
		() => store,
		collector,
		api.toAPI(),
		tmpDir,
		reviewDeps,
		createStrictRuntimeDependencies({
			repoRoot: tmpDir,
			store,
			requestAdvisorReview: (request) => reviewDeps.requestAdvisorReview(request),
		}),
	);

	registerComplianceCommand(api.toAPI(), runtime);
});

// ─── Test Helper ────────────────────────────────────────────────────

function getCmd(): { name: string; handler: (args: string[]) => Promise<void> } {
	const cmd = api.registeredCommands.find((c) => c.name === "compliance");
	if (!cmd) throw new Error("compliance command not found");
	return cmd;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ComplianceCommand — /compliance start", () => {
	it("should start a new compliance task with active status", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		// Check runtime state
		const taskState = runtime.currentTaskState;
		expect(taskState).not.toBeNull();
		expect(taskState?.status).toBe("active");
		expect(taskState?.taskId.length).toBeGreaterThan(0);

		// Verify evidence was written
		const evidence = await store.readAll(taskState?.taskId);
		expect(evidence.length).toBeGreaterThan(0);
		expect(evidence.some((e) => e.event === "active")).toBe(true);

		// Verify message was sent
		expect(api.sentMessages.length).toBeGreaterThan(0);
	});

	it("should throw when no tdd path provided", async () => {
		const cmd = getCmd();
		expect(cmd.handler(["start"])).rejects.toThrow("tdd.md");
	});

	it("should throw error for unknown subcommand", async () => {
		const cmd = getCmd();
		expect(cmd.handler(["unknown"])).rejects.toThrow("Unknown subcommand");
	});
});

describe("ComplianceCommand — /compliance stop", () => {
	it("should stop an active compliance task", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		await cmd.handler(["stop"]);

		// Runtime state should be cleared
		expect(runtime.currentTaskState).toBeNull();
		expect(api.logs.some((l) => l.includes("stopped"))).toBe(true);
	});

	it("should handle stop when no task is active", async () => {
		const cmd = getCmd();
		await cmd.handler(["stop"]);

		expect(runtime.currentTaskState).toBeNull();
		expect(api.logs.some((l) => l.includes("No active"))).toBe(true);
	});
});

describe("ComplianceCommand — /compliance resume", () => {
	it("should throw for resume without task id", async () => {
		const cmd = getCmd();
		expect(cmd.handler(["resume"])).rejects.toThrow("Usage");
	});

	it("should throw resume for non-stalled task", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		const taskId = runtime.currentTaskState?.taskId;
		// Can't resume an active task
		expect(cmd.handler(["resume", taskId])).rejects.toThrow("not stalled");
	});
});

// ─── Tests: Status ──────────────────────────────────────────────────

describe("ComplianceCommand — /compliance status", () => {
	it("shows status for active task", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		await cmd.handler(["status"]);

		expect(api.logs.some((l) => l.includes("Status: active"))).toBe(true);
		expect(api.logs.some((l) => l.includes("TDD path"))).toBe(true);
		expect(api.logs.some((l) => l.includes("Contract hash"))).toBe(true);
		expect(api.logs.some((l) => l.includes("Attempt"))).toBe(true);
		expect(api.logs.some((l) => l.includes("Advisor available"))).toBe(true);
	});

	it("reports no task when no task is active", async () => {
		const cmd = getCmd();
		await cmd.handler(["status"]);

		expect(api.logs.some((l) => l.includes("No active compliance task"))).toBe(true);
	});

	it("does not mutate task state", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		const stateBefore = runtime.currentTaskState;
		await cmd.handler(["status"]);
		const stateAfter = runtime.currentTaskState;

		expect(stateAfter).toEqual(stateBefore);
	});
});

// ─── Tests: History ─────────────────────────────────────────────────

describe("ComplianceCommand — /compliance history", () => {
	it("shows history for active task", async () => {
		const cmd = getCmd();
		await cmd.handler(["start", "tdd.md"]);

		await cmd.handler(["history"]);

		expect(api.logs.some((l) => l.includes("active"))).toBe(true);
	});

	it("reports no history when no task is active", async () => {
		const cmd = getCmd();
		await cmd.handler(["history"]);

		expect(api.logs.some((l) => l.includes("No active compliance task"))).toBe(true);
	});
});
