import { join } from "node:path";
import type {
	AdvisorBeforeRunEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
} from "@oh-my-pi/pi-coding-agent/advisor/index";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createComplianceAdvisorHook } from "./advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry } from "./advisor/review-envelope";
import type { ComplianceReviewDependencies } from "./advisor/review-envelope";
import { createBrainstormAdvisorHook } from "./brainstorm/advisor-hook";
import { BrainstormRuntime } from "./brainstorm/brainstorm-runtime";
import { createDecisionTool } from "./brainstorm/decision-tool";
import { appendBrainstormGuidance } from "./brainstorm/main-agent-guidance";
import { BrainstormReviewRegistry } from "./brainstorm/review-registry";
import { TopicCoordinator } from "./brainstorm/topic-coordinator";
import { createTopicReadyTool } from "./brainstorm/topic-ready-tool";
import { TopicStore } from "./brainstorm/topic-store";
import { registerBrainstormCommand } from "./commands/brainstorm-command";
import { registerComplianceCommand } from "./commands/compliance-command";
import { EvidenceStore } from "./evidence/evidence-store";
import { ComplianceRuntime } from "./runtime/compliance-runtime";
import { CollectorRuntime } from "./signals/collector-runtime";
import { registerComplianceCompleteTool } from "./tools/compliance-complete-tool";

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
	const requestAdvisorReview = async (request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> => {
		if (!api.requestAdvisorReview) {
			return { reviewId: request.reviewId, status: "rejected", reason: "Advisor Review Protocol is unavailable" };
		}
		return api.requestAdvisorReview(request);
	};

	// ── Session tracking ──
	let sessionId: string | null = null;
	api.on("session_start", (_event, context) => {
		sessionId = context.sessionManager.getSessionId();
	});
	api.on("session_switch", (_event, context) => {
		sessionId = context.sessionManager.getSessionId();
	});

	// ── Compliance deps ──
	const reviewDeps: ComplianceReviewDependencies = {
		sessionId: () => {
			if (!sessionId) throw new Error("Compliance: no session binding — session_start not yet received");
			return sessionId;
		},
		registry,
		requestAdvisorReview,
	};

	// Compliance runtime — the main coordinator (gets factory, not store)
	const runtime = new ComplianceRuntime(getEvidenceStore, collector, api, repoRoot, reviewDeps);

	// ── Brainstorm advisor_hook sendMessage adapter ──
	// The brainstorm hook sends flat customType/content/display/attribution/details objects;
	// pass them directly to api.sendMessage (OMP v16.4+ expects these as top-level fields).
	const brainstormSendMessage = (
		msg: { customType: string; content: string; display: boolean; attribution: string; details?: unknown },
		options?: { deliverAs?: string; triggerTurn?: boolean },
	): void => {
		api.sendMessage(
			{
				customType: msg.customType,
				content: msg.content,
				display: msg.display,
				attribution: msg.attribution as "agent" | "user",
				details: msg.details,
			},
			{
				deliverAs: options?.deliverAs as "steer" | "followUp" | "nextTurn" | undefined,
				triggerTurn: options?.triggerTurn,
			},
		);
	};

	// ── Single advisor_before_run handler (compliance first, then brainstorm) ──
	api.on("advisor_before_run", (e: AdvisorBeforeRunEvent) => {
		// Compliance hook first (no lazy init needed)
		const complianceResult = createComplianceAdvisorHook(registry, runtime)(e);
		if (complianceResult) return complianceResult;
		// Brainstorm hook — only init when compliance didn't match
		if (e.trigger === "brainstorm_review") {
			return createBrainstormAdvisorHook(
				brainstormRegistry,
				getBrainstormInfra().coordinator,
				brainstormSendMessage,
			)(e);
		}
		return undefined;
	});

	api.on("before_agent_start", (event) => appendBrainstormGuidance(event));

	// ── Register compliance command and tool ──
	registerComplianceCommand(api, runtime);
	registerComplianceCompleteTool(api, runtime);

	// ── Register brainstorm command and tools (lazy — no FS side effects) ──
	// TopicStore + TopicCoordinator only created on first actual use via getBrainstormInfra()
	const getCoordinator = () => getBrainstormInfra().coordinator;
	registerBrainstormCommand(api, getCoordinator);

	// Tool registrations — use factory createTopicReadyTool for consistent
	// validation and schema. BrainstormRuntime and coordinator are created
	// lazily at first invocation (no FS side effects at registration time).
	// The factory's handler accesses deps only when called.
	api.registerTool(
		createTopicReadyTool({
			// Runtime is created lazily — wrapped in a getter so the factory
			// only accesses it when the handler is invoked.
			get runtime(): BrainstormRuntime {
				return new BrainstormRuntime({
					api: { requestAdvisorReview },
					collector,
					coordinator: getCoordinator(),
					registry: brainstormRegistry,
					requestAdvisorReview,
					getAllTools: () => api.getAllTools() as readonly string[],
					sessionId: () => sessionId ?? "unknown",
				});
			},
			sessionId: () => sessionId ?? "unknown",
		}),
	);

	api.registerTool(
		createDecisionTool({
			get coordinator(): TopicCoordinator {
				return getCoordinator();
			},
		}),
	);

	// ── Passive event handlers ──
	api.on("tool_call", (event) => collector.recordToolCall(event as unknown as Record<string, unknown>));
	api.on("tool_result", (event) => collector.recordToolResult(event as unknown as Record<string, unknown>));
	api.on("turn_end", (event) => collector.recordTurnEnd(event as unknown as Record<string, unknown>));
	api.on("agent_end", () => collector.refreshPresentation());
}
