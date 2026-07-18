/**
 * Tests for BrainstormRuntime — topic submission, evidence gathering,
 * packet construction, envelope registration, and advisor review requests.
 *
 * Uses real TopicStore and TopicCoordinator with temporary directories.
 * Only the external review action (requestAdvisorReview) is replaced.
 */
import { describe, expect, it, jest } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { createBrainstormAdvisorHook } from "../../src/brainstorm/advisor-hook";
import { BrainstormRuntime } from "../../src/brainstorm/brainstorm-runtime";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import type { BrainstormTopicReadyInput } from "../../src/brainstorm/types";
import { ReviewScheduler } from "../../src/scheduler/review-scheduler";
import type { ReviewSchedulerState, ReviewSchedulerStore } from "../../src/scheduler/review-scheduler";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import { FakeCodebaseMemory } from "../support/fake-codebase-memory";
import { validReview, validTopicInput } from "./fixtures";

// ─── Helpers ───────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `br-rt-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface BrainstormRuntimeHarnessOverrides {
	requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	getAllTools?: () => readonly string[];
	withCodebaseEvidence?: boolean;
	now?: () => number;
	topicDir?: string;
	schedulerStore?: MemorySchedulerStore;
}

class MemorySchedulerStore implements ReviewSchedulerStore {
	state: ReviewSchedulerState | undefined;
	async load(): Promise<ReviewSchedulerState | undefined> {
		return this.state ? structuredClone(this.state) : undefined;
	}
	async save(state: ReviewSchedulerState): Promise<void> {
		this.state = structuredClone(state);
	}
}

function schedulerFor(
	requestAdvisorReview: BrainstormRuntimeHarnessOverrides["requestAdvisorReview"],
	now: () => number = () => Date.now(),
	store: ReviewSchedulerStore = new MemorySchedulerStore(),
): ReviewScheduler {
	return new ReviewScheduler({
		clock: { now },
		random: () => 0,
		store,
		requester: requestAdvisorReview,
	});
}

function createBrainstormRuntimeHarness(overrides: BrainstormRuntimeHarnessOverrides) {
	const collector = new CollectorRuntime();
	if (overrides.withCodebaseEvidence !== false) {
		const memory = new FakeCodebaseMemory(collector.collector);
		memory.recordIndexReady();
		memory.recordSearchGraph("brainstorm", ["TopicCoordinator"]);
		memory.recordGetSnippet("src/brainstorm.ts", "submitTopic");
	}
	const topicDir = overrides.topicDir ?? tempDir();
	const store = new TopicStore(topicDir);
	const coordinator = new TopicCoordinator(store);
	const registry = new BrainstormReviewRegistry();
	const schedulerStore = overrides.schedulerStore ?? new MemorySchedulerStore();
	const scheduler = schedulerFor(overrides.requestAdvisorReview, overrides.now, schedulerStore);
	const runtime = new BrainstormRuntime({
		api: { requestAdvisorReview: overrides.requestAdvisorReview },
		collector,
		coordinator,
		registry,
		requestAdvisorReview: overrides.requestAdvisorReview,
		scheduler,
		ensureSchedulerReady: () => scheduler.restore(),
		projectContext: () => ({
			projectId: "project-brainstorm",
			gitHead: "a".repeat(40),
			diffHash: `sha256:${"b".repeat(64)}`,
		}),
		getAllTools: overrides.getAllTools ?? (() => []),
		sessionId: () => "session-1",
	});
	return { runtime, coordinator, registry, collector, scheduler, schedulerStore, topicDir };
}

// ─── Suite ─────────────────────────────────────────────────────────────

describe("BrainstormRuntime", () => {
	// ── Happy path ─────────────────────────────────────────────────────

	it("submits a topic and requests advisor review", async () => {
		const reviewRequests: AdvisorReviewRequest[] = [];
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => {
				reviewRequests.push(request);
				return { status: "accepted" as const, reviewId: request.reviewId };
			},
		});

		const result = await harness.runtime.submitTopic(validTopicInput());

		expect(reviewRequests).toHaveLength(1);
		expect(reviewRequests[0]).toMatchObject({ trigger: "brainstorm_review", priority: 80 });
		expect(reviewRequests[0].metadata).toMatchObject({
			topicId: result.topic.topicId,
			inputHash: result.topic.inputHash,
		});
		expect(result.status).toBe("advisor_reviewing");
		expect(result.reviewId).toMatch(/^review:/);
	});

	it("transitions topic to advisor_reviewing on successful submission", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		expect(result.status).toBe("advisor_reviewing");
		expect(result.topic.status).toBe("advisor_reviewing");
	});

	it("registers an envelope in the registry on successful submission", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		const envelope = harness.registry.get(result.reviewId!);

		expect(envelope).toBeDefined();
		expect(envelope?.topicId).toBe(result.topic.topicId);
		expect(envelope?.inputHash).toBe(result.topic.inputHash);
		expect(envelope?.context).toBeTruthy();
		expect(envelope?.rules).toBeTruthy();
	});

	// ── Reused (dedup via fingerprint) ─────────────────────────────────

	it("reuses existing topic on duplicate fingerprint", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		const first = await harness.runtime.submitTopic(validTopicInput());
		expect(first.status).toBe("advisor_reviewing");

		const second = await harness.runtime.submitTopic(validTopicInput());
		expect(second.status).toBe("reused");
		expect(second.topic.topicId).toBe(first.topic.topicId);
	});

	// ── Conflict ───────────────────────────────────────────────────────

	it("returns conflict when a different topic is mid-review", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		await harness.runtime.submitTopic(validTopicInput({ title: "First topic" }));
		const second = await harness.runtime.submitTopic(validTopicInput({ title: "Different second topic" }));
		expect(second.status).toBe("conflict");
	});

	// ── Review unavailable (rejection) ─────────────────────────────────

	it("transitions to review_unavailable when advisor rejects", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (_request) => ({ status: "rejected" as const }),
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		expect(result.status).toBe("review_unavailable");
		expect(result.topic.status).toBe("review_unavailable");
	});

	it("transitions to review_unavailable when request throws", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (_request) => {
				throw new Error("Network error");
			},
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		expect(result.status).toBe("review_unavailable");
		expect(result.topic.status).toBe("review_unavailable");
	});

	it("completed without verdict lifecycle 后进入 review_unavailable 并消费 Envelope", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		expect(result.status).toBe("advisor_reviewing");
		if (!result.reviewId) throw new Error("missing review id");
		await harness.runtime.handleAdvisorLifecycle({
			type: "advisor_run_completed",
			reviewId: result.reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: new Date().toISOString(),
			verdictSubmitted: false,
		});
		expect(harness.coordinator.current()?.status).toBe("review_unavailable");
		expect(harness.registry.get(result.reviewId ?? "")).toBeUndefined();
	});

	// ── Envelope content ───────────────────────────────────────────────

	it("includes rules and context in the registered envelope", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		const envelope = harness.registry.get(result.reviewId!);
		expect(envelope).toBeDefined();
		expect(envelope?.rules).toContain("brainstorm-review-rules");
		expect(envelope?.context).toContain("<brainstorm-topic>");
		expect(envelope?.createdAt).toBeTruthy();
	});

	// ── Error handling ─────────────────────────────────────────────────

	it("rejects topic on mark failure with empty registry", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const origSave = store.saveState;
		let n = 0;
		store.saveState = async (topic: unknown) => {
			n += 1;
			if (n === 2) throw new Error("mark failed");
			await origSave.call(store, topic);
		};
		const coordinator = new TopicCoordinator(store);
		const registry = new BrainstormReviewRegistry();
		let putCount = 0;
		const wrapPut = (env: unknown) => {
			putCount++;
			registry.put(env as never);
		};
		const collector = new CollectorRuntime();
		const runtime = new BrainstormRuntime({
			api: { requestAdvisorReview: async () => ({ status: "accepted" as const, reviewId: "r" }) },
			collector,
			coordinator,
			registry: {
				put: wrapPut,
				get: (id: string) => registry.get(id),
				consume: (id: string) => registry.consume(id),
			} as never,
			requestAdvisorReview: async () => ({ status: "accepted" as const, reviewId: "r" }),
			scheduler: schedulerFor(async (request) => ({ status: "accepted" as const, reviewId: request.reviewId })),
			projectContext: () => ({
				projectId: "project-brainstorm",
				gitHead: "a".repeat(40),
				diffHash: `sha256:${"b".repeat(64)}`,
			}),
			getAllTools: () => [],
			sessionId: () => "s1",
		});
		await expect(runtime.submitTopic(validTopicInput())).rejects.toThrow("mark failed");
		expect(putCount).toBe(0);
	});

	it("only includes tool names that pass getAllTools filter", async () => {
		const collector = new CollectorRuntime();
		const memory = new FakeCodebaseMemory(collector.collector);
		memory.recordIndexReady();
		memory.recordSearchGraph("test", ["ref"]);
		memory.recordGetSnippet("src/a.ts", "foo");
		const store = new TopicStore(tempDir());
		const coordinator = new TopicCoordinator(store);
		const registry = new BrainstormReviewRegistry();
		const runtime = new BrainstormRuntime({
			api: { requestAdvisorReview: async () => ({ status: "accepted" as const, reviewId: "r" }) },
			collector,
			coordinator,
			registry,
			requestAdvisorReview: async () => ({ status: "accepted" as const, reviewId: "r" }),
			scheduler: schedulerFor(async (request) => ({ status: "accepted" as const, reviewId: request.reviewId })),
			projectContext: () => ({
				projectId: "project-brainstorm",
				gitHead: "a".repeat(40),
				diffHash: `sha256:${"b".repeat(64)}`,
			}),
			getAllTools: () => ["search_graph"],
			sessionId: () => "s1",
		});
		const result = await runtime.submitTopic(validTopicInput({ codebase_relevance: "required" }));
		const envelope = registry.get(result.reviewId);
		expect(envelope?.requestedToolNames).toEqual(["search_graph"]);
	});

	it("required 代码议题缺少只读证据 Pack 时不请求 Advisor", async () => {
		const reviewRequests: AdvisorReviewRequest[] = [];
		const harness = createBrainstormRuntimeHarness({
			withCodebaseEvidence: false,
			requestAdvisorReview: async (request) => {
				reviewRequests.push(request);
				return { status: "accepted", reviewId: request.reviewId };
			},
		});

		const result = await harness.runtime.submitTopic(validTopicInput({ codebase_relevance: "required" }));

		expect(result.status).toBe("review_unavailable");
		expect(reviewRequests).toHaveLength(0);
		expect(harness.coordinator.current()?.status).toBe("review_unavailable");
	});

	it("Advisor failed 后进入 review_unavailable 并由 Scheduler 退避重试", async () => {
		let now = Date.now();
		const reviewRequests: AdvisorReviewRequest[] = [];
		const harness = createBrainstormRuntimeHarness({
			now: () => now,
			requestAdvisorReview: async (request) => {
				reviewRequests.push(request);
				return { status: "accepted", reviewId: request.reviewId };
			},
		});
		const submitted = await harness.runtime.submitTopic(validTopicInput());
		if (!submitted.reviewId) throw new Error("missing review id");

		await harness.runtime.handleAdvisorLifecycle({
			type: "advisor_run_failed",
			reviewId: submitted.reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: new Date(now).toISOString(),
			failureClass: "provider",
			errorSummary: "provider unavailable",
		});
		expect(harness.coordinator.current()?.status).toBe("review_unavailable");
		expect(harness.scheduler.snapshot().queued).toHaveLength(1);

		now += 5_000;
		await harness.runtime.retryDueReviews();
		expect(reviewRequests).toHaveLength(2);
		expect(harness.coordinator.current()?.status).toBe("advisor_reviewing");
		expect(harness.scheduler.snapshot().inFlight?.attempt).toBe(2);
	});

	it("高优先级 Completion 占用 Advisor 时保留 Brainstorm 排队 Envelope", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		await harness.scheduler.enqueue({
			trigger: "compliance_review",
			priority: 100,
			projectId: "project-brainstorm",
			taskId: "task-compliance",
			contractHash: "sha256:contract",
			evidenceRevision: "sha256:evidence",
			gitHead: "a".repeat(40),
			diffHash: `sha256:${"b".repeat(64)}`,
		});
		await harness.scheduler.pump();

		const result = await harness.runtime.submitTopic(validTopicInput());

		expect(result.status).toBe("advisor_reviewing");
		expect(harness.registry.get(result.reviewId)).toBeDefined();
		expect(harness.scheduler.snapshot().queued.some((intent) => intent.trigger === "brainstorm_review")).toBe(true);
	});

	it("排队 Brainstorm 延迟派发被拒后转 unavailable 并继续重试", async () => {
		let now = Date.now();
		let rejectBrainstorm = true;
		const harness = createBrainstormRuntimeHarness({
			now: () => now,
			requestAdvisorReview: async (request) =>
				request.trigger === "brainstorm_review" && rejectBrainstorm
					? { status: "rejected", reviewId: request.reviewId }
					: { status: "accepted", reviewId: request.reviewId },
		});
		await harness.scheduler.enqueue({
			trigger: "compliance_review",
			priority: 100,
			projectId: "project-brainstorm",
			taskId: "task-compliance",
			contractHash: "sha256:contract",
			evidenceRevision: "sha256:evidence",
			gitHead: "a".repeat(40),
			diffHash: `sha256:${"b".repeat(64)}`,
		});
		await harness.scheduler.pump();
		await harness.runtime.submitTopic(validTopicInput());
		const complianceReviewId = harness.scheduler.snapshot().inFlight?.reviewId;
		if (!complianceReviewId) throw new Error("missing compliance review");
		await harness.scheduler.handleLifecycle({
			type: "advisor_run_completed",
			reviewId: complianceReviewId,
			trigger: "compliance_review",
			priority: 100,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: new Date(now).toISOString(),
			verdictSubmitted: true,
		});

		await harness.runtime.retryDueReviews();
		expect(harness.coordinator.current()?.status).toBe("review_unavailable");
		now += 5_000;
		rejectBrainstorm = false;
		await harness.runtime.retryDueReviews();
		expect(harness.coordinator.current()?.status).toBe("advisor_reviewing");
		expect(harness.scheduler.snapshot().inFlight?.trigger).toBe("brainstorm_review");
	});

	it("进程重启后从 TopicStore 重建 Envelope 并恢复 Scheduler 评审", async () => {
		const topicDir = tempDir();
		const schedulerStore = new MemorySchedulerStore();
		const first = createBrainstormRuntimeHarness({
			topicDir,
			schedulerStore,
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		await first.runtime.submitTopic(validTopicInput());

		const restarted = createBrainstormRuntimeHarness({
			topicDir,
			schedulerStore,
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		await restarted.runtime.retryDueReviews();

		const reviewId = restarted.scheduler.snapshot().inFlight?.reviewId;
		if (!reviewId) throw new Error("missing restored review");
		expect(restarted.coordinator.current()?.status).toBe("advisor_reviewing");
		expect(restarted.registry.get(reviewId)).toBeDefined();
		expect(restarted.registry.get(reviewId)?.reviewId).toBe(reviewId);
	});

	it("enqueue 落盘后崩溃可从 Scheduler metadata 重建 Envelope", async () => {
		const topicDir = tempDir();
		const schedulerStore = new MemorySchedulerStore();
		const first = createBrainstormRuntimeHarness({
			topicDir,
			schedulerStore,
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		const submitted = await first.coordinator.submit(validTopicInput(), first.collector.collector.snapshot());
		if (submitted.kind !== "created") throw new Error("missing created topic");
		await first.scheduler.enqueue({
			trigger: "brainstorm_review",
			priority: 80,
			projectId: "project-brainstorm",
			taskId: `brainstorm-${submitted.topic.topicId}`,
			topicId: submitted.topic.topicId,
			contractHash: submitted.topic.inputHash,
			evidenceRevision: "sha256:evidence",
			gitHead: "a".repeat(40),
			diffHash: `sha256:${"b".repeat(64)}`,
			metadata: {
				context: "persisted brainstorm context",
				rules: "persisted brainstorm rules",
				requestedToolNames: ["search_graph"],
			},
		});

		const restarted = createBrainstormRuntimeHarness({
			topicDir,
			schedulerStore,
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		await restarted.runtime.retryDueReviews();

		const reviewId = restarted.scheduler.snapshot().inFlight?.reviewId;
		if (!reviewId) throw new Error("missing recovered review");
		expect(restarted.coordinator.current()?.status).toBe("advisor_reviewing");
		expect(restarted.registry.get(reviewId)?.context).toBe("persisted brainstorm context");
		expect(restarted.registry.get(reviewId)?.requestedToolNames).toEqual(["search_graph"]);
	});

	it("失败 lifecycle 后旧 Advisor 工具的迟到 review 必须被拒绝", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		const submitted = await harness.runtime.submitTopic(validTopicInput());
		if (!submitted.reviewId) throw new Error("missing review id");
		const hook = createBrainstormAdvisorHook(
			harness.registry,
			harness.coordinator,
			() => {},
			(envelope, review) => harness.runtime.acceptReview(envelope, review),
		);
		const tool = hook({
			type: "advisor_before_run",
			reviewId: submitted.reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			metadata: {},
			primarySessionId: "primary",
			advisorSessionId: "advisor",
		})?.additionalTools?.[0];
		if (!tool) throw new Error("missing brainstorm review tool");
		await harness.runtime.handleAdvisorLifecycle({
			type: "advisor_run_failed",
			reviewId: submitted.reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			primarySessionId: "primary",
			advisorSessionId: "advisor",
			timestamp: new Date().toISOString(),
			failureClass: "provider",
			errorSummary: "failed",
		});

		await expect(tool.execute("late-review", validReview(submitted.topic) as never)).rejects.toThrow("stale");
		expect(harness.coordinator.current()?.status).toBe("review_unavailable");
		expect(harness.scheduler.snapshot().queued).toHaveLength(1);
	});

	it("结构化 review 成功后完成 Scheduler intent 但仍等待用户决定", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted", reviewId: request.reviewId }),
		});
		const submitted = await harness.runtime.submitTopic(validTopicInput());
		if (!submitted.reviewId) throw new Error("missing review id");
		const tool = createBrainstormAdvisorHook(
			harness.registry,
			harness.coordinator,
			() => {},
			(envelope, review) => harness.runtime.acceptReview(envelope, review),
		)({
			type: "advisor_before_run",
			reviewId: submitted.reviewId,
			trigger: "brainstorm_review",
			priority: 80,
			metadata: {},
			primarySessionId: "primary",
			advisorSessionId: "advisor",
		})?.additionalTools?.[0];
		if (!tool) throw new Error("missing brainstorm review tool");

		await tool.execute("review", validReview(submitted.topic) as never);

		expect(harness.coordinator.current()?.status).toBe("awaiting_user_decision");
		expect(harness.scheduler.snapshot().completed).toHaveLength(1);
		expect(harness.scheduler.snapshot().queued).toHaveLength(0);
	});
});
