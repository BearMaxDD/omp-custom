import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
	AdvisorBeforeRunEvent,
	AdvisorRunAugmentation as AdvisorBeforeRunResult,
} from "@oh-my-pi/pi-coding-agent/advisor/index";
import { createComplianceAdvisorHook } from "../../src/advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry, createEnvelope } from "../../src/advisor/review-envelope";
import type { ComplianceReviewEnvelope } from "../../src/advisor/review-envelope";
import type { ComplianceRuntime } from "../../src/runtime/compliance-runtime";

// ─── Helpers ────────────────────────────────────────────────────────

const HASH = "sha256:abc123def456" as const;
const SESSION_ID = "session-1";
const TASK_ID = "task-9";
const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const EVIDENCE_REVISION = `sha256:${"b".repeat(64)}`;
const GIT_HEAD = "c".repeat(40);
const DIFF_HASH = `sha256:${"d".repeat(64)}`;

function makeMockRuntime(): ComplianceRuntime {
	// We only need acceptVerdict — create a proxy or minimal mock
	const mock = { acceptVerdict: () => Promise.resolve({ accepted: true as const }) } as unknown as ComplianceRuntime;
	return mock;
}

function makeComplianceEvent(overrides: Partial<AdvisorBeforeRunEvent> = {}): AdvisorBeforeRunEvent {
	const base: AdvisorBeforeRunEvent = {
		type: "advisor_before_run",
		reviewId: `compliance:${"0".repeat(64)}`,
		trigger: "compliance_review",
		priority: 100,
		metadata: {
			reviewId: `compliance:${"0".repeat(64)}`,
			taskId: TASK_ID,
			contractHash: HASH,
			attempt: 1,
			projectId: PROJECT_ID,
			evidenceRevision: EVIDENCE_REVISION,
			gitHead: GIT_HEAD,
			diffHash: DIFF_HASH,
		},
		primarySessionId: SESSION_ID,
		advisorSessionId: "default",
	};
	return {
		...base,
		...overrides,
		metadata: overrides.metadata ? { ...base.metadata, ...overrides.metadata } : base.metadata,
	};
}

function makeTurnEndEvent(): AdvisorBeforeRunEvent {
	return {
		type: "advisor_before_run",
		reviewId: "turn-end",
		trigger: "turn_end",
		priority: 100,
		primarySessionId: SESSION_ID,
		advisorSessionId: "default",
	};
}

function setupFixture(
	overrides: Partial<{
		runtime: ComplianceRuntime;
		sessionId: string;
		taskId: string;
		requestedToolNames: readonly string[];
	}> = {},
) {
	const registry = new ComplianceReviewRegistry();
	const runtime = overrides.runtime ?? makeMockRuntime();
	const env = createEnvelope({
		sessionId: overrides.sessionId ?? SESSION_ID,
		taskId: overrides.taskId ?? TASK_ID,
		projectId: PROJECT_ID,
		contractHash: HASH,
		evidenceRevision: EVIDENCE_REVISION as `sha256:${string}`,
		gitHead: GIT_HEAD,
		diffHash: DIFF_HASH as `sha256:${string}`,
		trigger: "compliance_review",
		attempt: 1,
		context: "test-context",
		rules: "test-rules",
	});
	registry.put(env);
	const hook = createComplianceAdvisorHook(registry, runtime, overrides.requestedToolNames);
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

	it("returns undefined when reviewId does not match", () => {
		const { hook } = setupFixture();
		const event = makeComplianceEvent({
			reviewId: "compliance:missing",
			metadata: { taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const result = hook(event);
		expect(result).toBeUndefined();
	});

	it("returns additionalSystemContext and a single tool when matched", () => {
		const requestedToolNames = ["mcp__codebase_memory_mcp_search_graph"];
		const { hook, env } = setupFixture({ requestedToolNames });
		const event = makeComplianceEvent({
			reviewId: env.reviewId,
			metadata: {
				reviewId: env.reviewId,
				taskId: TASK_ID,
				contractHash: HASH,
				attempt: 1,
			},
		});
		const result = hook(event);
		expect(result).toBeDefined();
		expect(result?.additionalSystemContext).toContain("test-rules\n\ntest-context");
		expect(result?.additionalSystemContext).toContain(`"review_id":"${env.reviewId}"`);
		expect(result?.additionalSystemContext).toContain(`"project_id":"${PROJECT_ID}"`);
		expect(result?.additionalTools).toHaveLength(1);
		expect(result?.additionalTools?.[0]?.name).toBe("compliance_verdict");
		expect(result?.additionalTools?.[0]?.label).toBe("Compliance Verdict");
		expect(typeof result?.additionalTools?.[0]?.execute).toBe("function");
		expect(result?.requestedToolNames).toEqual(requestedToolNames);
		expect(result?.verdictToolNames).toEqual(["compliance_verdict"]);
		const required = result?.additionalTools?.[0]?.parameters.required as string[];
		expect(required).toEqual(
			expect.arrayContaining(["review_id", "project_id", "evidence_revision", "git_head", "diff_hash", "trigger"]),
		);
		expect(result?.metadata).toEqual({ complianceReviewId: env.reviewId });
		expect(Object.isFrozen(result?.metadata)).toBe(true);
	});

	it("defaults to no requested tools when discovery was not supplied", () => {
		const { hook, env } = setupFixture();
		const result = hook(
			makeComplianceEvent({
				reviewId: env.reviewId,
				metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
			}),
		);

		expect(result?.requestedToolNames).toEqual([]);
	});

	it("the compliance_verdict tool calls runtime.acceptVerdict on valid submission", async () => {
		const runtime = makeMockRuntime();
		const acceptSpy = spyOn(runtime, "acceptVerdict").mockImplementation(() => Promise.resolve({ accepted: true }));
		const { hook, env, registry } = setupFixture({ runtime });

		const event = makeComplianceEvent({
			reviewId: env.reviewId,
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		// Submit a valid verdict
		const verdict = {
			schema_version: 1,
			review_id: env.reviewId,
			task_id: TASK_ID,
			project_id: PROJECT_ID,
			contract_hash: HASH,
			evidence_revision: EVIDENCE_REVISION,
			git_head: GIT_HEAD,
			diff_hash: DIFF_HASH,
			trigger: "compliance_review",
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
				reviewId: env.reviewId,
				metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
			}),
		) as AdvisorBeforeRunResult;
		const tool = result.additionalTools?.[0];
		const toolResult = await tool.execute("call-rejected", {
			schema_version: 1,
			review_id: env.reviewId,
			task_id: TASK_ID,
			project_id: PROJECT_ID,
			contract_hash: HASH,
			evidence_revision: EVIDENCE_REVISION,
			git_head: GIT_HEAD,
			diff_hash: DIFF_HASH,
			trigger: "compliance_review",
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
			reviewId: env.reviewId,
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			review_id: env.reviewId,
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
			reviewId: env.reviewId,
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			review_id: env.reviewId,
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
			reviewId: env.reviewId,
			metadata: { reviewId: env.reviewId, taskId: TASK_ID, contractHash: HASH, attempt: 1 },
		});
		const resultC = hook(event) as AdvisorBeforeRunResult;
		const tool = (resultC.additionalTools as NonNullable<AdvisorBeforeRunResult["additionalTools"]>)[0];
		const verdict = {
			schema_version: 1,
			review_id: env.reviewId,
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
