import { execFileSync } from "node:child_process";
/**
 * Compliance Runtime — coordinates completion gate, state machine,
 * evidence store, signal collection, and remediation injection.
 *
 * Provides the high-level API that commands and tools call:
 *  - start/stop/resume lifecycle
 *  - requestCompletion → snapshot → advisor_reviewing
 *  - acceptVerdict → completed | remediation_required (+ injection)
 *  - resumeAfterRemediation
 */
import { createHash } from "node:crypto";
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
import { prepareVerdict } from "../advisor/verdict-sink";
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

function sha256(value: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function readAuthoritativeGitContext(root: string): { gitHead: string; diffHash: `sha256:${string}` } {
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
		})
			.split("\n")
			.filter((line) => line.length > 0 && !line.slice(3).replace(/^"|"$/g, "").startsWith(".omp/"))
			.join("\n");
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
			.filter((path) => !path.startsWith(".omp/"))
			.sort();
		const untrackedDigest = untracked.map((path) => [path, sha256(readFileSync(join(root, path), "utf8"))]);
		return { gitHead, diffHash: sha256(JSON.stringify([diff, trackedDiff, untrackedDigest])) };
	} catch (error) {
		throw new Error("Authoritative Git context is unavailable", { cause: error });
	}
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

export interface ComplianceRuntimeDependencies {
	readonly scheduler: ReviewScheduler;
	readonly strictEvidence: () => StrictCompletionEvidence;
	readonly gitContext: () => { gitHead: string; diffHash: `sha256:${string}` };
	readonly readEnvelope: (taskId: string, reviewId: string) => Promise<ReviewEnvelope | undefined>;
	readonly receiptFor: (reviewId: string) => AdvisorReviewReceipt | undefined;
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
	private readonly strictEvidence: () => StrictCompletionEvidence;
	private readonly authoritativeGit: () => { gitHead: string; diffHash: `sha256:${string}` };
	private readonly authoritativeEnvelope: (taskId: string, reviewId: string) => Promise<ReviewEnvelope | undefined>;
	private readonly receiptFor: (reviewId: string) => AdvisorReviewReceipt | undefined;
	private activeEnvelope: ReviewEnvelope | undefined;
	private schedulerRestored = false;
	private verdictCommitInProgress = false;

	constructor(
		private readonly getEvidenceStore: () => EvidenceStore,
		private readonly collector: CollectorRuntime,
		private readonly api: ComplianceRuntimeHost,
		private readonly repoRoot: string,
		private readonly reviewDeps: ComplianceReviewDependencies,
		dependencies: ComplianceRuntimeDependencies,
	) {
		if (
			!dependencies ||
			!(dependencies.scheduler instanceof ReviewScheduler) ||
			typeof dependencies.strictEvidence !== "function" ||
			typeof dependencies.gitContext !== "function" ||
			typeof dependencies.readEnvelope !== "function" ||
			typeof dependencies.receiptFor !== "function"
		) {
			throw new Error("Strict authoritative providers and injected Scheduler are required");
		}
		this.scheduler = dependencies.scheduler;
		this.strictEvidence = dependencies.strictEvidence;
		this.authoritativeGit = dependencies.gitContext;
		this.authoritativeEnvelope = dependencies.readEnvelope;
		this.receiptFor = dependencies.receiptFor;
	}

	private async syncInitialSchedulerReceipt(reviewId: string): Promise<AdvisorReviewReceipt> {
		const receipt = this.receiptFor(reviewId);
		const inFlight = this.scheduler.snapshot().inFlight;
		if (receipt?.status === "accepted" && inFlight?.reviewId === reviewId && this.taskState) {
			this.taskState = transition(this.taskState, { type: "advisor_accepted", reviewId });
			return receipt;
		}
		if (this.taskState) {
			this.taskState = transition(this.taskState, {
				type: "review_failed",
				reviewId,
				reason: "Advisor request rejected or unavailable",
			});
		}
		return receipt ?? { status: "rejected", reviewId, reason: "Advisor request rejected or unavailable" };
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
		if (!this.schedulerRestored) {
			await this.scheduler.restore();
			this.schedulerRestored = true;
		}
		const resolvedTddPath = tddPath.startsWith("/") ? tddPath : join(this.repoRoot, tddPath);
		const contract = loadComplianceContract(resolvedTddPath, this.repoRoot);
		const strictContract = validateTaskContractIntegrity(this.strictEvidence().taskContract);
		if (strictContract.contractHash !== contract.contractHash) {
			throw new Error("TaskContract does not match the loaded TDD contract");
		}
		const taskId = strictContract.taskId;
		const now = new Date().toISOString();
		const seedFingerprint = `initial-${Date.now()}`;
		const currentGit = this.authoritativeGit();

		const state: TaskState = {
			taskId,
			projectId: strictContract.projectId,
			status: "active",
			attempt: 1,
			contractHash: contract.contractHash,
			evidenceRevision: sha256("initial"),
			gitHead: strictContract.gitHead,
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

		if (snapshot.verifications.length === 0) {
			throw new Error("Completion Gate requires a real verification Tool Result");
		}
		const currentGit = this.authoritativeGit();
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
			projectId: strictEnvelope.projectId,
			contractHash: strictEnvelope.contractHash as `sha256:${string}`,
			evidenceRevision: strictEnvelope.evidenceRevision,
			gitHead: strictEnvelope.gitHead,
			diffHash: strictEnvelope.diffHash,
			trigger: strictEnvelope.trigger,
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
			receipt = await this.syncInitialSchedulerReceipt(strictEnvelope.reviewId);
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
		if (this.verdictCommitInProgress) {
			return { accepted: false, reason: "A verdict commit is already in progress" };
		}
		this.verdictCommitInProgress = true;
		try {
			return await this.acceptVerdictExclusive(verdict);
		} finally {
			this.verdictCommitInProgress = false;
		}
	}

	private async acceptVerdictExclusive(
		verdict: Record<string, unknown>,
	): Promise<{ accepted: boolean; reason?: string }> {
		if (!this.taskState) {
			return { accepted: false, reason: "No active compliance task" };
		}
		if (
			!this.taskState.activeReviewId ||
			!this.activeEnvelope ||
			this.activeEnvelope.reviewId !== this.taskState.activeReviewId
		) {
			return { accepted: false, reason: "No matching active Advisor review" };
		}
		// Schema and identity are always strict in v17.
		const ctx = {
			taskId: this.taskState.taskId,
			contractHash: this.taskState.contractHash,
			attempt: this.taskState.attempt,
			reviewId: this.taskState.activeReviewId,
			projectId: this.taskState.projectId,
			evidenceRevision: this.taskState.evidenceRevision,
			gitHead: this.taskState.gitHead,
			diffHash: this.taskState.diffHash,
			trigger: "compliance_review" as const,
		};
		if (this.taskState.status !== "advisor_reviewing") {
			if (this.taskState.status === "completed" || this.taskState.status === "remediation_required") {
				try {
					const parsedTerminalVerdict = parseVerdict(verdict, ctx);
					const terminal = prepareVerdict(verdict, ctx, this.verdictStore, parsedTerminalVerdict);
					return {
						accepted: false,
						reason: terminal.status === "rejected" ? terminal.reason : "Advisor review is already finalized",
					};
				} catch (error) {
					return {
						accepted: false,
						reason: error instanceof Error ? error.message : "Advisor review is already finalized",
					};
				}
			}
			return { accepted: false, reason: "No matching active Advisor review" };
		}
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

		// Prepare performs duplicate/conflict checks without consuming the verdict.
		const prepared = prepareVerdict(verdict, ctx, this.verdictStore, parsed);
		if (prepared.status !== "prepared") {
			if (prepared.protocolError && this.taskState.status === "advisor_reviewing") {
				this.taskState = transition(this.taskState, {
					type: "protocol_error",
					error: prepared.reason,
				});
			}
			return { accepted: false, reason: prepared.reason };
		}
		// Step 3: Map parsed verdict to state machine transitions
		const isPass = parsed.status === "pass";
		const findings = parsed.findings as ComplianceFinding[];

		if (isPass) {
			let currentGit: { gitHead: string; diffHash: `sha256:${string}` };
			try {
				currentGit = this.authoritativeGit();
			} catch {
				return { accepted: false, reason: "Authoritative Git context is unavailable" };
			}
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
				latestVerifications.size > 0 && [...latestVerifications.values()].every((item) => item.passed);
			const strictEvidence = this.strictEvidence();
			const delegationPassed =
				!this.contract?.policy.requiresSubagentDelegation || strictEvidence.delegations.some(delegationSatisfiesGate);
			const persistedEnvelope = await this.authoritativeEnvelope(this.taskState.taskId, this.taskState.activeReviewId);
			const envelopePersisted = this.persistedEnvelopeMatches(persistedEnvelope, this.activeEnvelope);
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
			const nextState = transition(this.taskState, {
				type: "verdict",
				status: "pass",
				summary: findings.length > 0 ? findings[0].reason : undefined,
				schemaValid: true,
			});
			const committed = prepared.commit();
			if (committed.status !== "accepted") return { accepted: false, reason: committed.reason };
			try {
				await this.commitAdvisorLifecycle();
				await this.writeEvidenceRecord("completed", {
					signalDigest: "advisor-pass",
					verdictSummary: findings.length > 0 ? findings[0].reason : undefined,
				});
				this.taskState = nextState;
			} catch (error) {
				prepared.rollback();
				await this.compensateAdvisorLifecycle();
				throw error;
			}
			await this.scheduler.pump();
			return { accepted: true };
		}

		// Status is "remediate" — extract required fixes from findings
		const fixes = findings
			.filter((f): f is ComplianceFinding & { required_fix: string } => !!f.required_fix)
			.map((f) => f.required_fix);

		const nextState = transition(this.taskState, {
			type: "verdict",
			status: "remediation_required",
			summary: findings.length > 0 ? findings[0].reason : undefined,
			requiredFixes: fixes,
			schemaValid: true,
		});

		const committed = prepared.commit();
		if (committed.status !== "accepted") return { accepted: false, reason: committed.reason };
		try {
			await this.commitAdvisorLifecycle();
			await this.writeEvidenceRecord("remediation_required", {
				signalDigest: "advisor-remediate",
				verdictSummary: findings.length > 0 ? findings[0].reason : undefined,
			});
			this.taskState = nextState;
		} catch (error) {
			prepared.rollback();
			await this.compensateAdvisorLifecycle();
			throw error;
		}
		await this.scheduler.pump();

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
		if (this.taskState?.status !== "stalled" || !this.activeEnvelope) return;
		const queued = this.scheduler.nextDueIntent(this.activeEnvelope.taskId, "compliance_review");
		if (!queued) return;
		const reviewAttempt = Math.min(queued.attempt + 1, Number.MAX_SAFE_INTEGER);
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
			reviewAttempt,
		);
		const expectedReviewId = `review:${queued.dedupeKey.slice("sha256:".length)}:${reviewAttempt}`;
		if (retryEnvelope.reviewId !== expectedReviewId) throw new Error("Scheduler retry identity mismatch");
		await this.writeEvidenceRecord("completion_retry", {
			signalDigest: retryEnvelope.envelopeHash,
			reviewEnvelope: retryEnvelope,
		});
		const previousReviewId = this.activeEnvelope.reviewId;
		this.activeEnvelope = retryEnvelope;
		this.taskState = transition(this.taskState, { type: "retry", reviewId: retryEnvelope.reviewId });
		const previous = this.reviewDeps.registry.get(previousReviewId);
		if (previous) {
			this.reviewDeps.registry.put(
				Object.freeze({ ...previous, reviewId: retryEnvelope.reviewId, createdAt: retryEnvelope.createdAt }),
			);
		}
		await this.scheduler.pump();
		const receipt = this.receiptFor(retryEnvelope.reviewId);
		if (receipt?.status !== "accepted" || this.scheduler.snapshot().inFlight?.reviewId !== retryEnvelope.reviewId) {
			this.taskState = transition(this.taskState, {
				type: "review_failed",
				reviewId: retryEnvelope.reviewId,
				reason: receipt?.reason ?? "Scheduler did not dispatch the prepared retry Envelope",
			});
			return;
		}
		this.taskState = transition(this.taskState, { type: "advisor_accepted", reviewId: retryEnvelope.reviewId });
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
		return sha256(
			JSON.stringify({
				codebasePackRevision: evidence.codebasePack.evidenceRevision,
				attempt: snapshot.attempt,
				codebaseMemory: snapshot.codebaseMemory,
				verifications: snapshot.verifications,
				delegations: snapshot.delegations,
				diffFingerprint: snapshot.diffFingerprint,
				remediation: snapshot.remediation,
				evidenceFacts: snapshot.evidenceFacts,
			}),
		);
	}

	private persistedEnvelopeMatches(persisted: ReviewEnvelope | undefined, active: ReviewEnvelope | undefined): boolean {
		if (!persisted || !active) return false;
		const reviewAttempt = Number(persisted.reviewId.slice(persisted.reviewId.lastIndexOf(":") + 1));
		try {
			const reconstructed = createReviewEnvelope(
				{
					taskId: persisted.taskId,
					projectId: persisted.projectId,
					contractHash: persisted.contractHash,
					evidenceRevision: persisted.evidenceRevision,
					gitHead: persisted.gitHead,
					diffHash: persisted.diffHash,
					attempt: persisted.attempt,
					trigger: persisted.trigger,
					createdAt: persisted.createdAt,
				},
				reviewAttempt,
			);
			return (
				reconstructed.reviewId === persisted.reviewId &&
				reconstructed.envelopeHash === persisted.envelopeHash &&
				persisted.reviewId === active.reviewId &&
				persisted.envelopeHash === active.envelopeHash
			);
		} catch {
			return false;
		}
	}

	private async commitAdvisorLifecycle(): Promise<void> {
		if (!this.taskState?.activeReviewId) throw new Error("No active review to commit");
		await this.scheduler.handleLifecycle(
			{
				type: "advisor_run_completed",
				reviewId: this.taskState.activeReviewId,
				trigger: "compliance_review",
				priority: 100,
				primarySessionId: this.reviewDeps.sessionId(),
				advisorSessionId: "advisor",
				timestamp: new Date().toISOString(),
				verdictSubmitted: true,
			},
			false,
		);
	}

	private async compensateAdvisorLifecycle(): Promise<void> {
		const reviewId = this.taskState?.activeReviewId;
		if (!reviewId) return;
		const schedulerState = this.scheduler.snapshot();
		if (schedulerState.completed.some((intent) => intent.reviewId === reviewId)) {
			await this.scheduler.restoreCompleted(reviewId);
		}
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
