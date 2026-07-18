import { execFileSync } from "node:child_process";
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
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildCompletionContext } from "../advisor/completion-context";
import { renderCompletionRules } from "../advisor/default-rule-pack";
import type { ComplianceReviewDependencies, ComplianceReviewEnvelope } from "../advisor/review-envelope";
import { VerdictValidationError, parseVerdict } from "../advisor/verdict-schema";
import type { ComplianceFinding, ComplianceVerdict } from "../advisor/verdict-schema";
import { acceptVerdict as sinkAcceptVerdict } from "../advisor/verdict-sink";
import type { VerdictStore } from "../advisor/verdict-sink";
import { loadComplianceContract } from "../contract/load-contract";
import type { ComplianceContract } from "../contract/types";
import type { TaskContract } from "../contract/types";
import { createReviewEnvelope } from "../contracts/review-envelope";
import type { ReviewEnvelope } from "../contracts/review-envelope";
import { validateTaskContractIntegrity } from "../contracts/task-contract";
import { delegationSatisfiesGate } from "../delegation/delegation-supervisor";
import type { DelegationRecord } from "../delegation/delegation-supervisor";
import type { EvidenceRecord, EvidenceStore } from "../evidence/evidence-store";
import { injectRemediation } from "../remediation/inject-required-fix";
import type { RemediationFinding } from "../remediation/inject-required-fix";
import { ReviewScheduler } from "../scheduler/review-scheduler";
import type { ReviewSchedulerState, ReviewSchedulerStore } from "../scheduler/review-scheduler";
import { validateCodebasePack } from "../signals/codebase-memory";
import type { CollectorRuntime } from "../signals/collector-runtime";
import type { EvidenceSnapshot } from "../signals/types";
import type { CodebaseEvidencePack, TrustedCodebaseValidationContext } from "../signals/types";
import { transition } from "../state/task-state-machine";
import type { TaskState } from "../state/types";
import type { CompletionSnapshot } from "./completion-gate";
import { buildCompletionSnapshot } from "./completion-gate";

// ─── Transient task state key for evidence store isolation ──────────

const _TASK_STATE_KEY = "_runtime_task_state";

class RuntimeSchedulerStore implements ReviewSchedulerStore {
	state: ReviewSchedulerState | undefined;
	async load(): Promise<ReviewSchedulerState | undefined> {
		return this.state;
	}
	async save(state: ReviewSchedulerState): Promise<void> {
		this.state = structuredClone(state);
	}
}

function sha256(value: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function projectIdFor(root: string): string {
	const hex = createHash("sha256").update(root).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function gitContext(root: string): { gitHead: string; diffHash: `sha256:${string}` } {
	try {
		const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const diff = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean)
			.sort();
		const untrackedDigest = untracked.map((path) => [path, sha256(readFileSync(join(root, path), "utf8"))]);
		return { gitHead, diffHash: sha256(JSON.stringify([diff, trackedDiff, untrackedDigest])) };
	} catch {
		return { gitHead: "0".repeat(40), diffHash: sha256("") };
	}
}

/** Convenience verification record (for test use). */
export interface VerificationRecord {
	command: string;
	exitCode: number;
}

export interface ComplianceRuntimeHost {
	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
}

export interface StrictCompletionEvidence {
	readonly taskContract: TaskContract;
	readonly codebasePack: CodebaseEvidencePack;
	readonly codebaseContext: TrustedCodebaseValidationContext;
	readonly delegations: readonly DelegationRecord[];
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
	private readonly scheduler: ReviewScheduler;
	private activeEnvelope: ReviewEnvelope | undefined;
	private latestReceipt: AdvisorReviewReceipt | undefined;

	constructor(
		private readonly getEvidenceStore: () => EvidenceStore,
		private readonly collector: CollectorRuntime,
		private readonly api: ComplianceRuntimeHost,
		private readonly repoRoot: string,
		private readonly reviewDeps: ComplianceReviewDependencies,
		private readonly strictEvidence?: () => StrictCompletionEvidence,
	) {
		this.scheduler = new ReviewScheduler({
			clock: { now: () => Date.now() },
			random: () => 0,
			store: new RuntimeSchedulerStore(),
			requester: async (request) => {
				if (this.taskState?.status === "stalled" && this.activeEnvelope) {
					const reviewAttempt = request.metadata?.attempt;
					if (!Number.isSafeInteger(reviewAttempt) || (reviewAttempt as number) < 1) {
						throw new Error("Scheduler retry attempt is invalid");
					}
					const retryEnvelope = createReviewEnvelope(
						{
							taskId: this.activeEnvelope.taskId,
							projectId: this.activeEnvelope.projectId,
							contractHash: this.activeEnvelope.contractHash,
							evidenceRevision: this.activeEnvelope.evidenceRevision,
							gitHead: this.activeEnvelope.gitHead,
							diffHash: this.activeEnvelope.diffHash,
							attempt: this.activeEnvelope.attempt,
							trigger: "compliance_review",
							createdAt: new Date().toISOString(),
						},
						reviewAttempt as number,
					);
					if (retryEnvelope.reviewId !== request.reviewId) throw new Error("Scheduler retry identity mismatch");
					await this.writeEvidenceRecord("completion_retry", { signalDigest: retryEnvelope.envelopeHash });
					this.activeEnvelope = retryEnvelope;
					this.taskState = transition(this.taskState, { type: "retry", reviewId: request.reviewId });
				}
				let hostReceipt: AdvisorReviewReceipt;
				try {
					hostReceipt = await this.reviewDeps.requestAdvisorReview(request);
				} catch (error) {
					this.latestReceipt = {
						status: "rejected",
						reviewId: request.reviewId,
						reason: error instanceof Error ? error.message : "advisor request failed",
					};
					if (this.taskState) {
						this.taskState = transition(this.taskState, {
							type: "review_failed",
							reviewId: request.reviewId,
							reason: error instanceof Error ? error.message : "advisor request failed",
						});
					}
					throw error;
				}
				const receipt =
					hostReceipt.status === "accepted"
						? { ...hostReceipt, reviewId: request.reviewId }
						: { ...hostReceipt, reviewId: request.reviewId };
				this.latestReceipt = receipt;
				if (receipt.status === "accepted" && this.taskState) {
					this.taskState = transition(this.taskState, { type: "advisor_accepted", reviewId: request.reviewId });
				} else if (this.taskState) {
					this.taskState = transition(this.taskState, {
						type: "review_failed",
						reviewId: request.reviewId,
						reason: receipt.reason ?? "advisor request rejected",
					});
				}
				return receipt;
			},
		});
	}

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
		const strictContract = this.strictEvidence
			? validateTaskContractIntegrity(this.strictEvidence().taskContract)
			: undefined;
		if (strictContract && strictContract.contractHash !== contract.contractHash) {
			throw new Error("TaskContract does not match the loaded TDD contract");
		}
		const taskId = strictContract?.taskId ?? randomUUID();
		const now = new Date().toISOString();
		const seedFingerprint = `initial-${Date.now()}`;
		const currentGit = gitContext(this.repoRoot);

		const state: TaskState = {
			taskId,
			projectId: strictContract?.projectId ?? projectIdFor(this.repoRoot),
			status: "active",
			attempt: 1,
			contractHash: contract.contractHash,
			evidenceRevision: sha256("initial"),
			gitHead: strictContract?.gitHead ?? currentGit.gitHead,
			diffHash: currentGit.diffHash,
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

		if (this.strictEvidence && snapshot.verifications.length === 0) {
			throw new Error("Completion Gate requires a real verification Tool Result");
		}
		const currentGit = gitContext(this.repoRoot);
		const evidenceRevision = this.validateStrictEvidence(currentGit, snapshot);

		// Build context and rules from the snapshot
		const sessionId = this.reviewDeps.sessionId();
		const context = buildCompletionContext(snapshot, activeContract.policy);
		const rules = renderCompletionRules(activeContract.policy);

		const strictEnvelope = createReviewEnvelope({
			taskId: this.taskState.taskId,
			projectId: this.taskState.projectId,
			contractHash: this.taskState.contractHash,
			evidenceRevision,
			gitHead: currentGit.gitHead,
			diffHash: currentGit.diffHash,
			attempt: this.taskState.attempt,
			trigger: "compliance_review",
			createdAt: new Date().toISOString(),
		});
		this.activeEnvelope = strictEnvelope;

		// Envelope persistence is the commit point: state cannot advance before this succeeds.
		await this.writeEvidenceRecord("completion_requested", {
			signalDigest: strictEnvelope.envelopeHash,
			reviewEnvelope: strictEnvelope,
		});

		this.taskState = transition(this.taskState, {
			type: "completion_requested",
			reviewId: strictEnvelope.reviewId,
			evidenceRevision,
			gitHead: currentGit.gitHead,
			diffHash: currentGit.diffHash,
		});
		const envelope: ComplianceReviewEnvelope = Object.freeze({
			reviewId: strictEnvelope.reviewId,
			sessionId,
			taskId: strictEnvelope.taskId,
			contractHash: strictEnvelope.contractHash as `sha256:${string}`,
			attempt: strictEnvelope.attempt,
			context,
			rules,
			createdAt: strictEnvelope.createdAt,
		});
		this.reviewDeps.registry.put(envelope);

		let receipt: AdvisorReviewReceipt;
		try {
			await this.scheduler.enqueue({
				trigger: "compliance_review",
				priority: 100,
				projectId: strictEnvelope.projectId,
				taskId: strictEnvelope.taskId,
				contractHash: strictEnvelope.contractHash,
				evidenceRevision: strictEnvelope.evidenceRevision,
				gitHead: strictEnvelope.gitHead,
				diffHash: strictEnvelope.diffHash,
				metadata: {
					sessionId,
					envelopeHash: strictEnvelope.envelopeHash,
					context,
					rules,
				},
			});
			await this.scheduler.pump();
			receipt = this.latestReceipt ?? {
				reviewId: strictEnvelope.reviewId,
				status: "rejected",
				reason: "Advisor receipt unavailable",
			};
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			this.taskState = transition(this.taskState, {
				type: "review_failed",
				reviewId: strictEnvelope.reviewId,
				reason,
			});
			await this.writeEvidenceRecord("advisor_unavailable", {
				signalDigest: "advisor-unavailable",
			});
			return {
				status: this.taskState.status,
				completionSnapshot: snapshot,
				reviewId: strictEnvelope.reviewId,
				receipt: { reviewId: strictEnvelope.reviewId, status: "rejected" as const, reason },
			};
		}

		if (receipt.status === "accepted") {
			await this.writeEvidenceRecord("advisor_review_accepted", {
				signalDigest: receipt.reviewId,
			});
		}

		return {
			status: this.taskState.status,
			completionSnapshot: snapshot,
			reviewId: strictEnvelope.reviewId,
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
		const strictVerdict =
			this.strictEvidence !== undefined ||
			["review_id", "project_id", "evidence_revision", "git_head", "diff_hash", "trigger"].some((key) =>
				Object.hasOwn(verdict, key),
			);
		const ctx = {
			taskId: this.taskState.taskId,
			contractHash: this.taskState.contractHash,
			attempt: this.taskState.attempt,
			...(strictVerdict
				? {
						reviewId: this.taskState.activeReviewId ?? "",
						projectId: this.taskState.projectId,
						evidenceRevision: this.taskState.evidenceRevision,
						gitHead: this.taskState.gitHead,
						diffHash: this.taskState.diffHash,
						trigger: "compliance_review" as const,
					}
				: {}),
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
		if (this.taskState.activeReviewId) {
			await this.scheduler.handleLifecycle({
				type: "advisor_run_completed",
				reviewId: this.taskState.activeReviewId,
				trigger: "compliance_review",
				priority: 100,
				primarySessionId: this.reviewDeps.sessionId(),
				advisorSessionId: "advisor",
				timestamp: new Date().toISOString(),
				verdictSubmitted: true,
			});
		}

		// Step 3: Map parsed verdict to state machine transitions
		const isPass = parsed.status === "pass";
		const findings = parsed.findings as ComplianceFinding[];

		if (isPass) {
			const currentGit = gitContext(this.repoRoot);
			const evidence = this.collector.collector.snapshot();
			let currentEvidenceRevision: string;
			try {
				currentEvidenceRevision = this.validateStrictEvidence(
					currentGit,
					buildCompletionSnapshot(
						this.taskState,
						this.contract as ComplianceContract,
						evidence,
						this.taskState.worktreeFingerprint,
						{ summary: "pass revalidation" },
					),
				);
			} catch {
				return { accepted: false, reason: "Completion evidence validation failed before pass" };
			}
			const latestVerifications = new Map(evidence.verifications.map((item) => [item.command, item]));
			const verificationPassed =
				this.strictEvidence === undefined ||
				(latestVerifications.size > 0 && [...latestVerifications.values()].every((item) => item.passed));
			const delegationPassed =
				this.strictEvidence === undefined ||
				!this.contract?.policy.requiresSubagentDelegation ||
				evidence.subagentDelegations.some((item) => item.status === "completed" && item.exitCode === 0);
			const envelopePersisted =
				this.activeEnvelope !== undefined &&
				this.activeEnvelope.reviewId === this.taskState.activeReviewId &&
				this.activeEnvelope.envelopeHash.length === 71;
			if (
				currentGit.gitHead !== this.taskState.gitHead ||
				currentGit.diffHash !== this.taskState.diffHash ||
				currentEvidenceRevision !== this.taskState.evidenceRevision ||
				!verificationPassed ||
				!delegationPassed ||
				!envelopePersisted
			) {
				return { accepted: false, reason: "Completion evidence or Git context changed before pass" };
			}
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

	async handleAdvisorLifecycle(event: AdvisorReviewLifecycleEvent): Promise<void> {
		await this.scheduler.handleLifecycle(event);
		if (!this.taskState || event.reviewId !== this.taskState.activeReviewId) return;
		if (
			event.type === "advisor_run_failed" ||
			event.type === "advisor_run_cancelled" ||
			(event.type === "advisor_run_completed" && !event.verdictSubmitted)
		) {
			this.taskState = transition(this.taskState, {
				type: "review_failed",
				reviewId: event.reviewId,
				reason: event.type === "advisor_run_completed" ? "no_verdict" : event.type,
			});
		}
	}

	async retryDueReviews(): Promise<void> {
		await this.scheduler.pump();
	}

	overrideCompletion(reason: string): TaskState {
		if (!this.taskState) throw new Error("No active compliance task");
		if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2048) {
			throw new Error("Override reason must be bounded and non-empty");
		}
		this.taskState = transition(this.taskState, { type: "override", actor: "user", reason: reason.trim() });
		return this.taskState;
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
	private validateStrictEvidence(
		currentGit: { gitHead: string; diffHash: `sha256:${string}` },
		snapshot: CompletionSnapshot,
	): string {
		if (!this.strictEvidence) {
			return sha256(JSON.stringify([this.taskState?.attempt ?? 0, this.collector.collector.snapshot()]));
		}
		const evidence = this.strictEvidence();
		const contract = validateTaskContractIntegrity(evidence.taskContract);
		if (
			!this.taskState ||
			contract.taskId !== this.taskState.taskId ||
			contract.projectId !== this.taskState.projectId ||
			contract.contractHash !== this.taskState.contractHash ||
			contract.gitHead !== currentGit.gitHead
		) {
			throw new Error("TaskContract context mismatch");
		}
		const packErrors = validateCodebasePack(evidence.codebasePack, evidence.codebaseContext);
		if (packErrors.length > 0 || evidence.codebasePack.diffHash !== currentGit.diffHash) {
			throw new Error(`Codebase Evidence Pack rejected: ${packErrors.join(",")}`);
		}
		if (snapshot.verifications.length === 0) throw new Error("Verification Tool Result missing");
		if (contract.delegationRequired && !evidence.delegations.some(delegationSatisfiesGate)) {
			throw new Error("Trusted delegation Gate is insufficient");
		}
		return evidence.codebasePack.evidenceRevision;
	}

	private async writeEvidenceRecord(
		event: string,
		extra: Partial<EvidenceRecord> & { reviewEnvelope?: ReviewEnvelope },
	): Promise<void> {
		if (!this.taskState || !this.contract) {
			return;
		}

		const record: EvidenceRecord & { reviewEnvelope?: ReviewEnvelope } = {
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
			...(extra.reviewEnvelope ? { reviewEnvelope: extra.reviewEnvelope } : {}),
		};

		await this.evidenceStore.append(record);
	}
}
