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
import { BrainstormRuntime } from "../../src/brainstorm/brainstorm-runtime";
import { BrainstormReviewRegistry } from "../../src/brainstorm/review-registry";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import type { BrainstormTopicReadyInput } from "../../src/brainstorm/types";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "../../src/types";
import { FakeCodebaseMemory } from "../support/fake-codebase-memory";
import { validTopicInput } from "./fixtures";

// ─── Helpers ───────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `br-rt-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface BrainstormRuntimeHarnessOverrides {
	requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	getAllTools?: () => readonly string[];
	reviewTimeoutMs?: number;
}

function createBrainstormRuntimeHarness(overrides: BrainstormRuntimeHarnessOverrides) {
	const collector = new CollectorRuntime();
	const store = new TopicStore(tempDir());
	const coordinator = new TopicCoordinator(store);
	const registry = new BrainstormReviewRegistry();
	const runtime = new BrainstormRuntime({
		api: { requestAdvisorReview: overrides.requestAdvisorReview },
		collector,
		coordinator,
		registry,
		requestAdvisorReview: overrides.requestAdvisorReview,
		getAllTools: overrides.getAllTools ?? (() => []),
		sessionId: () => "session-1",
		reviewTimeoutMs: overrides.reviewTimeoutMs,
	});
	return { runtime, coordinator, registry, collector };
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
		expect(result.reviewId).toMatch(/^br-/);
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

	it("transitions to review_unavailable and consumes the envelope after timeout", async () => {
		const harness = createBrainstormRuntimeHarness({
			requestAdvisorReview: async (request) => ({ status: "accepted" as const, reviewId: request.reviewId }),
			reviewTimeoutMs: 10,
		});

		const result = await harness.runtime.submitTopic(validTopicInput());
		expect(result.status).toBe("advisor_reviewing");
		await Bun.sleep(30);
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
			getAllTools: () => ["search_graph"],
			sessionId: () => "s1",
		});
		const result = await runtime.submitTopic(validTopicInput({ codebase_relevance: "required" }));
		const envelope = registry.get(result.reviewId);
		expect(envelope?.requestedToolNames).toEqual(["search_graph"]);
	});
});
