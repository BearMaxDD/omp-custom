import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import type { ComplianceReviewEnvelope } from "../../src/advisor/review-envelope";
import type { ComplianceRuntime } from "../../src/runtime/compliance-runtime";
import type { AdvisorBeforeRunEvent, AdvisorBeforeRunResult } from "../../src/types";

// ─── Helpers ────────────────────────────────────────────────────────

const HASH = "sha256:abc123def456" as const;
const SESSION_ID = "session-1";
const TASK_ID = "task-9";

function makeMockRuntime(): ComplianceRuntime {
	// We only need acceptVerdict — create a proxy or minimal mock
	const mock = { acceptVerdict: () => Promise.resolve({ accepted: true as const }) } as unknown as ComplianceRuntime;
	return mock;
}

function makeComplianceEvent(overrides: Partial<AdvisorBeforeRunEvent> = {}): AdvisorBeforeRunEvent {
	return {
		type: "advisor_before_run",
		sessionId: SESSION_ID,
		advisorId: "default",
		trigger: "compliance_review",
		messages: [],
		metadata: {
			reviewId: `compliance:${"0".repeat(64)}`,
			taskId: TASK_ID,
			contractHash: HASH,
			attempt: 1,
		},
		...overrides,
	};
}

function makeTurnEndEvent(): AdvisorBeforeRunEvent {
	return {
		type: "advisor_before_run",
		sessionId: SESSION_ID,
		advisorId: "default",
		trigger: "turn_end",
		messages: [],
	};
}

function setupFixture(overrides: Partial<{ runtime: ComplianceRuntime; sessionId: string; taskId: string }> = {}) {
	const registry = new ComplianceReviewRegistry();
	const runtime = overrides.runtime ?? makeMockRuntime();
	const env = createEnvelope({
		sessionId: overrides.sessionId ?? SESSION_ID,
		taskId: overrides.taskId ?? TASK_ID,
		contractHash: HASH,
		attempt: 1,
		context: "test-context",
		rules: "test-rules",
	});
	registry.put(env);
	const hook = createComplianceAdvisorHook(registry, runtime);
	return { registry, runtime, env, hook };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("createComplianceAdvisorHook", () => {
	it("returns undefined for a regular turn_end event", () => {
		const { hook } = setupFixture();
		const result = hook(makeTurnEndEvent());
		expect(result).toBeUndefined();
	});

	it("returns undefined when metadata does not match any envelope", () => {
		const { hook } = setupFixture();
		const event = makeComplianceEvent({
			metadata: { reviewId: "compliance:nonexistent", taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const result = hook(event);
		expect(result).toBeUndefined();
	});

	it("returns undefined when metadata.reviewId is missing", () => {
		const { hook } = setupFixture();
		const event = makeComplianceEvent({
			metadata: { taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const result = hook(event);
		expect(result).toBeUndefined();
	});

	it("returns additionalSystemContext and a single tool when matched", () => {
		const { hook, env } = setupFixture();
		const event = makeComplianceEvent({
			metadata: {
				reviewId: env.reviewId,
				taskId: TASK_ID,
				contractHash: HASH,
				attempt: 1,
			},
		});
		const result = hook(event);
		expect(result).toBeDefined();
		expect(result?.additionalSystemContext).toEqual(["test-rules", "test-context"]);
		expect(Object.isFrozen(result?.additionalSystemContext)).toBe(true);
		expect(result?.additionalTools).toHaveLength(1);
		expect(result?.additionalTools?.[0]?.name).toBe("compliance_verdict");
		expect(result?.additionalTools?.[0]?.label).toBe("Compliance Verdict");
		expect(typeof result?.additionalTools?.[0]?.execute).toBe("function");
		expect(Object.isFrozen(result?.additionalTools)).toBe(true);
		expect(result?.metadata).toEqual({ complianceReviewId: env.reviewId });
		expect(Object.isFrozen(result?.metadata)).toBe(true);
	});

	it("the compliance_verdict tool calls runtime.acceptVerdict on valid submission", async () => {
		const runtime = makeMockRuntime();
		const acceptSpy = spyOn(runtime, "acceptVerdict").mockImplementation(() => Promise.resolve({ accepted: true }));
		const { hook, env, registry } = setupFixture({ runtime });

		const event = makeComplianceEvent({
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		// Submit a valid verdict
		const verdict = {
			schema_version: 1,
			task_id: TASK_ID,
			contract_hash: HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};
		const toolResult = await tool.execute("call-1", verdict);

		expect(acceptSpy).toHaveBeenCalledTimes(1);
		expect(acceptSpy).toHaveBeenCalledWith(verdict);
		// Envelope should be consumed after successful processing
		expect(registry.get(env.reviewId)).toBeUndefined();
		expect(toolResult.content[0]).toEqual({ type: "text", text: "Compliance verdict accepted." });
	});

	it("keeps the envelope when runtime rejects the verdict", async () => {
		const runtime = makeMockRuntime();
		spyOn(runtime, "acceptVerdict").mockImplementation(() =>
			Promise.resolve({ accepted: false, reason: "schema validation failed" }),
		);
		const { hook, env, registry } = setupFixture({ runtime });
		const result = hook(
			makeComplianceEvent({
				metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
			}),
		) as AdvisorBeforeRunResult;
		const tool = result.additionalTools?.[0];
		const toolResult = await tool.execute("call-rejected", {
			schema_version: 1,
			task_id: TASK_ID,
			contract_hash: HASH,
			attempt: 1,
			status: "invalid",
			findings: [],
		});
		expect(registry.get(env.reviewId)).toBe(env);
		expect(toolResult.content[0]).toEqual({ type: "text", text: "Verdict rejected: schema validation failed" });
		expect(toolResult.isError).toBe(true);
	});

	it("does NOT call acceptVerdict when the verdict attempt does not match the envelope", async () => {
		const runtime = makeMockRuntime();
		const acceptSpy = spyOn(runtime, "acceptVerdict").mockImplementation(() => Promise.resolve({ accepted: true }));
		const { hook, env } = setupFixture({ runtime });

		const event = makeComplianceEvent({
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			task_id: TASK_ID,
			contract_hash: HASH,
			attempt: 99, // mismatch!
			status: "pass",
			findings: [],
		};

		await expect(tool.execute("call-2", verdict)).rejects.toThrow();
		expect(acceptSpy).not.toHaveBeenCalled();
	});

	it("does NOT call acceptVerdict when task_id does not match the envelope", async () => {
		const runtime = makeMockRuntime();
		const acceptSpy = spyOn(runtime, "acceptVerdict").mockImplementation(() => Promise.resolve({ accepted: true }));
		const { hook, env } = setupFixture({ runtime });

		const event = makeComplianceEvent({
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			task_id: "wrong-task",
			contract_hash: HASH,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		await expect(tool.execute("call-3", verdict)).rejects.toThrow();
		expect(acceptSpy).not.toHaveBeenCalled();
	});

	it("does NOT call acceptVerdict when contract_hash does not match the envelope", async () => {
		const runtime = makeMockRuntime();
		const acceptSpy = spyOn(runtime, "acceptVerdict").mockImplementation(() => Promise.resolve({ accepted: true }));
		const { hook, env } = setupFixture({ runtime });

		const event = makeComplianceEvent({
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			task_id: TASK_ID,
			contract_hash: "sha256:different" as string,
			attempt: 1,
			status: "pass",
			findings: [],
		};

		await expect(tool.execute("call-4", verdict)).rejects.toThrow();
		expect(acceptSpy).not.toHaveBeenCalled();
	});
});
