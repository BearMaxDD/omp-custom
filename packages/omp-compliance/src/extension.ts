import { join } from "node:path";
import { createComplianceAdvisorHook } from "./advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry } from "./advisor/review-envelope";
import type { ComplianceReviewDependencies } from "./advisor/review-envelope";
import { createBrainstormAdvisorHook } from "./brainstorm/advisor-hook";
import { BrainstormRuntime } from "./brainstorm/brainstorm-runtime";
import { createDecisionTool } from "./brainstorm/decision-tool";
import { type BeforeAgentStartEvent, appendBrainstormGuidance } from "./brainstorm/main-agent-guidance";
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
import type { AdvisorBeforeRunEvent, ExtensionAPI, ExtensionContext } from "./types";
import type { AdvisorRunTrigger, TriggerEvent } from "./types";
import { TriggerRegistry } from "./triggers/registry";
import { Dispatcher } from "./triggers/dispatcher";
import { BackpressureQueue } from "./triggers/backpressure-queue";
import { createContextInjector } from "./triggers/context-injector";
import { ManualProducer } from "./triggers/producers/manual";
import { ScheduledProducer } from "./triggers/producers/scheduled";
import { FileWatchProducer } from "./triggers/producers/file-watch";
import { GitPrePushProducer } from "./triggers/producers/git-pre-push";
import { SupervisionEngine } from "./supervision/engine";
import { codeWriteDetector } from "./supervision/detectors/code-write-detector";
import { createRepeatAdviseDetector } from "./supervision/detectors/repeat-advise-detector";
import { createSlowReviewDetector } from "./supervision/detectors/slow-review-detector";
import { StatusCollector } from "./status/collector";
import { renderCLIStatus } from "./status/cli-renderer";
import { renderTUIStatus } from "./status/tui-renderer";

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

	// ── SP-2: Backpressure queue (crash-safe with WAL) ──
	const queue = new BackpressureQueue({
		maxSize: 100,
		storagePath: join(repoRoot, ".omp/compliance/queue"),
		perProducerQuota: 25,
		restartRecovery: true,
	});

	// ── SP-2: Dispatcher (dedup + drain chain) ──
	const contextInjector = createContextInjector();
	const dispatcher = new Dispatcher({
		queue,
		contextInjector,
		requestReview: (req) =>
			api.requestAdvisorReview({
				reviewId: req.reviewId,
				metadata: { ...req.metadata, trigger: req.trigger },
			}),
	});

	// ── SP-2: Trigger registry + producers ──
	const triggerRegistry = new TriggerRegistry();
	const manualProducer = new ManualProducer(true);
	const scheduledProducer = new ScheduledProducer({ intervalMs: 300_000 }, false);
	const fileWatchProducer = new FileWatchProducer({ directory: repoRoot }, false);
	const gitPrePushProducer = new GitPrePushProducer(true);

	triggerRegistry.register(manualProducer);
	triggerRegistry.register(scheduledProducer);
	triggerRegistry.register(fileWatchProducer);
	triggerRegistry.register(gitPrePushProducer);

	// Wire producers → dispatcher
	for (const producer of [manualProducer, scheduledProducer, fileWatchProducer, gitPrePushProducer]) {
		producer.on("produce", (event: unknown) => {
			dispatcher.dispatch(event as TriggerEvent).catch((err: unknown) => {
				api.logger.error(`[dispatcher] ${String(err)}`);
			});
		});
	}

	// ── Review registries (pure in-memory — no side effects) ──
	const registry = new ComplianceReviewRegistry();
	const brainstormRegistry = new BrainstormReviewRegistry();

	// ── Session tracking ──
	let sessionId: string | null = null;
	api.on("session_start", async (_event: unknown, context: ExtensionContext) => {
		sessionId = context.sessionManager.getSessionId();
		// Start auto-triggers once we have a session
		await triggerRegistry.startAll().catch((err: unknown) => {
			api.logger.error(`[triggers] startAll failed: ${String(err)}`);
		});

		// ── TUI status bar ──
		const ctx = context as unknown as { ui?: { setStatus: (s: string) => void; setFooter: (s: string) => void } };
		const ui = ctx.ui;
		if (!ui) return;
		const timer = setInterval(() => {
			const { status, footer } = renderTUIStatus(statusCollector.snapshot());
			try { ui.setStatus(status); if (footer) ui.setFooter(footer); } catch { /* harness may close session */ }
		}, 2000);
		api.on("session_stop", () => clearInterval(timer));
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

	// ── SP-2: Status collector (passive state aggregator) ──
	const statusCollector = new StatusCollector(runtime, () => {
		const state = getBrainstormInfra();
		return {
			active: false,
			topicId: state.store ? undefined : undefined,
			status: undefined,
			topicKind: undefined,
		};
	});

	// ── SP-2: Supervision engine + detectors ──
	const supervisionEngine = new SupervisionEngine({
		advise: (finding) => {
			api.logger.info(`[supervision] ${finding.detector}: ${finding.message}`);
			statusCollector.onSupervisionFinding(finding);
		},
		evidence: (finding) => {
			api.logger.debug(`[supervision/evidence] ${finding.id}: ${finding.severity}`);
			statusCollector.onSupervisionFinding(finding);
		},
	});
	supervisionEngine.register(codeWriteDetector);
	supervisionEngine.register(createRepeatAdviseDetector());
	supervisionEngine.register(createSlowReviewDetector());
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
	api.on("advisor_before_run", (event: unknown, _context: ExtensionContext) => {
		const e = event as AdvisorBeforeRunEvent;
		// Compliance hook first (no lazy init needed)
		const complianceResult = createComplianceAdvisorHook(registry, runtime)(e);
		if (complianceResult) return complianceResult;
		// Brainstorm hook — only init when compliance didn't match
		if (e.trigger === "compliance_review") {
			return createBrainstormAdvisorHook(
				brainstormRegistry,
				getBrainstormInfra().coordinator,
				brainstormSendMessage,
			)(e);
		}
		return undefined;
	});

	api.on("before_agent_start", (event: unknown) => appendBrainstormGuidance(event as BeforeAgentStartEvent));

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
					api: { requestAdvisorReview: (request) => api.requestAdvisorReview(request) },
					collector,
					coordinator: getCoordinator(),
					registry: brainstormRegistry,
					requestAdvisorReview: (request) => api.requestAdvisorReview(request),
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

	// ── SP-2: /advisor status command ──
	api.registerCommand("/advisor status", {
		description: "Show advisor status panel",
		handler: (_args: string[]) => {
			const snapshot = statusCollector.snapshot();
			const rendered = renderCLIStatus(snapshot);
			api.sendMessage({
				customType: "advisor_status",
				content: rendered,
				display: true,
				attribution: "agent",
			});
		},
	});

	// ── Passive event handlers ──
	api.on("tool_call", (event) => collector.recordToolCall(event as Record<string, unknown>));
	api.on("tool_result", (event) => collector.recordToolResult(event as Record<string, unknown>));
	api.on("turn_end", (event) => collector.recordTurnEnd(event as Record<string, unknown>));
	api.on("agent_end", () => collector.refreshPresentation());

	// ── SP-2: Status collector event listeners ──
	api.on("advisor_run_started", (event: unknown) => statusCollector.onAdvisorRunStarted(event as Record<string, unknown>));
	api.on("advisor_run_finished", () => statusCollector.onAdvisorRunFinished());
	api.on("advisor_tool_call", (event: unknown) => statusCollector.onAdvisorToolCall(event as Record<string, unknown>));
	api.on("advisor_subagent_started", (event: unknown) => statusCollector.onAdvisorSubagentEvent(event as Record<string, unknown>));

	// ── SP-2: Supervision engine — monitor tool results for advisory patterns ──
	api.on("tool_result", (event: unknown) => {
		const e = event as { toolName: string; success: boolean };
		supervisionEngine.onToolResult({ toolName: e.toolName, success: e.success });
	});
}
