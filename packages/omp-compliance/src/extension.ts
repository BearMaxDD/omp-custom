import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
	AdvisorBeforeRunEvent,
	AdvisorReviewCapabilities,
	AdvisorReviewLifecycleEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
	AdvisorRunAugmentation,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	SessionStartEvent,
	SessionSwitchEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { assertAdvisorProtocolV1 } from "./activation/capability-negotiation";
import { createComplianceAdvisorHook } from "./advisor/compliance-advisor-hook";
import { type ComplianceReviewDependencies, ComplianceReviewRegistry } from "./advisor/review-envelope";
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
import { deterministicEvidenceEventId } from "./evidence/event-log";
import { EvidenceRepository } from "./evidence/evidence-repository";
import { EvidenceStore } from "./evidence/evidence-store";
import { ProjectIdentityStore } from "./project/project-identity";
import { ComplianceRuntime, readAuthoritativeGitContext } from "./runtime/compliance-runtime";
import { type CanonicalBuiltinToolIdentity, type CanonicalToolCall, PreToolPolicy } from "./runtime/pre-tool-policy";
import { JsonFileReviewSchedulerStore, ReviewScheduler } from "./scheduler/review-scheduler";
import { CollectorRuntime } from "./signals/collector-runtime";
import { registerComplianceCompleteTool } from "./tools/compliance-complete-tool";
import { unwrapToolCallEvent } from "./xdev/event-unwrapper";
import { canonicalArgsFingerprint } from "./xdev/tool-identity";

const DEFAULT_COMPLIANCE_DIR = ".omp/compliance";
const UNBOUND_EVIDENCE_REVISION = `sha256:${createHash("sha256").update("unbound").digest("hex")}` as const;
const GOVERNED_BUILTINS = new Map([
	["edit", "edit"],
	["write", "write"],
	["bash", "bash"],
	["executeBash", "bash"],
	["task", "task"],
	["hub", "hub"],
]);
const ADVISOR_LIFECYCLE_EVENTS = [
	"advisor_review_queued",
	"advisor_run_started",
	"advisor_tool_call",
	"advisor_tool_result",
	"advisor_run_completed",
	"advisor_run_failed",
	"advisor_run_cancelled",
] as const;

function evidenceRevision(value: string | undefined): `sha256:${string}` {
	return value?.startsWith("sha256:") ? (value as `sha256:${string}`) : UNBOUND_EVIDENCE_REVISION;
}

export interface ComplianceExtensionHost {
	logger: ExtensionAPI["logger"];
	readonly advisorReviewCapabilities?: AdvisorReviewCapabilities;
	registerTool: ExtensionAPI["registerTool"];
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(event: "advisor_before_run", handler: ExtensionHandler<AdvisorBeforeRunEvent, AdvisorRunAugmentation>): void;
	on<TEvent extends AdvisorReviewLifecycleEvent["type"]>(
		event: TEvent,
		handler: ExtensionHandler<Extract<AdvisorReviewLifecycleEvent, { type: TEvent }>>,
	): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	getAllTools(): string[];
	requestAdvisorReview?(request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt>;
}

export function bindCollectorEvents(api: ComplianceExtensionHost, collector: CollectorRuntime): void {
	api.on("tool_call", (event, context) => collector.recordToolCall(event, context));
	api.on("tool_result", (event, context) => collector.recordToolResult(event, context));
}

function createLazyEvidenceStore(repoRoot: string): () => EvidenceStore {
	let store: EvidenceStore | null = null;
	return () => {
		store ??= new EvidenceStore(join(repoRoot, DEFAULT_COMPLIANCE_DIR));
		return store;
	};
}

function createLazyBrainstormInfra(repoRoot: string): () => { coordinator: TopicCoordinator; store: TopicStore } {
	let infra: { coordinator: TopicCoordinator; store: TopicStore } | null = null;
	return () => {
		if (!infra) {
			const store = new TopicStore(join(repoRoot, DEFAULT_COMPLIANCE_DIR, "brainstorm"));
			infra = { coordinator: new TopicCoordinator(store), store };
		}
		return infra;
	};
}

interface RuntimeBundle {
	readonly collector: CollectorRuntime;
	readonly runtime: ComplianceRuntime;
	readonly registry: ComplianceReviewRegistry;
	readonly brainstormRegistry: BrainstormReviewRegistry;
	readonly getBrainstormInfra: () => { coordinator: TopicCoordinator; store: TopicStore };
	readonly getBrainstormRuntime: () => BrainstormRuntime;
	readonly retryBrainstormDueReviews: () => Promise<void>;
	readonly ensureSchedulerReady: () => Promise<void>;
	readonly evaluateToolCall: (event: ToolCallEvent, context: ExtensionContext) => ToolCallEventResult | undefined;
	readonly handleAdvisorLifecycle: (event: AdvisorReviewLifecycleEvent) => Promise<void>;
}

function canonicalPreToolCall(event: ToolCallEvent, runtime: ComplianceRuntime): CanonicalToolCall | undefined {
	const state = runtime.currentTaskState;
	const codebase = unwrapToolCallEvent(event);
	if (codebase) {
		return {
			actor: "main",
			taskId: state?.taskId ?? "unbound-task",
			callId: codebase.toolCallId,
			identity: codebase.identity,
			evidenceRevision: evidenceRevision(state?.evidenceRevision),
		};
	}
	const toolName = GOVERNED_BUILTINS.get(event.toolName);
	if (!toolName) return undefined;
	const argsFingerprint = canonicalArgsFingerprint(event.input);
	if (!argsFingerprint) return undefined;
	const identity: CanonicalBuiltinToolIdentity = {
		transport: "builtin",
		serverId: "omp",
		toolName,
		qualifiedName: `omp.${toolName}`,
		args: { ...event.input } as Record<string, unknown>,
		argsFingerprint,
		access: "write",
	};
	return {
		actor: "main",
		taskId: state?.taskId ?? "unbound-task",
		callId: event.toolCallId,
		identity,
		evidenceRevision: evidenceRevision(state?.evidenceRevision),
	};
}

function createRuntimeBundle(api: ComplianceExtensionHost, repoRoot: string, sessionId: () => string): RuntimeBundle {
	const collector = new CollectorRuntime();
	const getEvidenceStore = createLazyEvidenceStore(repoRoot);
	const getBrainstormInfra = createLazyBrainstormInfra(repoRoot);
	const registry = new ComplianceReviewRegistry();
	const brainstormRegistry = new BrainstormReviewRegistry();
	const requestAdvisorReview = async (request: AdvisorReviewRequest): Promise<AdvisorReviewReceipt> => {
		if (!api.requestAdvisorReview) {
			return { reviewId: request.reviewId, status: "rejected", reason: "Advisor Review Protocol is unavailable" };
		}
		return api.requestAdvisorReview(request);
	};
	const reviewDeps: ComplianceReviewDependencies = { sessionId, registry, requestAdvisorReview };
	const receipts = new Map<string, AdvisorReviewReceipt>();
	const scheduler = new ReviewScheduler({
		clock: { now: () => Date.now() },
		random: () => Math.random(),
		store: new JsonFileReviewSchedulerStore(join(repoRoot, DEFAULT_COMPLIANCE_DIR, "review-scheduler.json")),
		requester: async (request) => {
			try {
				const hostReceipt = await requestAdvisorReview(request);
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
	let schedulerReady: Promise<void> | undefined;
	const ensureSchedulerReady = (): Promise<void> => {
		schedulerReady ??= scheduler.restore();
		return schedulerReady;
	};
	const runtime = new ComplianceRuntime(getEvidenceStore, collector, api, repoRoot, reviewDeps, {
		scheduler,
		strictEvidence: () => {
			throw new Error("Strict Completion Evidence is not bound to the active task");
		},
		gitContext: () => readAuthoritativeGitContext(repoRoot),
		readEnvelope: async (taskId, reviewId) => {
			const records = (await getEvidenceStore().readAll(taskId)) as Array<{
				event: string;
				reviewEnvelope?: import("./contracts/review-envelope").ReviewEnvelope;
			}>;
			return records.findLast(
				(record) =>
					(record.event === "completion_requested" || record.event === "completion_retry") &&
					record.reviewEnvelope?.reviewId === reviewId,
			)?.reviewEnvelope;
		},
		receiptFor: (reviewId) => receipts.get(reviewId),
	});
	let brainstormRuntime: BrainstormRuntime | undefined;
	const getBrainstormRuntime = (): BrainstormRuntime => {
		brainstormRuntime ??= new BrainstormRuntime({
			api: { requestAdvisorReview },
			collector,
			coordinator: getBrainstormInfra().coordinator,
			registry: brainstormRegistry,
			requestAdvisorReview,
			scheduler,
			ensureSchedulerReady,
			projectContext: () => {
				const git = readAuthoritativeGitContext(repoRoot);
				return {
					projectId: `project-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 32)}`,
					gitHead: git.gitHead,
					diffHash: git.diffHash,
				};
			},
			getAllTools: () => api.getAllTools() as readonly string[],
			sessionId,
		});
		return brainstormRuntime;
	};
	const retryBrainstormDueReviews = async (): Promise<void> => {
		if (brainstormRuntime) await brainstormRuntime.retryDueReviews();
	};
	const policyEvidence = new EvidenceRepository(join(repoRoot, DEFAULT_COMPLIANCE_DIR), repoRoot);
	const policy = new PreToolPolicy({
		append: (record) => {
			const taskId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.task) ? record.task : "unbound-task";
			policyEvidence.task(taskId).events.append({
				...record,
				type: record.event,
				timestamp: new Date().toISOString(),
				eventId: deterministicEvidenceEventId(`pre_tool_policy\0${JSON.stringify(record)}`),
			});
		},
	});
	const evaluateToolCall = (event: ToolCallEvent, context: ExtensionContext): ToolCallEventResult | undefined => {
		const call = canonicalPreToolCall(event, runtime);
		let result: ToolCallEventResult | undefined;
		if (call) {
			const state = runtime.currentTaskState;
			const decision = policy.evaluate(call, {
				evidenceRevision: evidenceRevision(state?.evidenceRevision),
			});
			if (!decision.allow) result = { block: true, reason: decision.reason };
		}
		collector.recordToolCall(event, context);
		return result;
	};
	const handleAdvisorLifecycle = async (event: AdvisorReviewLifecycleEvent): Promise<void> => {
		if (event.trigger === "brainstorm_review") {
			await getBrainstormRuntime().handleAdvisorLifecycle(event);
			return;
		}
		await runtime.handleAdvisorLifecycle(event);
	};
	return {
		collector,
		runtime,
		registry,
		brainstormRegistry,
		getBrainstormInfra,
		getBrainstormRuntime,
		retryBrainstormDueReviews,
		ensureSchedulerReady,
		evaluateToolCall,
		handleAdvisorLifecycle,
	};
}

function runtimeProxy(getRuntime: () => ComplianceRuntime): ComplianceRuntime {
	return new Proxy({} as ComplianceRuntime, {
		get: (_target, property) => {
			const runtime = getRuntime();
			const value = Reflect.get(runtime, property, runtime) as unknown;
			return typeof value === "function" ? value.bind(runtime) : value;
		},
	});
}

export default function activate(api: ComplianceExtensionHost): void {
	assertAdvisorProtocolV1(api as Pick<ExtensionAPI, "advisorReviewCapabilities" | "requestAdvisorReview">);
	let root: string | undefined;
	let activeSessionId: string | undefined;
	let bundle: RuntimeBundle | undefined;
	const bindSession = async (context: ExtensionContext): Promise<void> => {
		const identity = ProjectIdentityStore.open(context.cwd);
		if (identity.status !== "bound") throw new Error(`OMP project binding requires ${identity.status}`);
		const nextRoot = identity.observedRoot;
		if (root !== nextRoot) {
			root = nextRoot;
			bundle = undefined;
		}
		activeSessionId = context.sessionManager.getSessionId();
		await getBundle().ensureSchedulerReady();
	};
	const getBundle = (): RuntimeBundle => {
		if (!root || !activeSessionId) throw new Error("Compliance session is not initialized");
		bundle ??= createRuntimeBundle(api, root, () => {
			if (!activeSessionId) throw new Error("Compliance session is not initialized");
			return activeSessionId;
		});
		return bundle;
	};
	const deferredRuntime = runtimeProxy(() => getBundle().runtime);

	api.on("session_start", (_event, context) => bindSession(context));
	api.on("session_switch", (_event, context) => bindSession(context));
	api.on("before_agent_start", (event) => appendBrainstormGuidance(event));
	api.on("tool_call", (event, context) => getBundle().evaluateToolCall(event, context));
	api.on("tool_result", (event, context) => getBundle().collector.recordToolResult(event, context));
	api.on("advisor_before_run", async (event) => {
		const current = getBundle();
		const complianceResult = createComplianceAdvisorHook(current.registry, current.runtime)(event);
		if (complianceResult) return complianceResult;
		if (event.trigger !== "brainstorm_review") return undefined;
		await current.getBrainstormRuntime().restoreAdvisorEnvelope(event.reviewId);
		return createBrainstormAdvisorHook(
			current.brainstormRegistry,
			current.getBrainstormInfra().coordinator,
			(message, options) =>
				api.sendMessage(
					{
						customType: message.customType,
						content: message.content,
						display: message.display,
						attribution: message.attribution as "agent" | "user",
						details: message.details,
					},
					{
						deliverAs: options?.deliverAs as "steer" | "followUp" | "nextTurn" | undefined,
						triggerTurn: options?.triggerTurn,
					},
				),
			(envelope, review) => current.getBrainstormRuntime().acceptReview(envelope, review),
		)(event);
	});
	for (const eventName of ADVISOR_LIFECYCLE_EVENTS) {
		api.on(eventName, (event) => getBundle().handleAdvisorLifecycle(event));
	}
	api.on("turn_end", async (event) => {
		if (!bundle) return;
		bundle.collector.recordTurnEnd({ ...event });
		await bundle.runtime.retryDueReviews();
		await bundle.retryBrainstormDueReviews();
	});
	api.on("agent_end", () => bundle?.collector.refreshPresentation());

	registerComplianceCommand(api, deferredRuntime);
	registerComplianceCompleteTool(api, deferredRuntime);
	registerBrainstormCommand(api, () => getBundle().getBrainstormInfra().coordinator);
	api.registerTool(
		createTopicReadyTool({
			get runtime(): BrainstormRuntime {
				return getBundle().getBrainstormRuntime();
			},
			sessionId: () => activeSessionId ?? "unknown",
		}),
	);
	api.registerTool(
		createDecisionTool({
			get coordinator(): TopicCoordinator {
				return getBundle().getBrainstormInfra().coordinator;
			},
		}),
	);
}
