import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
/**
 * Upstream API Contract Test.
 *
 * Proves bugs revealed by the REAL upstream OMP v16.4.x shapes.
 *
 * BUG: brainstorm hook gates on event.trigger === "brainstorm_review"
 *      (brainstorm/advisor-hook.ts:43) but upstream agent-session.ts:16259
 *      ALWAYS sends trigger: "compliance_review" for extension-initiated
 *      reviews. The hook silently no-ops and the envelope is stranded.
 *
 * BUG: requestAdvisorReview receipt uses { status } (upstream v16.4.x
 *      extensibility/extensions/types.ts:918-921) but brainstorm-runtime.ts
 *      and compliance-runtime.ts check .accepted boolean.
 *
 * Each test expects the CORRECT behavior (hook returns result, receipt
 * accepted). Current code returns undefined → test fails RED.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdvisorBeforeRunEvent } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import activate from "../../src/extension";
import { FakeExtensionAPI } from "../support/fake-extension-api";

const HOST_PACKAGE = "/Users/mima1234/Code/super/.worktrees/oh-my-pi-v17-advisor-protocol/packages/coding-agent";
const HOST_HEAD = "2adbf91f6d73534342f194f99b1a305db37ae1cf";

const tmpDir = mkdtempSync(join(tmpdir(), "omp-contract-"));
const store = new TopicStore(tmpDir);
const coordinator = new TopicCoordinator(store);

afterAll(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe("upstream API contract — REAL shapes", () => {
	describe("OMP v17 extension contract", () => {
		it("resolves the v17 development dependency from the pinned Host worktree", () => {
			const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
				peerDependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};

			expect(packageJson.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(">=17.0.1 <18");
			expect(packageJson.devDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(`file:${HOST_PACKAGE}`);

			const resolvedPackageJson = realpathSync(
				fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/package.json")),
			);
			expect(readFileSync(resolvedPackageJson, "utf8")).toBe(readFileSync(join(HOST_PACKAGE, "package.json"), "utf8"));
			const resolvedTypes = join(dirname(resolvedPackageJson), "src/extensibility/extensions/types.ts");
			expect(readFileSync(resolvedTypes, "utf8")).toBe(
				readFileSync(join(HOST_PACKAGE, "src/extensibility/extensions/types.ts"), "utf8"),
			);
			const lockfile = readFileSync(join(import.meta.dir, "../../../../bun.lock"), "utf8");
			expect(lockfile).toContain(
				"@oh-my-pi/pi-coding-agent@file:../oh-my-pi-v17-advisor-protocol/packages/coding-agent",
			);
			expect(
				execFileSync("git", ["-C", HOST_PACKAGE, "rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
			).toBe(HOST_HEAD);
		});

		it("registers all public tools with the v17 execute contract", () => {
			const fake = new FakeExtensionAPI();
			activate(fake.toAPI());

			for (const name of ["compliance_complete", "brainstorm_topic_ready", "brainstorm_decision"]) {
				const tool = fake.toolDefinitions.find((candidate) => candidate.name === name);
				expect(tool, `${name} must be registered`).toBeDefined();
				expect(typeof tool?.label).toBe("string");
				expect(tool?.label.length).toBeGreaterThan(0);
				expect(tool?.loadMode).toBe("essential");
				expect(tool?.approval).toBe("write");
				expect(typeof tool?.execute).toBe("function");
				expect("handler" in (tool as unknown as Record<string, unknown>)).toBe(false);
			}
		});

		it("does not re-export or alias Host protocol types", () => {
			const typesPath = join(import.meta.dir, "../../src/types.ts");
			const typesSource = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
			const indexSource = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");
			for (const hostType of [
				"ExtensionAPI",
				"ExtensionContext",
				"ExtensionHandler",
				"ToolDefinition",
				"RegisteredCommand",
				"AgentTool",
				"AgentToolResult",
				"AdvisorBeforeRunEvent",
				"AdvisorBeforeRunResult",
				"AdvisorReviewRequest",
				"AdvisorReviewReceipt",
			]) {
				expect(typesSource).not.toMatch(new RegExp(`\\b${hostType}\\b`));
				expect(indexSource).not.toMatch(new RegExp(`\\b${hostType}\\b`));
			}
			expect(indexSource).not.toContain('from "./types"');
		});

		it("keeps the Fake and event bridge free of double-assertion signature escapes", () => {
			const fakeSource = readFileSync(join(import.meta.dir, "../support/fake-extension-api.ts"), "utf8");
			const extensionSource = readFileSync(join(import.meta.dir, "../../src/extension.ts"), "utf8");

			expect(fakeSource).not.toMatch(/as\s+unknown\s+as/);
			expect(extensionSource).not.toMatch(/as\s+unknown\s+as/);
			expect(fakeSource).toContain('handler: RegisteredCommand["handler"]');
		});
	});

	// ── Brainstorm uses its dedicated v17 trigger ─────────────────────

	it("brainstorm hook matches on brainstorm_review trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const hook = createBrainstormAdvisorHook(registry, coordinator, () => {});

		// Pre-register an envelope so registry.get(reviewId) would succeed
		const reviewId = "br-contract-test";
		registry.put({
			reviewId,
			topicId: "topic-1",
			inputHash: "sha256:abc" as const,
			context: "<c/>",
			rules: "r",
			requestedToolNames: [],
			createdAt: new Date().toISOString(),
		});

		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			metadata: { reviewId },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		// EXPECT: hook matches and returns context/tools
		// BUG: current code gates on !== "brainstorm_review" → returns undefined
		const result = hook(event);
		expect(result).toBeDefined();
		expect(result?.additionalSystemContext).toBeDefined();
		expect(result?.additionalTools).toHaveLength(1);
	});

	// ── No-regression: turn_end must not match ─────────────────────

	it("compliance hook returns undefined on turn_end trigger", () => {
		const registry = new ComplianceReviewRegistry();
		const hook = createComplianceAdvisorHook(registry, {
			acceptVerdict: () => Promise.resolve({ accepted: true }),
		});

		const envelope = createEnvelope({
			sessionId: "s1",
			taskId: "task-1",
			contractHash: "sha256:abc" as const,
			attempt: 1,
			context: "<c/>",
			rules: "r",
		});
		registry.put(envelope);

		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId: envelope.reviewId,
			trigger: "turn_end",
			priority: 100,
			metadata: { reviewId: envelope.reviewId, taskId: "task-1", contractHash: "sha256:abc", attempt: 1 },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		expect(hook(event)).toBeUndefined();
	});

	it("brainstorm hook returns undefined on turn_end trigger", () => {
		const registry = new BrainstormReviewRegistry();
		const hook = createBrainstormAdvisorHook(registry, coordinator, () => {});

		registry.put({
			reviewId: "br-turnend",
			topicId: "t-1",
			inputHash: "sha256:abc" as const,
			context: "<c/>",
			rules: "r",
			requestedToolNames: [],
			createdAt: new Date().toISOString(),
		});

		// After BUG-1 fix (gate becomes === "compliance_review"),
		// this must still return undefined for turn_end
		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId: "br-turnend",
			trigger: "turn_end",
			priority: 80,
			metadata: { reviewId: "br-turnend" },
			primarySessionId: "s1",
			advisorSessionId: "a1",
		};

		// BUG-1 fix changes only the trigger gate, not turn_end behavior
		expect(hook(event)).toBeUndefined();
	});
});
