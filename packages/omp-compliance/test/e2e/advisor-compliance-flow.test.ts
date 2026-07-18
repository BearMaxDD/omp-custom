import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import { ComplianceReviewRegistry } from "../../src/advisor/review-envelope";
import type { DelegationRecord } from "../../src/delegation/delegation-supervisor";
import { EvidenceStore } from "../../src/evidence/evidence-store";
import { ComplianceRuntime, type ComplianceRuntimePersistenceSnapshot } from "../../src/runtime/compliance-runtime";
import type { ReviewIntentInput, ReviewTrigger } from "../../src/scheduler/review-intent";
import {
	ReviewScheduler,
	type ReviewSchedulerState,
	type ReviewSchedulerStore,
} from "../../src/scheduler/review-scheduler";
import { CollectorRuntime } from "../../src/signals/collector-runtime";
import { buildTrustedDelegationRecords } from "../../src/signals/task-delegation";
import { FakeAdvisor } from "../support/fake-advisor";
import { createFakeExtensionContext } from "../support/fake-extension-api";
import { createStrictRuntimeDependencies } from "../support/strict-runtime-dependencies";

const roots: string[] = [];

function defined<T>(value: T | undefined): T {
	if (value === undefined) {
		throw new Error("expected value to be defined");
	}
	return value;
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

class E2EApi {
	readonly messages: unknown[] = [];
	registerTool(): void {}
	registerCommand(): void {}
	on(): void {}
	appendEntry(): void {}
	sendMessage(message: unknown): void {
		this.messages.push(message);
	}
	logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

interface Harness {
	root: string;
	api: E2EApi;
	store: EvidenceStore;
	collector: CollectorRuntime;
	runtime: ComplianceRuntime;
	advisor: FakeAdvisor;
	registry: ComplianceReviewRegistry;
	schedulerStore: MemorySchedulerStore;
	now: { value: number };
	persisted: { value?: ComplianceRuntimePersistenceSnapshot };
	lastDelegations: { value: readonly DelegationRecord[] };
}

function createHarness(existing?: {
	root: string;
	store: EvidenceStore;
	schedulerStore: MemorySchedulerStore;
	now: { value: number };
	persisted: { value?: ComplianceRuntimePersistenceSnapshot };
}): Harness {
	const root = existing?.root ?? mkdtempSync(join(tmpdir(), "omp-v17-e2e-"));
	if (!existing) {
		roots.push(root);
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n", "utf8");
		writeFileSync(
			join(root, "tdd.md"),
			[
				"# Goal: v17 Advisor compliance flow",
				"",
				"## Scope",
				"- update the value safely",
				"",
				"## Files",
				"- src/index.ts",
				"",
				"## Tests",
				"- bun test",
				"",
				"## Verification",
				"- bun test",
				"",
				"## Completion",
				"- Advisor pass",
			].join("\n"),
			"utf8",
		);
		Bun.spawnSync(["git", "init"], { cwd: root });
		Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: root });
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: root });
		Bun.spawnSync(["git", "add", "."], { cwd: root });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: root });
	}
	const api = new E2EApi();
	const store = existing?.store ?? new EvidenceStore(join(root, ".omp", "compliance"));
	const collector = new CollectorRuntime();
	recordOfficialDelegations(collector);
	const registry = new ComplianceReviewRegistry();
	const schedulerStore = existing?.schedulerStore ?? new MemorySchedulerStore();
	const now = existing?.now ?? { value: Date.parse("2026-07-18T00:00:00.000Z") };
	const persisted = existing?.persisted ?? {};
	const lastDelegations: { value: readonly DelegationRecord[] } = { value: [] };
	const reviewDeps = {
		sessionId: () => "e2e-primary",
		registry,
		requestAdvisorReview: (request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> =>
			Promise.resolve({ reviewId: request.reviewId, status: "accepted", queuedAt: new Date(now.value).toISOString() }),
	};
	const dependencies = createStrictRuntimeDependencies({
		repoRoot: root,
		store,
		schedulerStore,
		now: () => now.value,
		requestAdvisorReview: reviewDeps.requestAdvisorReview,
	});
	const fixtureStrictEvidence = dependencies.strictEvidence;
	const runtime = new ComplianceRuntime(() => store, collector, api, root, reviewDeps, {
		...dependencies,
		strictEvidence: () => {
			const evidence = fixtureStrictEvidence();
			const delegations = evidence.codebasePack
				? buildTrustedDelegationRecords(
						collector.collector.snapshot(),
						evidence.taskContract,
						evidence.codebasePack.evidenceRevision,
					)
				: [];
			lastDelegations.value = delegations;
			return {
				...evidence,
				delegations,
			};
		},
		persistRuntimeState: (_taskId, snapshot) => {
			persisted.value = structuredClone(snapshot);
		},
	});
	return {
		root,
		api,
		store,
		collector,
		runtime,
		advisor: new FakeAdvisor(),
		registry,
		schedulerStore,
		now,
		persisted,
		lastDelegations,
	};
}

function recordVerification(collector: CollectorRuntime, id: string): void {
	const timestamp = new Date().toISOString();
	collector.collector.recordCall({ toolName: "bash", toolCallId: id, params: { command: "bun test" }, timestamp });
	collector.collector.recordResult({
		toolCallId: id,
		success: true,
		resultRef: JSON.stringify({ exitCode: 0 }),
		timestamp,
	});
}

function recordOfficialDelegations(collector: CollectorRuntime): void {
	const context = createFakeExtensionContext({ cwd: "/tmp/e2e-project", sessionId: "e2e-primary" });
	collector.recordToolCall(
		{
			type: "tool_call",
			toolName: "task",
			toolCallId: "e2e-task-call",
			input: { assignment: "implement the TDD change" },
		},
		context,
	);
	collector.recordToolResult(
		{
			type: "tool_result",
			toolName: "task",
			toolCallId: "e2e-task-call",
			input: { assignment: "implement the TDD change" },
			content: [{ type: "text", text: "Task completed successfully." }],
			isError: false,
			details: {
				projectAgentsDir: "/tmp/e2e-agents",
				totalDurationMs: 10,
				results: [
					{
						index: 0,
						id: "e2e-task-agent",
						agent: "implementer",
						agentSource: "project",
						task: "implement the TDD change",
						assignment: "implement the TDD change",
						exitCode: 0,
						output: "Updated src/index.ts",
						stderr: "",
						truncated: false,
						durationMs: 10,
						tokens: 10,
						requests: 1,
					},
				],
			},
		},
		context,
	);
	collector.recordToolCall(
		{
			type: "tool_call",
			toolName: "hub",
			toolCallId: "e2e-hub-call",
			input: { op: "wait", ids: ["e2e-hub-agent"] },
		},
		context,
	);
	collector.recordToolResult(
		{
			type: "tool_result",
			toolName: "hub",
			toolCallId: "e2e-hub-call",
			input: { op: "wait", ids: ["e2e-hub-agent"] },
			content: [{ type: "text", text: "Hub task completed." }],
			isError: false,
			details: {
				op: "wait",
				jobs: [
					{ id: "e2e-hub-agent", type: "task", status: "completed", label: "review the implementation", durationMs: 5 },
				],
			},
		},
		context,
	);
}

function lifecycle(
	runtime: ComplianceRuntime,
	type: "advisor_run_completed" | "advisor_run_failed",
): AdvisorReviewLifecycleEvent {
	const state = runtime.currentTaskState;
	if (!state?.activeReviewId) throw new Error("active review required");
	const base = {
		reviewId: state.activeReviewId,
		trigger: "compliance_review",
		priority: 100,
		primarySessionId: "e2e-primary",
		advisorSessionId: "e2e-advisor",
		timestamp: new Date().toISOString(),
	};
	return type === "advisor_run_completed"
		? { ...base, type, verdictSubmitted: false }
		: { ...base, type, failureClass: "provider", errorSummary: "provider unavailable" };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v17 Advisor compliance integration", () => {
	it("runs TDD + Codebase Pack + task/hub delegation through remediate then pass", async () => {
		const h = createHarness();
		await h.runtime.start("tdd.md");
		recordVerification(h.collector, "verify-first");

		const firstReview = await h.runtime.requestCompletion({ summary: "first completion" });
		const envelope = h.registry.get(firstReview.reviewId);
		expect(envelope?.context).toContain("e2e-task-agent: implement the TDD change");
		expect(h.lastDelegations.value.map((delegation) => delegation.transport)).toEqual(["task", "hub"]);
		expect(h.lastDelegations.value.map((delegation) => delegation.gateStatus)).toEqual(["sufficient", "insufficient"]);
		const firstRevision = h.runtime.currentTaskState?.evidenceRevision;
		await h.runtime.acceptVerdict(
			h.advisor.remediateVerdict(FakeAdvisor.contextFromRuntime(h.runtime), [
				{ id: "fix-value", reason: "Value still needs repair", requiredFix: "Update src/index.ts and rerun tests" },
			]),
		);
		expect(h.runtime.currentTaskState?.status).toBe("remediation_required");
		expect(h.api.messages.some((message) => JSON.stringify(message).includes("Update src/index.ts"))).toBe(true);

		writeFileSync(join(h.root, "src/index.ts"), "export const value = 2;\n", "utf8");
		await h.runtime.resumeAfterRemediation();
		recordVerification(h.collector, "verify-second");
		await h.runtime.requestCompletion({ summary: "fixed completion" });
		expect(h.runtime.currentTaskState?.evidenceRevision).not.toBe(firstRevision);
		await h.runtime.acceptVerdict(
			h.advisor.passVerdict(FakeAdvisor.contextFromRuntime(h.runtime), "All TDD checks passed"),
		);
		expect(h.runtime.currentTaskState?.status).toBe("completed");
	});

	it("fails closed when Advisor stops silently without a verdict", async () => {
		const h = createHarness();
		await h.runtime.start("tdd.md");
		recordVerification(h.collector, "verify-silent");
		await h.runtime.requestCompletion({ summary: "silent review" });
		await h.runtime.handleAdvisorLifecycle(lifecycle(h.runtime, "advisor_run_completed"));
		expect(h.runtime.currentTaskState?.status).toBe("stalled");
	});

	it("retries consecutive Provider failures without a business retry cap", async () => {
		const h = createHarness();
		await h.runtime.start("tdd.md");
		recordVerification(h.collector, "verify-provider");
		await h.runtime.requestCompletion({ summary: "provider retry" });
		const observedDelays: number[] = [];
		for (let attempt = 0; attempt < 8; attempt++) {
			await h.runtime.handleAdvisorLifecycle(lifecycle(h.runtime, "advisor_run_failed"));
			expect(h.runtime.currentTaskState?.status).toBe("stalled");
			const retryAt = defined(h.schedulerStore.state?.queued[0]?.notBefore);
			observedDelays.push(retryAt - h.now.value);
			h.now.value = retryAt;
			await h.runtime.retryDueReviews();
			expect(h.runtime.currentTaskState?.status).toBe("advisor_reviewing");
		}
		expect(observedDelays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
	});

	it("rejects a stale verdict after remediation creates a new review", async () => {
		const h = createHarness();
		await h.runtime.start("tdd.md");
		recordVerification(h.collector, "verify-stale-one");
		await h.runtime.requestCompletion({ summary: "first" });
		const stalePass = h.advisor.passVerdict(FakeAdvisor.contextFromRuntime(h.runtime));
		await h.runtime.acceptVerdict(
			h.advisor.remediateVerdict(FakeAdvisor.contextFromRuntime(h.runtime), [
				{ id: "retry", reason: "repair required", requiredFix: "Apply the repair" },
			]),
		);
		await h.runtime.resumeAfterRemediation();
		recordVerification(h.collector, "verify-stale-two");
		await h.runtime.requestCompletion({ summary: "second" });

		expect((await h.runtime.acceptVerdict(stalePass)).accepted).toBe(false);
		expect(h.runtime.currentTaskState?.status).toBe("advisor_reviewing");
	});

	it("recovers a process exit during reviewing as stalled and retryable", async () => {
		const first = createHarness();
		await first.runtime.start("tdd.md");
		recordVerification(first.collector, "verify-restart");
		await first.runtime.requestCompletion({ summary: "restart review" });
		const restarted = createHarness(first);
		const dependencies = createStrictRuntimeDependencies({
			repoRoot: restarted.root,
			store: restarted.store,
			schedulerStore: restarted.schedulerStore,
			now: () => restarted.now.value,
			delegationTransports: ["task", "hub"],
			requestAdvisorReview: async (request) => ({ reviewId: request.reviewId, status: "accepted" }),
		});
		await dependencies.scheduler.restore();
		const runtime = new ComplianceRuntime(
			() => restarted.store,
			restarted.collector,
			restarted.api,
			restarted.root,
			{
				sessionId: () => "e2e-primary",
				registry: restarted.registry,
				requestAdvisorReview: async (request) => ({ reviewId: request.reviewId, status: "accepted" }),
			},
			dependencies,
		);
		await runtime.restorePersistedState(dependencies.strictEvidence().taskContract, defined(restarted.persisted.value));
		expect(runtime.currentTaskState?.status).toBe("stalled");
	});

	it("prioritizes and deduplicates a mixed trigger storm at the shared scheduler", async () => {
		const store = new MemorySchedulerStore();
		const requests: AdvisorReviewRequest[] = [];
		const scheduler = new ReviewScheduler({
			clock: { now: () => Date.parse("2026-07-18T00:00:00.000Z") },
			random: () => 0,
			store,
			requester: async (request) => {
				requests.push(request);
				return { reviewId: request.reviewId, status: "accepted" };
			},
		});
		const priorities: Readonly<Record<ReviewTrigger, number>> = {
			compliance_review: 100,
			manual_review: 80,
			brainstorm_review: 80,
			git_pre_push: 70,
			impact_analysis: 60,
			file_change: 40,
			scheduled: 20,
		};
		const triggers: ReviewTrigger[] = [
			"scheduled",
			"git_pre_push",
			"brainstorm_review",
			"manual_review",
			"compliance_review",
		];
		const input = (trigger: ReviewTrigger): ReviewIntentInput => ({
			trigger,
			priority: priorities[trigger],
			projectId: "e2e-project",
			taskId: "e2e-task",
			...(trigger === "brainstorm_review" ? { topicId: "e2e-topic" } : {}),
			contractHash: "sha256:contract",
			evidenceRevision: "sha256:evidence-v1",
			gitHead: "abc123",
			diffHash: "sha256:diff-v1",
		});
		const results = await Promise.all(
			triggers.flatMap((trigger) => Array.from({ length: 10 }, () => scheduler.enqueue(input(trigger)))),
		);

		expect(results.filter((result) => result.kind === "enqueued")).toHaveLength(triggers.length);
		expect(results.filter((result) => result.kind === "deduplicated")).toHaveLength(45);
		await scheduler.pump();
		expect(requests.map((request) => [request.trigger, request.priority])).toEqual([["compliance_review", 100]]);
		expect(scheduler.snapshot().queued).toHaveLength(4);
	});
});
