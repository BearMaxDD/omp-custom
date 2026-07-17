import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { ComplianceReviewRegistry } from "../src/advisor/review-envelope";
import { EvidenceStore } from "../src/evidence/evidence-store";
import { ComplianceRuntime } from "../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../src/signals/collector-runtime";
import { FakeExtensionAPI } from "./support/fake-extension-api";

/** Minimal TDD fixture for start tests. */
const TDD_FIXTURE = [
	"# Test Contract",
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

describe("extension activate — no lazy file side-effects", () => {
	let tmpDir: string;
	let origCwd: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ext-activate-"));
		origCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(origCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("activate 后不创建 .omp/compliance 目录", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(false);
	});

	it("activate 后不创建 .omp/compliance/brainstorm 目录", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(existsSync(join(tmpDir, ".omp/compliance/brainstorm"))).toBe(false);
	});

	it("activate 后 Brainstorm 工具和命令已注册", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getRegisteredCommands()).toContain("brainstorm");
		expect(api.getRegisteredTools()).toContain("brainstorm_topic_ready");
		expect(api.getRegisteredTools()).toContain("brainstorm_decision");
	});

	it("activate 后 advisor_before_run 已绑定", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getBoundEvents()).toContain("advisor_before_run");
	});

	it("activate 后 before_agent_start 会注入专题自动评审提示", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		expect(api.getBoundEvents()).toContain("before_agent_start");
		const handlers = api.eventHandlers.get("before_agent_start") ?? [];
		const result = (await handlers[0]?.({
			type: "before_agent_start",
			prompt: "讨论一个架构方案",
			systemPrompt: ["base"],
		})) as { systemPrompt?: string[] } | undefined;

		expect(result?.systemPrompt?.[0]).toBe("base");
		expect(result?.systemPrompt?.join("\n")).toContain("brainstorm_topic_ready");
	});

	it("start 后 .omp/compliance 目录和 task state 存在", async () => {
		// Write fixture into temp dir
		writeFileSync(join(tmpDir, "tdd.md"), TDD_FIXTURE, "utf-8");

		const store = new EvidenceStore(join(tmpDir, ".omp/compliance"));
		const collector = new CollectorRuntime();
		const api = new FakeExtensionAPI();
		const registry = new ComplianceReviewRegistry();
		const runtime = new ComplianceRuntime(() => store, collector, api.toAPI(), tmpDir, {
			sessionId: () => "test-session",
			registry,
			requestAdvisorReview: (_req: AdvisorReviewRequest) =>
				Promise.resolve<AdvisorReviewReceipt>({ status: "accepted" as const, reviewId: "test-review" }),
		});

		// start task — should create directory
		const { taskId, status } = await runtime.start("tdd.md");

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(true);
		expect(taskId).toBeTruthy();
		expect(status).toBe("active");
	});
});
