import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplianceReviewRegistry } from "../src/advisor/review-envelope";
import { EvidenceStore } from "../src/evidence/evidence-store";
import { ComplianceRuntime } from "../src/runtime/compliance-runtime";
import { CollectorRuntime } from "../src/signals/collector-runtime";
import type { AdvisorReviewReceipt, AdvisorReviewRequest, ExtensionAPI } from "../src/types";
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
		activate(api.toAPI() as unknown as ExtensionAPI);

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(false);
	});

	it("start 后 .omp/compliance 目录和 task state 存在", async () => {
		// Write fixture into temp dir
		writeFileSync(join(tmpDir, "tdd.md"), TDD_FIXTURE, "utf-8");

		const store = new EvidenceStore(join(tmpDir, ".omp/compliance"));
		const collector = new CollectorRuntime();
		const api = new FakeExtensionAPI();
		const registry = new ComplianceReviewRegistry();
		const runtime = new ComplianceRuntime(() => store, collector, api.toAPI() as unknown as ExtensionAPI, tmpDir, {
			sessionId: () => "test-session",
			registry,
			requestAdvisorReview: (_req: AdvisorReviewRequest) =>
				Promise.resolve<AdvisorReviewReceipt>({ reviewId: "test-review", status: "accepted" }),
		});

		// start task — should create directory
		const { taskId, status } = await runtime.start("tdd.md");

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(true);
		expect(taskId).toBeTruthy();
		expect(status).toBe("active");
	});
});
