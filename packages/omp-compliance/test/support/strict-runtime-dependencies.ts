import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AdvisorReviewReceipt, AdvisorReviewRequest } from "@oh-my-pi/pi-coding-agent/advisor/index";
import { loadComplianceContract } from "../../src/contract/load-contract";
import { loadTaskContractFromTdd } from "../../src/contracts/task-contract";
import {
	applyDelegationEvent,
	createDelegationCompletionAttestation,
	createDelegationEvidenceVerifier,
	createDelegationRecord,
	createTrustedDelegationContext,
} from "../../src/delegation/delegation-supervisor";
import type { EvidenceStore } from "../../src/evidence/evidence-store";
import { type ComplianceRuntimeDependencies, readAuthoritativeGitContext } from "../../src/runtime/compliance-runtime";
import { JsonFileReviewSchedulerStore, ReviewScheduler } from "../../src/scheduler/review-scheduler";
import { createCodebaseEvidencePack, createTrustedCodebaseValidationContext } from "../../src/signals/codebase-memory";
import { createControlledCollectorRuntime } from "../../src/signals/collector-runtime";

const PROJECT_ID_NAMESPACE = "omp-runtime-test";

function projectIdFor(root: string): string {
	const hex = createHash("sha256").update(`${PROJECT_ID_NAMESPACE}\0${root}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function recordCodebaseEvidence(project: string, affectedFile: string) {
	const controlled = createControlledCollectorRuntime();
	const queriedAt = new Date(Date.now() + 60_000).toISOString();
	const fixtures = [
		{
			toolName: "index_status",
			id: "strict-index",
			input: { project },
			content: '{"status":"ready","revision":"strict-index-1"}',
			details: { status: "ready", revision: "strict-index-1" },
		},
		{
			toolName: "search_graph",
			id: "strict-search",
			input: { project, query: "strict.runtime.symbol" },
			content: `file:${affectedFile}`,
			details: { results: [{ qualified_name: "strict.runtime.symbol", file_path: affectedFile }] },
		},
		{
			toolName: "get_code_snippet",
			id: "strict-snippet",
			input: { project, qualified_name: "strict.runtime.symbol" },
			content: `file:${affectedFile}`,
			details: { qualified_name: "strict.runtime.symbol", file_path: affectedFile, line: 1 },
		},
		{
			toolName: "trace_path",
			id: "strict-trace",
			input: { project, function_name: "strict.runtime.symbol", direction: "outbound" },
			content: `strict.runtime.symbol -> strict.runtime.dependency file:${affectedFile}`,
			details: {
				source: "strict.runtime.symbol",
				target: "strict.runtime.dependency",
				file_path: affectedFile,
			},
		},
	] as const;
	for (const fixture of fixtures) {
		const toolName = `mcp__codebase_memory_mcp__${fixture.toolName}`;
		controlled.runtime.recordToolCall(
			{ type: "tool_call", toolName, toolCallId: fixture.id, input: fixture.input },
			undefined as never,
		);
		controlled.runtime.recordToolResult(
			{
				type: "tool_result",
				toolName,
				toolCallId: fixture.id,
				input: fixture.input,
				content: [{ type: "text", text: fixture.content }],
				isError: false,
				details: fixture.details,
			},
			undefined as never,
		);
	}
	return { controlled, queriedAt };
}

export function createStrictRuntimeDependencies(input: {
	repoRoot: string;
	tddPath?: string;
	store: EvidenceStore;
	requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
}): ComplianceRuntimeDependencies {
	const tddPath = input.tddPath ?? "tdd.md";
	const absoluteTddPath = join(input.repoRoot, tddPath);
	const complianceContract = loadComplianceContract(absoluteTddPath, input.repoRoot);
	const currentGit = readAuthoritativeGitContext(input.repoRoot);
	const affectedFiles = complianceContract.summary.files.length > 0 ? complianceContract.summary.files : [tddPath];
	const taskContract = loadTaskContractFromTdd(absoluteTddPath, input.repoRoot, {
		projectId: projectIdFor(input.repoRoot),
		gitHead: currentGit.gitHead,
		affectedFiles,
	});
	const codebaseProject = `runtime-${createHash("sha256").update(input.repoRoot).digest("hex").slice(0, 16)}`;
	const { controlled, queriedAt } = recordCodebaseEvidence(codebaseProject, affectedFiles[0]);
	const strictEvidence = () => {
		const codebaseContext = createTrustedCodebaseValidationContext(controlled.reader, {
			taskContract,
			codebaseProjectId: codebaseProject,
			currentDiffHash: readAuthoritativeGitContext(input.repoRoot).diffHash,
			indexRevision: "strict-index-1",
			queriedAt,
			changedFiles: [],
			newFiles: [],
			allowedNewFileRoots: [],
			unresolvedClaims: [],
			requiredSymbols: ["strict.runtime.symbol"],
		});
		const codebasePack = createCodebaseEvidencePack(codebaseContext);
		const delegationId = "strict-delegation";
		const toolCallId = "strict-task-tool-call";
		const toolEvidenceId = `tool-result:${toolCallId}`;
		const verifier = createDelegationEvidenceVerifier((evidenceRevision) => ({
			taskId: taskContract.taskId,
			contractHash: taskContract.contractHash,
			evidenceRevision,
			delegations: [{ delegationId, actualFiles: [affectedFiles[0]], toolEvidenceIds: [toolEvidenceId] }],
		}));
		const delegationContext = createTrustedDelegationContext(
			{ taskContract, evidenceRevision: codebasePack.evidenceRevision },
			verifier,
		);
		const queued = createDelegationRecord({
			delegationId,
			agentId: "strict-agent",
			sessionId: "strict-session",
			toolCallId,
			transport: "task",
			workPackage: "Execute the strict runtime test task",
			context: delegationContext,
		});
		const running = applyDelegationEvent(queued, { delegationId, type: "started" });
		const completed = applyDelegationEvent(
			running,
			createDelegationCompletionAttestation(delegationContext, {
				delegationId,
				originToolCallId: toolCallId,
				resultToolCallId: toolCallId,
				toolEvidenceIds: [toolEvidenceId],
			}),
		);
		return { taskContract, codebasePack, codebaseContext, delegations: [completed] };
	};
	const receipts = new Map<string, AdvisorReviewReceipt>();
	const scheduler = new ReviewScheduler({
		clock: { now: () => Date.now() },
		random: () => 0,
		store: new JsonFileReviewSchedulerStore(join(input.repoRoot, ".omp", "compliance", "review-scheduler.json")),
		requester: async (request) => {
			try {
				const hostReceipt = await input.requestAdvisorReview(request);
				const receipt = { ...hostReceipt, reviewId: request.reviewId };
				receipts.set(request.reviewId, receipt);
				return receipt;
			} catch (error) {
				receipts.set(request.reviewId, {
					status: "rejected",
					reviewId: request.reviewId,
					reason: error instanceof Error ? error.message : "Advisor request failed",
				});
				throw error;
			}
		},
	});
	return {
		scheduler,
		strictEvidence,
		gitContext: () => readAuthoritativeGitContext(input.repoRoot),
		readEnvelope: async (taskId, reviewId) => {
			const records = (await input.store.readAll(taskId)) as Array<{
				event: string;
				reviewEnvelope?: import("../../src/contracts/review-envelope").ReviewEnvelope;
			}>;
			return records.findLast(
				(record) =>
					(record.event === "completion_requested" || record.event === "completion_retry") &&
					record.reviewEnvelope?.reviewId === reviewId,
			)?.reviewEnvelope;
		},
		receiptFor: (reviewId) => receipts.get(reviewId),
	};
}
