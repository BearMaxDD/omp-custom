/**
 * Compliance Runtime — coordinates completion gate, state machine,
 * evidence store, signal collection, and remediation injection.
 *
 * Provides the high-level API that commands and tools call:
 *  - start/stop/resume lifecycle
 *  - requestCompletion → snapshot → advisor_reviewing
 *  - acceptVerdict → completed | remediation_required (+ injection)
 *  - recordVerification (test convenience)
 *  - resumeAfterRemediation
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildCompletionContext } from "../advisor/completion-context";
import { renderCompletionRules } from "../advisor/default-rule-pack";
import { createEnvelope } from "../advisor/review-envelope";
import type { ComplianceReviewDependencies, ComplianceReviewEnvelope } from "../advisor/review-envelope";
import { VerdictValidationError, parseVerdict } from "../advisor/verdict-schema";
import type { ComplianceFinding, ComplianceVerdict } from "../advisor/verdict-schema";
import { acceptVerdict as sinkAcceptVerdict } from "../advisor/verdict-sink";
import type { VerdictStore } from "../advisor/verdict-sink";
import { loadComplianceContract } from "../contract/load-contract";
import type { ComplianceContract } from "../contract/types";
import type { EvidenceRecord, EvidenceStore } from "../evidence/evidence-store";
import { injectRemediation } from "../remediation/inject-required-fix";
import type { RemediationFinding } from "../remediation/inject-required-fix";
import type { CollectorRuntime } from "../signals/collector-runtime";
import type { EvidenceSnapshot } from "../signals/types";
import { transition } from "../state/task-state-machine";
import type { TaskState } from "../state/types";
import type { AdvisorReviewReceipt, ExtensionAPI } from "../types";
import type { CompletionSnapshot } from "./completion-gate";
import { buildCompletionSnapshot } from "./completion-gate";
import { SmokeTestRunner, type SmokeTestConfig, type SmokeTestResult } from "./smoke-test-runner";

// ─── Transient task state key for evidence store isolation ──────────

const _TASK_STATE_KEY = "_runtime_task_state";

/** Convenience verification record (for test use). */
export interface VerificationRecord {
	command: string;
	exitCode: number;
}

/**
 * Runtime coordinator for a single managed compliance task.
 *
 * Thread-safe within a single extension session. Only one task can be
 * active at a time — start() rejects if a task is already running.
 */
export class ComplianceRuntime {
	private taskState: TaskState | null = null;
	private contract: ComplianceContract | null = null;
	private _store: EvidenceStore | null = null;
	private readonly verdictStore: VerdictStore = { records: [], lastPass: {}, acceptedKeys: new Set() };

	constructor(
		private readonly getEvidenceStore: () => EvidenceStore,
		private readonly collector: CollectorRuntime,
		private readonly api: ExtensionAPI,
		private readonly repoRoot: string,
		private readonly reviewDeps: ComplianceReviewDependencies,
	) {}

	// ─── Lifecycle: start / stop / resume ──────────────────────────

	/**
	 * Start a new managed compliance task from a TDD file.
	 *
	 * Loads the contract, creates a unique task ID, records an `active`
	 * evidence entry, and sends a brief managed prompt to the main agent.
	 *
	 * @param tddPath — path to the TDD markdown file
	 * @returns taskId and initial status
	 * @throws if a task is already active
	 */
	async start(tddPath: string): Promise<{ taskId: string; status: string }> {
		if (this.taskState && this.taskState.status !== "stalled") {
			throw new Error("A compliance task is already active");
		}
		const resolvedTddPath = tddPath.startsWith("/") ? tddPath : join(this.repoRoot, tddPath);
		const contract = loadComplianceContract(resolvedTddPath, this.repoRoot);
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const seedFingerprint = `initial-${Date.now()}`;

		const state: TaskState = {
			taskId,
			status: "active",
			attempt: 1,
			contractHash: contract.contractHash,
			tddPath: contract.tddPath,
			worktreeFingerprint: seedFingerprint,
			createdAt: now,
			updatedAt: now,
			consecutiveStalledFingerprints: 0,
		};

		this.taskState = state;
		this.contract = contract;

		// Write active evidence record
		await this.writeEvidenceRecord("active", {
			signalDigest: "task-started",
		});

		// Send brief managed prompt to the main agent
		this.api.sendMessage(
			{
				customType: "compliance_managed",
				content: "Compliance managed task started",
				display: false,
				attribution: "agent" as const,
				details: {
					taskId,
					contractHash: contract.contractHash,
					goal: contract.summary.goal,
					tddPath: contract.tddPath,
				},
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		return { taskId, status: state.status };
	}

	/**
	 * Stop the currently active managed task.
	 *
	 * Records a `stopped` evidence event and clears state.
	 * Returns false if no task is active.
	 */
	async stop(): Promise<{ stopped: boolean }> {
		if (!this.taskState) {
			return { stopped: false };
		}

		await this.writeEvidenceRecord("stopped", {
			signalDigest: "task-stopped-by-user",
		});

		this.taskState = null;
		this.contract = null;

		return { stopped: true };
	}

	/**
	 * Resume a stalled compliance task.
	 *
	 * If the current task matches the given taskId and is stalled,
	 * transitions it back to active via an activity event.
	 *
	 * @param taskId — the task to resume
	 * @returns the new status
	 * @throws if no stalled task matches the given id
	 */
	async resume(taskId: string): Promise<{ status: string }> {
		if (!this.taskState || this.taskState.taskId !== taskId) {
			throw new Error(`No stalled task found for id: ${taskId}`);
		}
		if (this.taskState.status !== "stalled") {
			throw new Error(`Task ${taskId} is not stalled (status: ${this.taskState.status})`);
		}

		const newFingerprint = `resume-${Date.now()}`;
		const newState = transition(this.taskState, {
			type: "activity",
			worktreeFingerprint: newFingerprint,
		});

		this.taskState = newState;

		await this.writeEvidenceRecord("resumed", {
			signalDigest: "task-resumed",
		});

		return { status: newState.status };
	}

	// ─── Completion & Verdict ───────────────────────────────────────

	/**
	 * Record a synthetic verification command (for test or passthrough).
	 *
	 * Creates synthetic tool_call + tool_result events in the collector
	 * so they appear in the next evidence snapshot.
	 */
	recordVerification(verification: VerificationRecord): void {
		const callId = `verif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.collector.collector.recordCall({
			toolName: "bash",
			toolCallId: callId,
			params: { command: verification.command },
			timestamp: new Date().toISOString(),
		});
		this.collector.collector.recordResult({
			toolCallId: callId,
			success: verification.exitCode === 0,
			resultRef: JSON.stringify({ exitCode: verification.exitCode }),
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Request completion for the current task.
	 *
	 * Builds a completion snapshot, transitions the task state to
	 * advisor_reviewing, and returns the snapshot (read-only facts).
	 *
	 * @param params — agent claim: summary + optional claimed verification
	 * @returns status and completion snapshot
	 * @throws if no task is active or task is not in a completable state
	 */
	async requestCompletion(params: {
		summary: string;
		claimedVerification?: string[];
	}): Promise<{
		status: string;
		completionSnapshot: CompletionSnapshot;
		reviewId: string;
		receipt: AdvisorReviewReceipt;
	}> {
		if (!this.taskState) {
			throw new Error("No active compliance task");
		}
		if (this.taskState.status !== "active") {
			throw new Error(`Cannot request completion from status: ${this.taskState.status}`);
		}
		const activeContract = this.contract;
		if (!activeContract) {
			throw new Error("No contract loaded for compliance task");
		}

		const newState = transition(this.taskState, { type: "completion_requested" });
		this.taskState = newState;

		// Run smoke tests before freezing the snapshot — every failing command
		// produces a named verification failure visible in the advisor context
		const smokeConfigs = this.buildSmokeTestConfigs(activeContract);
		const smokeResults = await SmokeTestRunner.run(smokeConfigs);
		for (const sr of smokeResults) {
			this.collector.collector.recordCall({
				toolName: "smoke_test",
				toolCallId: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				params: { command: sr.command },
				timestamp: new Date().toISOString(),
			});
			this.collector.collector.recordResult({
				toolCallId: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				success: sr.exitCode === 0,
				resultRef: JSON.stringify({ exitCode: sr.exitCode, duration: sr.duration, truncated: sr.truncated }),
				timestamp: new Date().toISOString(),
			});
		}

		const taskFingerprint = this.taskState.worktreeFingerprint;
		const snapshot = buildCompletionSnapshot(
			this.taskState,
			activeContract,
			this.collector.collector.snapshot(),
			taskFingerprint,
			{
				summary: params.summary,
				claimedVerification: params.claimedVerification,
			},
		);

		// Build context and rules from the snapshot
		const sessionId = this.reviewDeps.sessionId();
		const context = buildCompletionContext(snapshot, activeContract.policy);
		const rules = renderCompletionRules(activeContract.policy);

		// Create frozen envelope with stable reviewId
		const envelope = createEnvelope({
			sessionId,
			taskId: this.taskState.taskId,
			contractHash: this.taskState.contractHash,
			attempt: this.taskState.attempt,
			context,
			rules,
		});

		// Write completion_requested evidence before registry put
		await this.writeEvidenceRecord("completion_requested", {
			signalDigest: snapshot.diffFingerprint,
		});

		// Register envelope (available for the advisor_before_run hook)
		this.reviewDeps.registry.put(envelope);

		// Request Advisor review — may throw if harness cannot accommodate
		let receipt: AdvisorReviewReceipt;
		try {
			receipt = await this.reviewDeps.requestAdvisorReview({
				reviewId: envelope.reviewId,
				metadata: {
					sessionId,
					taskId: this.taskState.taskId,
					contractHash: this.taskState.contractHash,
					attempt: this.taskState.attempt,
					context,
					rules,
				},
			});
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			await this.writeEvidenceRecord("advisor_unavailable", {
				signalDigest: "advisor-unavailable",
			});
			return {
				status: newState.status,
				completionSnapshot: snapshot,
				reviewId: envelope.reviewId,
				receipt: { reviewId: envelope.reviewId, status: "rejected" as const, reason },
			};
		}

		if (receipt.status === "accepted") {
			await this.writeEvidenceRecord("advisor_review_accepted", {
				signalDigest: receipt.reviewId,
			});
		}

		return {
			status: newState.status,
			completionSnapshot: snapshot,
			reviewId: envelope.reviewId,
			receipt,
		};
	}

	/**
	 * Accept a verdict from the Advisor and apply it to the task state.
	 *
	 * Pipeline: schema validation (parseVerdict) → idempotency / staleness /
	 * post-pass lock (verdict-sink) → state machine transition.
	 *
	 * On "pass": transitions to completed (terminal).
	 * On "remediate": transitions to remediation_required and injects
	 * a structured fix message to the main agent.
	 *
	 * Schema failures, idempotent duplicates, stale attempts, and post-pass
	 * remediations keep the task in advisor_reviewing and do NOT inject.
	 *
	 * @param verdict — raw advisor verdict (schema_version, task_id, ...)
	 */
	async acceptVerdict(verdict: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }> {
		if (!this.taskState) {
			return { accepted: false, reason: "No active compliance task" };
		}

		// Step 1: Schema + context validation via parseVerdict
		const ctx = {
			taskId: this.taskState.taskId,
			contractHash: this.taskState.contractHash,
			attempt: this.taskState.attempt,
		};
		let parsed: ComplianceVerdict;
		try {
			parsed = parseVerdict(verdict, ctx);
		} catch (err) {
			if (err instanceof VerdictValidationError) {
				// Schema invalid → stay in advisor_reviewing, no injection
				this.taskState = transition(this.taskState, {
					type: "protocol_error",
					error: `Schema validation failed — ${err.message}`,
				});
				return { accepted: false, reason: err.message };
			}
			throw err;
		}

		// Step 2: Idempotency, staleness, post-pass lock via verdict-sink
		const sinkResult = sinkAcceptVerdict(verdict, ctx, this.verdictStore, parsed);
		if (sinkResult.status !== "accepted") {
			if (sinkResult.protocolError) {
				this.taskState = transition(this.taskState, {
					type: "protocol_error",
					error: sinkResult.reason,
				});
			}
			// Idempotent reject (already processed) → no-op
			return { accepted: false, reason: sinkResult.reason };
		}

		// Step 3: Map parsed verdict to state machine transitions
		const isPass = parsed.status === "pass";
		const findings = parsed.findings as ComplianceFinding[];

		if (isPass) {
			this.taskState = transition(this.taskState, {
				type: "verdict",
				status: "pass",
				summary: findings.length > 0 ? findings[0].reason : undefined,
				schemaValid: true,
			});
			await this.writeEvidenceRecord("completed", {
				signalDigest: "advisor-pass",
				verdictSummary: findings.length > 0 ? findings[0].reason : undefined,
			});
			return { accepted: true };
		}

		// Status is "remediate" — extract required fixes from findings
		const fixes = findings
			.filter((f): f is ComplianceFinding & { required_fix: string } => !!f.required_fix)
			.map((f) => f.required_fix);

		this.taskState = transition(this.taskState, {
			type: "verdict",
			status: "remediation_required",
			summary: findings.length > 0 ? findings[0].reason : undefined,
			requiredFixes: fixes,
			schemaValid: true,
		});

		await this.writeEvidenceRecord("remediation_required", {
			signalDigest: "advisor-remediate",
			verdictSummary: findings.length > 0 ? findings[0].reason : undefined,
		});

		// Only inject if not stalled
		if (this.taskState.status !== "stalled") {
			const remediationFindings: RemediationFinding[] = fixes.map((fix, i) => ({
				id: `finding-${i + 1}`,
				reason: findings[i]?.reason ?? "Advisor identified issues requiring remediation",
				requiredFix: fix,
				evidenceRefs: [`evidence://${this.taskState?.taskId}`],
			}));

			injectRemediation(this.api, {
				taskId: this.taskState.taskId,
				contractHash: this.taskState.contractHash,
				findings: remediationFindings,
			});
		}
		return { accepted: true };
	}

	/**
	 * Transition the current task from remediation_required back to active
	 * (agent has applied the fixes and is ready for re-completion).
	 *
	 * @returns the new status
	 */
	resumeAfterRemediation(): string {
		if (!this.taskState) {
			throw new Error("No active compliance task");
		}
		if (this.taskState.status !== "remediation_required") {
			throw new Error(`Cannot resume from status: ${this.taskState.status}`);
		}

		const newFingerprint = `remediated-${Date.now()}`;
		this.taskState = transition(this.taskState, {
			type: "activity",
			worktreeFingerprint: newFingerprint,
		});

		// Increment attempt
		this.taskState = {
			...this.taskState,
			attempt: this.taskState.attempt + 1,
		};

		return this.taskState.status;
	}

	// ─── Tools & Smoke Test Support ────────────────────────────────

	/**
	 * Check whether the extension API has registered the required WATCHDOG tools.
	 *
	 * Returns a map of tool-name → availability so callers can decide whether
	 * to gate impact analysis behind a missing-tool fallback.
	 *
	 * By default returns a simple pre-flight — subclasses or higher-level
	 * integration can override this to inspect the actual tool registry.
	 */
	hasTools(toolNames: string[]): Record<string, boolean> {
		const result: Record<string, boolean> = {};
		for (const name of toolNames) {
			// Convention: the extension API exposes hasTool(name) on the
			// tool registry.  When the registry is not directly exposed
			// (e.g. the OMP ExtensionAPI), fall back to a naming convention.
			result[name] = true; // optimistic — tools are assumed available
		}
		return result;
	}

	/**
	 * Run smoke tests for the current contract's verification commands.
	 *
	 * Extracts commands from the policy's `verification.otherChecks` list
	 * and executes each one through SmokeTestRunner.  Results are recorded
	 * as tool-call events for inclusion in the next evidence snapshot.
	 *
	 * @param configs — optional override; when omitted, builds from the contract
	 * @returns structured results for every executed command
	 */
	async runSmokeTests(configs?: SmokeTestConfig[]): Promise<SmokeTestResult[]> {
		const activeContract = this.contract;
		if (!activeContract && !configs) {
			throw new Error("No active contract — provide explicit smoke test configs");
		}

		const resolvedConfigs = configs ?? this.buildSmokeTestConfigs(activeContract!);
		const results = await SmokeTestRunner.run(resolvedConfigs);

		// Record each result in the collector for evidence
		for (const sr of results) {
			this.collector.collector.recordCall({
				toolName: "smoke_test",
				toolCallId: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				params: { command: sr.command },
				timestamp: new Date().toISOString(),
			});
			this.collector.collector.recordResult({
				toolCallId: `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				success: sr.exitCode === 0,
				resultRef: JSON.stringify({ exitCode: sr.exitCode, duration: sr.duration, truncated: sr.truncated }),
				timestamp: new Date().toISOString(),
			});
		}

		return results;
	}

	/**
	 * Request an impact analysis from the Impact Plan Sink (task 8).
	 *
	 * When WATCHDOG tools are available, this method cross-references the
	 * current task's changed files against the contract so the advisor can
	 * reason about unintended side effects.
	 *
	 * Stub / forward-compatible — the ImpactPlanSink integration will be
	 * wired once task 8 lands.
	 *
	 * @returns a placeholder result indicating impact analysis is pending
	 */
	async requestImpactAnalysis(): Promise<{ status: string; detail: string }> {
		if (!this.taskState || !this.contract) {
			return { status: "skipped", detail: "No active compliance task" };
		}

		// Pre-check WATCHDOG-style tools before delegating
		const tools = this.hasTools(["impact_plan_sink", "watchdog_analysis"]);
		if (!tools["impact_plan_sink"] && !tools["watchdog_analysis"]) {
			return { status: "unavailable", detail: "Impact analysis tools not registered" };
		}

		// Future: delegate to ImpactPlanSink.analyze(taskState, contract)
		return {
			status: "pending",
			detail: "Impact analysis will be implemented when ImpactPlanSink (task 8) lands",
		};
	}

	// ─── Private helpers (continued) ──────────────────────────────────

	/**
	 * Build smoke test configurations from the current contract's summary.
	 *
	 * Verification steps in the contract summary (e.g. "bun test", "biome check")
	 * are converted to SmokeTestConfigs.  Markdown bullet prefixes ("- ", "* ") are
	 * stripped automatically.  Falls back to a basic `bun test` check when no
	 * verification steps are defined.
	 */
	private buildSmokeTestConfigs(contract: ComplianceContract): SmokeTestConfig[] {
		const verifications = contract.summary.verification;
		if (verifications.length > 0) {
			return verifications
				.map((cmd) => cmd.replace(/^[-*]\s+/, "").trim())
				.filter((cmd) => cmd.length > 0 && !cmd.startsWith("-"))
				.map((cmd) => ({
					command: cmd,
					timeoutMs: 30_000,
				}));
		}
		// Fallback: run the project test suite with a generous timeout
		return [{ command: "bun test", timeoutMs: 60_000 }];
	}

	// ─── State accessors ───────────────────────────────────────────

	/** Get the current task state, or null if no task is managed. */
	get currentTaskState(): TaskState | null {
		return this.taskState;
	}

	/** Get the current loaded contract, or null. */
	get currentContract(): ComplianceContract | null {
		return this.contract;
	}

	/** Get the current evidence snapshot from the collector. */
	get currentEvidenceSnapshot(): EvidenceSnapshot {
		return this.collector.collector.snapshot();
	}

	/** Get the underlying evidence store (lazily initialized on first access). */
	get evidenceStore(): EvidenceStore {
		if (!this._store) {
			this._store = this.getEvidenceStore();
		}
		return this._store;
	}

	// ─── Private helpers ───────────────────────────────────────────

	private async writeEvidenceRecord(event: string, extra: Partial<EvidenceRecord>): Promise<void> {
		if (!this.taskState || !this.contract) {
			return;
		}

		const record: EvidenceRecord = {
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			taskId: this.taskState.taskId,
			contractPath: this.contract.tddPath,
			contractHash: this.contract.contractHash,
			attempt: this.taskState.attempt,
			event,
			signalDigest: extra.signalDigest ?? "",
			verdictSummary: extra.verdictSummary,
			worktreeFingerprint: extra.worktreeFingerprint ?? this.taskState.worktreeFingerprint,
		};

		await this.evidenceStore.append(record);
	}
}
