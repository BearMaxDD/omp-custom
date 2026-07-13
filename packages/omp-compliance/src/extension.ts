import { join } from "node:path";
import { createComplianceAdvisorHook } from "./advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry } from "./advisor/review-envelope";
import type { ComplianceReviewDependencies } from "./advisor/review-envelope";
import { registerComplianceCommand } from "./commands/compliance-command";
import { EvidenceStore } from "./evidence/evidence-store";
import { ComplianceRuntime } from "./runtime/compliance-runtime";
import { CollectorRuntime } from "./signals/collector-runtime";
import { registerComplianceCompleteTool } from "./tools/compliance-complete-tool";
import type { AdvisorBeforeRunEvent, ExtensionAPI, ExtensionContext } from "./types";
import { BrainstormReviewRegistry } from "./brainstorm/review-registry";
import { TopicStore } from "./brainstorm/topic-store";
import { TopicCoordinator } from "./brainstorm/topic-coordinator";
import { createBrainstormAdvisorHook } from "./brainstorm/advisor-hook";
import { BrainstormRuntime } from "./brainstorm/brainstorm-runtime";
import type { BrainstormTopicReadyInput } from "./brainstorm/types";
import { validateTopicReadyInput } from "./brainstorm/topic-ready-tool";
import { validateDecisionInput } from "./brainstorm/decision-tool";

/** Default compliance store directory within the repo. */
const DEFAULT_COMPLIANCE_DIR = ".omp/compliance";

/**
 * Create a memoized EvidenceStore factory.
 * Only instantiates the store (and creates the directory) when first called.
 */
function createLazyEvidenceStore(repoRoot: string): () => EvidenceStore {
	let store: EvidenceStore | null = null;
	return () => {
		if (!store) {
			store = new EvidenceStore(join(repoRoot, DEFAULT_COMPLIANCE_DIR));
		}
		return store;
	};
}

/**
 * Create a memoized Brainstorm infrastructure factory.
 * Only instantiates TopicStore and TopicCoordinator when first called.
 * TopicStore constructor creates directories, so activation must stay
 * zero-side-effect until the first brainstorm operation.
 */
function createLazyBrainstormInfra(repoRoot: string): () => { coordinator: TopicCoordinator; store: TopicStore } {
	let infra: { coordinator: TopicCoordinator; store: TopicStore } | null = null;
	return () => {
		if (!infra) {
			const store = new TopicStore(join(repoRoot, ".omp/compliance/brainstorm"));
			infra = { coordinator: new TopicCoordinator(store), store };
		}
		return infra;
	};
}

/**
 * Activate the OMP Compliance extension.
 *
 * Wires both compliance and brainstorm runtimes, registers commands
 * and tools, and sets up passive event handlers. Both subsystems use
 * lazy initialization to avoid creating directories on activation.
 *
 * Does NOT create the evidence store or topic store directories on
 * activation — they are created lazily on first operation.
 */
export default function activate(api: ExtensionAPI): void {
	// Repo root: conventions assume cwd is repo root at activation
	const repoRoot = process.cwd();

	// ── Core infrastructure (all lazy — no FS side-effects yet) ──
	const collector = new CollectorRuntime();
	const getEvidenceStore = createLazyEvidenceStore(repoRoot);
	const getBrainstormInfra = createLazyBrainstormInfra(repoRoot);

	// ── Review registries (pure in-memory — no side effects) ──
	const registry = new ComplianceReviewRegistry();
	const brainstormRegistry = new BrainstormReviewRegistry();

	// ── Session tracking ──
	let sessionId: string | null = null;
	api.on("session_start", (_event: unknown, context: ExtensionContext) => {
		sessionId = context.sessionManager.getSessionId();
	});
	api.on("session_switch", (_event: unknown, context: ExtensionContext) => {
		sessionId = context.sessionManager.getSessionId();
	});

	// ── Compliance deps ──
	const reviewDeps: ComplianceReviewDependencies = {
		sessionId: () => {
			if (!sessionId) throw new Error("Compliance: no session binding — session_start not yet received");
			return sessionId;
		},
		registry,
		requestAdvisorReview: (request) => api.requestAdvisorReview(request),
	};

	// Compliance runtime — the main coordinator (gets factory, not store)
	const runtime = new ComplianceRuntime(getEvidenceStore, collector, api, repoRoot, reviewDeps);

	// ── Brainstorm advisor_hook sendMessage adapter ──
	// The brainstorm hook expects a flat object (customType/content/display/attribution),
	// while api.sendMessage expects CustomMessagePayload (type/data). Wrap to bridge.
	const brainstormSendMessage = (
		msg: { customType: string; content: string; display: boolean; attribution: string; details?: unknown },
		options?: { deliverAs?: string; triggerTurn?: boolean },
	): void => {
		api.sendMessage(
			{ type: msg.customType, data: { content: msg.content, display: msg.display, attribution: msg.attribution, details: msg.details } },
			{ deliverAs: options?.deliverAs as "steer" | "followUp" | "nextTurn" | undefined, triggerTurn: options?.triggerTurn },
		);
	};

	// ── Single advisor_before_run handler (short-circuit: compliance || brainstorm) ──
	api.on("advisor_before_run", (event: unknown, _context: ExtensionContext) => {
		const e = event as AdvisorBeforeRunEvent;
		return (
			createComplianceAdvisorHook(registry, runtime)(e) ??
			createBrainstormAdvisorHook(brainstormRegistry, getBrainstormInfra().coordinator, brainstormSendMessage)(e)
		);
	});

	// ── Register compliance command and tool ──
	registerComplianceCommand(api, runtime);
	registerComplianceCompleteTool(api, runtime);

	// ── Register brainstorm command and tools (lazy — no FS side effects) ──
	// TopicStore + TopicCoordinator only created on first actual use via getBrainstormInfra()
	const getCoordinator = () => getBrainstormInfra().coordinator;
	api.registerCommand("brainstorm", {
		description: "Manage brainstorm topics (status, history, retry, park)",
		getArgumentCompletions: () => ["status", "history", "retry", "park"],
		handler: async (args: string[]) => {
			const coordinator = getCoordinator();
			const sub = args[0];
			if (sub === "status") {
				const topic = coordinator.current();
				if (!topic) { console.log("No active brainstorm topic."); return; }
				console.log("=".repeat(50));
				console.log("Brainstorm 专题状态");
				console.log("=".repeat(50));
				console.log(`专题 ID:   ${topic.topicId}`);
				console.log(`标题:      ${topic.input.title}`);
				console.log(`类别:      ${topic.input.topic_kind}`);
				console.log(`状态:      ${topic.status}`);
				console.log(`尝试次数:  ${topic.attempt}`);
				if (topic.decision) {
					console.log(`决定:      ${topic.decision.decision}`);
					console.log(`理由:      ${topic.decision.rationale ?? "(无)"}`);
				}
				console.log("-".repeat(50));
			} else if (sub === "history") {
				if (!args[1]) { console.log("Usage: /brainstorm history <topic_id>"); return; }
				const events = await coordinator.getTopicEvents(args[1]);
				for (const ev of events) {
					const ts = (ev as Record<string, unknown>).ts ?? "?";
					const eventName = (ev as Record<string, unknown>).event ?? "?";
					console.log(`[${ts}] ${eventName} — ${ev.topicId}`);
				}
			} else if (sub === "retry") {
				if (!args[1]) { console.log("Usage: /brainstorm retry <topic_id>"); return; }
				const topicId = args[1];
				const topic = coordinator.current();
				if (!topic || topic.topicId !== topicId) { console.log("Topic not found."); return; }
				if (topic.status !== "review_unavailable") { console.log("Cannot retry: topic is not in review_unavailable status."); return; }
				if (!topic.review) {
					await coordinator.acceptReview({
						schema_version: 1,
						topic_id: topicId,
						input_hash: topic.inputHash,
						status: "insufficient_evidence",
						summary: "Retry placeholder review",
						findings: [],
						alternatives: [],
						recommendation: "Retry placeholder",
						confidence: "low",
					});
				} else {
					await coordinator.acceptReview(topic.review);
				}
				await coordinator.recordDecision(topicId, {
					topic_id: topicId,
					decision: "reopen",
					rationale: "User requested advisor review retry",
					ts: new Date().toISOString(),
				});
				console.log(`Topic "${topicId}" reopened for drafting.`);
			} else if (sub === "park") {
				if (!args[1]) { console.log("Usage: /brainstorm park <topic_id>"); return; }
				const topicId = args[1];
				const topic = coordinator.current();
				if (!topic || topic.topicId !== topicId) { console.log("Topic not found."); return; }
				if (topic.status !== "awaiting_user_decision") { console.log("Cannot park: topic must be awaiting user decision."); return; }
				await coordinator.recordDecision(topicId, {
					topic_id: topicId,
					decision: "park",
					rationale: "User parked topic",
					ts: new Date().toISOString(),
				});
				console.log(`Topic "${topicId}" parked.`);
			} else {
				console.log("Unknown subcommand. Use: status, history <id>, retry <id>, park <id>");
			}
		},
	});
	api.registerTool({
		name: "brainstorm_topic_ready",
		description:
			"Submit a substantive brainstorm topic for independent advisor review. " +
			"Call only when the conversation has converged on a well-formed candidate decision.",
		parameters: {
			type: "object",
			properties: {
				topic_kind: { type: "string", enum: ["architecture", "scope", "contract", "migration", "risk", "implementation_route"], description: "The category of the brainstorm topic." },
				title: { type: "string", maxLength: 200, description: "Short descriptive title." },
				candidate_decision: { type: "string", maxLength: 4_000, description: "The main conclusion the brainstorm has converged on." },
				constraints: { type: "array", items: { type: "string" }, maxItems: 30, description: "Constraints bounding the decision." },
				success_criteria: { type: "array", items: { type: "string" }, maxItems: 30, description: "Success criteria the decision must meet." },
				codebase_relevance: { type: "string", enum: ["required", "optional", "none"], description: "Whether codebase context is needed for the advisor review." },
				discussion_summary: { type: "string", maxLength: 8_000, description: "Free-text summary of prior discussion." },
				unresolved_questions: { type: "array", items: { type: "string" }, maxItems: 30, description: "Open questions for the advisor." },
			},
			required: ["topic_kind", "title", "candidate_decision", "constraints", "success_criteria", "codebase_relevance", "discussion_summary"],
		},
		handler: async (params: Record<string, unknown>) => {
			const { coordinator } = getBrainstormInfra();
			const runtime = new BrainstormRuntime({
				api: { requestAdvisorReview: (request) => api.requestAdvisorReview(request) },
				collector,
				coordinator,
				registry: brainstormRegistry,
				requestAdvisorReview: (request) => api.requestAdvisorReview(request),
				getAllTools: () => [] as readonly string[],
				sessionId: () => sessionId ?? "unknown",
			});
			const errors = validateTopicReadyInput(params);
			if (errors.length > 0) return { ok: false, errors };
			try {
				const input = params as unknown as BrainstormTopicReadyInput;
				const result = await runtime.submitTopic(input);
				return { ok: true, result };
			} catch (err) {
				return { ok: false, errors: [{ field: "_handler", message: `submitTopic failed: ${(err as Error).message}` }] };
			}
		},
	});
	api.registerTool({
		name: "brainstorm_decision",
		description: "Record the user's final decision on a brainstorm topic.",
		parameters: {
			type: "object",
			properties: {
				topic_id: { type: "string", description: "The topic ID to record the decision for." },
				decision: { type: "string", enum: ["accept_candidate", "accept_alternative", "reopen", "park"], description: "The user's decision." },
				selected_alternative: { type: "string", description: "Required when decision is 'accept_alternative'." },
				rationale: { type: "string", maxLength: 4_000, description: "Optional rationale for the decision." },
				user_confirmed: { type: "boolean", description: "Must be true to confirm the decision." },
			},
			required: ["topic_id", "decision", "user_confirmed"],
		},
		handler: async (params: Record<string, unknown>) => {
			const { coordinator } = getBrainstormInfra();
			const errors = validateDecisionInput(params);
			if (errors.length > 0) return { ok: false, errors };
			const decision = {
				topic_id: params.topic_id as string,
				decision: params.decision as string,
				selected_alternative: params.selected_alternative as string | undefined,
				rationale: params.rationale as string | undefined,
				user_confirmed: params.user_confirmed === true,
			};
			try {
				const result = await coordinator.recordDecision(decision.topic_id, decision as never);
				return { ok: true, result };
			} catch (err) {
				return { ok: false, errors: [{ field: "_handler", message: `decision failed: ${(err as Error).message}` }] };
			}
		},
	});

	// ── Passive event handlers ──
	api.on("tool_call", (event) => collector.recordToolCall(event as Record<string, unknown>));
	api.on("tool_result", (event) => collector.recordToolResult(event as Record<string, unknown>));
	api.on("turn_end", (event) => collector.recordTurnEnd(event as Record<string, unknown>));
	api.on("agent_end", () => collector.refreshPresentation());
}
