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
import type { ExtensionAPI } from "../types";
import type { EvidenceStore, EvidenceRecord } from "../evidence/evidence-store";
import { computeFingerprint } from "../evidence/fingerprint";
import { loadComplianceContract } from "../contract/load-contract";
import type { ComplianceContract } from "../contract/types";
import type { CollectorRuntime } from "../signals/collector-runtime";
import type { EvidenceSnapshot } from "../signals/types";
import { transition } from "../state/task-state-machine";
import type { ComplianceVerdict, TaskState } from "../state/types";
import type { CompletionSnapshot } from "./completion-gate";
import { buildCompletionSnapshot } from "./completion-gate";
import { injectRemediation } from "../remediation/inject-required-fix";
import type { RemediationFinding } from "../remediation/inject-required-fix";

// ─── Transient task state key for evidence store isolation ──────────

const TASK_STATE_KEY = "_runtime_task_state";

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

	constructor(
		private readonly store: EvidenceStore,
		private readonly collector: CollectorRuntime,
		private readonly api: ExtensionAPI,
		private readonly repoRoot: string,
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
		const resolvedTddPath = tddPath.startsWith("/")
			? tddPath
			: join(this.repoRoot, tddPath);
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
				type: "compliance_managed",
				data: {
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
	}): Promise<{ status: string; completionSnapshot: CompletionSnapshot }> {
		if (!this.taskState) {
			throw new Error("No active compliance task");
		}
		if (this.taskState.status !== "active") {
			throw new Error(
				`Cannot request completion from status: ${this.taskState.status}`,
			);
		}
		const activeContract = this.contract;
		if (!activeContract) {
			throw new Error("No contract loaded for compliance task");
		}

		const newState = transition(this.taskState, { type: "completion_requested" });
		this.taskState = newState;

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

		await this.writeEvidenceRecord("completion_requested", {
			signalDigest: snapshot.diffFingerprint,
		});

		return { status: newState.status, completionSnapshot: snapshot };
	}

	/**
	 * Accept a verdict from the Advisor and apply it to the task state.
	 *
	 * On "pass": transitions to completed (terminal).
	 * On "remediation_required": transitions to remediation_required and
	 *   injects a structured fix message to the main agent.
	 *
	 * Invalid verdicts (empty requiredFixes, schema failure, task mismatch)
	 * keep the task in advisor_reviewing and do NOT inject any message.
	 *
	 * @param verdict — the Advisor's ComplianceVerdict
	 */
	async acceptVerdict(verdict: ComplianceVerdict): Promise<void> {
		if (!this.taskState) {
			return;
		}

		// Schema invalid → stay in advisor_reviewing, no injection
		if (!verdict.schemaValid) {
			this.taskState = transition(this.taskState, {
				type: "protocol_error",
				error: "Schema validation failed — verdict rejected",
			});
			return;
		}

		if (verdict.status === "pass") {
			this.taskState = transition(this.taskState, {
				type: "verdict",
				status: "pass",
				summary: verdict.summary,
				schemaValid: true,
			});
			await this.writeEvidenceRecord("completed", {
				signalDigest: "advisor-pass",
				verdictSummary: verdict.summary,
			});
			return;
		}

		if (verdict.status === "remediation_required") {
			const fixes = verdict.requiredFixes;
			if (!fixes || fixes.length === 0) {
				// Empty remediation → stay in advisor_reviewing, no injection
				this.taskState = transition(this.taskState, {
					type: "protocol_error",
					error: "Remediation verdict requires at least one requiredFix",
				});
				return;
			}

			this.taskState = transition(this.taskState, {
				type: "verdict",
				status: "remediation_required",
				summary: verdict.summary,
				requiredFixes: fixes,
				schemaValid: true,
			});

			await this.writeEvidenceRecord("remediation_required", {
				signalDigest: "advisor-remediate",
				verdictSummary: verdict.summary,
			});

			// Only inject if not stalled
			if (this.taskState.status !== "stalled") {
				const findings: RemediationFinding[] = fixes.map((fix, i) => ({
					id: `finding-${i + 1}`,
					reason: verdict.summary ?? "Advisor identified issues requiring remediation",
					requiredFix: fix,
					evidenceRefs: [
						`evidence://${this.taskState!.taskId}`,
					],
				}));

				injectRemediation(this.api, {
					taskId: this.taskState.taskId,
					contractHash: this.taskState.contractHash,
					findings,
				});
			}
			return;
		}

		// Unknown verdict status → protocol error, no injection
		this.taskState = transition(this.taskState, {
			type: "protocol_error",
			error: `Unknown verdict status: ${verdict.status}`,
		});
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
			throw new Error(
				`Cannot resume from status: ${this.taskState.status}`,
			);
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

	// ─── Private helpers ───────────────────────────────────────────

	private async writeEvidenceRecord(
		event: string,
		extra: Partial<EvidenceRecord>,
	): Promise<void> {
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

		await this.store.append(record);
	}
}
