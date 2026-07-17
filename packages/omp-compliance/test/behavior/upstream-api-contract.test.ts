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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import activate from "../../src/extension";
import type { AdvisorBeforeRunEvent } from "../../src/types";
import { FakeExtensionAPI } from "../support/fake-extension-api";

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
		it("declares the v17 peer window and pins the development host commit", () => {
			const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
				peerDependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				ompCustom?: { hostSource?: string; hostCommit?: string };
			};

			expect(packageJson.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(">=17.0.1 <18");
			expect(packageJson.devDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe("link:@oh-my-pi/pi-coding-agent");
			expect(packageJson.ompCustom?.hostSource).toBe(
				"/Users/mima1234/Code/super/.worktrees/oh-my-pi-v17-advisor-protocol",
			);
			expect(packageJson.ompCustom?.hostCommit).toBe("2adbf91f6d73534342f194f99b1a305db37ae1cf");
			expect(
				execFileSync("git", ["-C", packageJson.ompCustom?.hostSource ?? "", "rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
			).toBe(packageJson.ompCustom?.hostCommit);
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

		it("does not copy v16 Extension API types into the compliance package", () => {
			const source = readFileSync(join(import.meta.dir, "../../src/types.ts"), "utf8");
			for (const copiedType of [
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
				expect(source).not.toMatch(new RegExp(`export\\s+(?:interface|type)\\s+${copiedType}\\b`));
			}
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
