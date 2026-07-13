import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import type { AdvisorBeforeRunEvent } from "../../src/types";

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
	// ── BUG-1: brainstorm dead on compliance_review trigger ───────────

	it("brainstorm hook matches on compliance_review trigger (BUG: returns undefined)", () => {
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

		// upstream ALWAYS sends trigger: "compliance_review"
		const event: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			sessionId: "s1",
			advisorId: "a1",
			trigger: "compliance_review",
			messages: [],
			metadata: { reviewId },
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
			sessionId: "s1",
			advisorId: "a1",
			trigger: "turn_end",
			messages: [],
			metadata: { reviewId: envelope.reviewId, taskId: "task-1", contractHash: "sha256:abc", attempt: 1 },
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
			sessionId: "s1",
			advisorId: "a1",
			trigger: "turn_end",
			messages: [],
			metadata: { reviewId: "br-turnend" },
		};

		// BUG-1 fix changes only the trigger gate, not turn_end behavior
		expect(hook(event)).toBeUndefined();
	});
});
