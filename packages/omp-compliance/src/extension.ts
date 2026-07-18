import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, normalize, sep } from "node:path";
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
import { loadComplianceContract } from "./contract/load-contract";
import type { TaskContract } from "./contract/types";
import { loadTaskContractFromTdd } from "./contracts/task-contract";
import { deterministicEvidenceEventId } from "./evidence/event-log";
import { EvidenceRepository } from "./evidence/evidence-repository";
import { EvidenceStore } from "./evidence/evidence-store";
import type { ProjectBinding } from "./project/project-identity";
import { ProjectIdentityStore } from "./project/project-identity";
import {
	ComplianceRuntime,
	type ComplianceRuntimePersistenceSnapshot,
	type StrictCompletionEvidence,
	readAuthoritativeGitContext,
} from "./runtime/compliance-runtime";
import { type CanonicalBuiltinToolIdentity, type CanonicalToolCall, PreToolPolicy } from "./runtime/pre-tool-policy";
import { JsonFileReviewSchedulerStore, ReviewScheduler } from "./scheduler/review-scheduler";
import {
	createCodebaseEvidencePack,
	createTrustedCodebaseValidationContext,
	validateCodebasePack,
} from "./signals/codebase-memory";
import { type CollectorRuntime, createControlledCollectorRuntime } from "./signals/collector-runtime";
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

function repositoryRoot(cwd: string): string {
	const canonicalCwd = normalize(realpathSync(cwd)).split(sep).join("/");
	const result = spawnSync("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	const root = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : canonicalCwd;
	return normalize(realpathSync(root)).split(sep).join("/");
}

function codebaseProjectForRoot(root: string): string {
	return root.replace(/^\/+/, "").replaceAll("/", "-");
}

function tddFileEntry(value: string): string {
	return value
		.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/^`|`$/g, "")
		.trim();
}

function gitChangedFiles(root: string): { changedFiles: string[]; newFiles: string[] } {
	const tracked = spawnSync("git", ["-C", root, "diff", "--name-only", "HEAD"], { encoding: "utf8" });
	const untracked = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], {
		encoding: "utf8",
	});
	const newFiles =
		untracked.status === 0
			? untracked.stdout
					.split("\n")
					.filter(Boolean)
					.filter((path) => !path.startsWith(".omp/"))
			: [];
	const changedFiles = [
		...(tracked.status === 0
			? tracked.stdout
					.split("\n")
					.filter(Boolean)
					.filter((path) => !path.startsWith(".omp/"))
			: []),
		...newFiles,
	];
	return { changedFiles: [...new Set(changedFiles)].sort(), newFiles: [...new Set(newFiles)].sort() };
}

function evidenceMetadata(collector: CollectorRuntime): {
	indexRevision?: string;
	queriedAt: string;
	requiredSymbols: string[];
} {
	const snapshot = collector.collector.snapshot();
	let indexRevision: string | undefined;
	let latestResult = 0;
	const requiredSymbols = new Set<string>();
	for (const result of snapshot.results) {
		latestResult = Math.max(latestResult, Date.parse(result.timestamp) || 0);
		if (result.success && result.details?.status === "ready" && typeof result.details.revision === "string") {
			indexRevision = result.details.revision;
		}
		const pending: unknown[] = result.details ? [result.details] : [];
		let visited = 0;
		while (pending.length > 0 && visited < 256) {
			visited += 1;
			const value = pending.pop();
			if (Array.isArray(value)) {
				pending.push(...value);
				continue;
			}
			if (!value || typeof value !== "object") continue;
			for (const [key, child] of Object.entries(value)) {
				if ((key === "qualified_name" || key === "qualifiedName") && typeof child === "string" && child.trim()) {
					requiredSymbols.add(child.trim());
				} else if (child && typeof child === "object") {
					pending.push(child);
				}
			}
		}
	}
	return {
		indexRevision,
		queriedAt: new Date(Math.max(Date.now(), latestResult + 1)).toISOString(),
		requiredSymbols: [...requiredSymbols].sort(),
	};
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
	readonly sessionId: string;
	readonly root: string;
	readonly collector: CollectorRuntime;
	readonly runtime: ComplianceRuntime;
	readonly registry: ComplianceReviewRegistry;
	readonly brainstormRegistry: BrainstormReviewRegistry;
	readonly getBrainstormInfra: () => { coordinator: TopicCoordinator; store: TopicStore };
	readonly getBrainstormRuntime: () => BrainstormRuntime;
	readonly retryBrainstormDueReviews: () => Promise<void>;
	readonly ensureSchedulerReady: () => Promise<void>;
	readonly initialize: () => Promise<void>;
	readonly prepareTask: (tddPath: string) => TaskContract;
	readonly bindTaskContract: (contract: TaskContract | undefined, persist?: boolean) => void;
	readonly currentTaskContract: () => TaskContract | undefined;
	readonly evaluateToolCall: (
		event: ToolCallEvent,
		context: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	readonly handleAdvisorLifecycle: (event: AdvisorReviewLifecycleEvent) => Promise<void>;
}

function canonicalPreToolCall(
	event: ToolCallEvent,
	runtime: ComplianceRuntime,
	currentRevision: `sha256:${string}`,
): CanonicalToolCall | undefined {
	const state = runtime.currentTaskState;
	const codebase = unwrapToolCallEvent(event);
	if (codebase) {
		return {
			actor: "main",
			taskId: state?.taskId ?? "unbound-task",
			callId: codebase.toolCallId,
			identity: codebase.identity,
			evidenceRevision: currentRevision,
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
		evidenceRevision: currentRevision,
	};
}

function createRuntimeBundle(
	api: ComplianceExtensionHost,
	repoRoot: string,
	activeSessionId: string,
	projectBinding: Readonly<ProjectBinding>,
): RuntimeBundle {
	const controlledCollector = createControlledCollectorRuntime();
	const collector = controlledCollector.runtime;
	const sessionId = () => activeSessionId;
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
	const policyEvidence = new EvidenceRepository(join(repoRoot, DEFAULT_COMPLIANCE_DIR), repoRoot);
	const codebaseProject = projectBinding.codebaseProjectId;
	if (!codebaseProject) throw new Error("Compliance project is not bound to a Codebase project");
	let preparedTaskContract: TaskContract | undefined;
	const strictEvidence = (): StrictCompletionEvidence => {
		if (!preparedTaskContract) throw new Error("TaskContract is not bound to the active task");
		const metadata = evidenceMetadata(collector);
		if (!metadata.indexRevision || metadata.requiredSymbols.length === 0) {
			return { taskContract: preparedTaskContract, delegations: [] };
		}
		const git = readAuthoritativeGitContext(repoRoot);
		const changed = gitChangedFiles(repoRoot);
		const codebaseContext = createTrustedCodebaseValidationContext(controlledCollector.reader, {
			taskContract: preparedTaskContract,
			codebaseProjectId: codebaseProject,
			currentDiffHash: git.diffHash,
			indexRevision: metadata.indexRevision,
			queriedAt: metadata.queriedAt,
			changedFiles: changed.changedFiles,
			newFiles: changed.newFiles,
			allowedNewFileRoots: [],
			unresolvedClaims: [],
			requiredSymbols: metadata.requiredSymbols,
		});
		const codebasePack = createCodebaseEvidencePack(codebaseContext);
		const packErrors = validateCodebasePack(codebasePack, codebaseContext);
		if (packErrors.length > 0) throw new Error(`Codebase Evidence Pack rejected: ${packErrors.join(",")}`);
		return {
			taskContract: preparedTaskContract,
			codebaseContext,
			codebasePack,
			delegations: [],
		};
	};
	const prepareTask = (tddPath: string): TaskContract => {
		const absolutePath = tddPath.startsWith("/") ? tddPath : join(repoRoot, tddPath);
		const complianceContract = loadComplianceContract(absolutePath, repoRoot);
		const git = readAuthoritativeGitContext(repoRoot);
		const declaredFiles = complianceContract.summary.files.map(tddFileEntry).filter(Boolean);
		const affectedFiles = declaredFiles.length > 0 ? declaredFiles : [complianceContract.tddPath];
		return loadTaskContractFromTdd(absolutePath, repoRoot, {
			projectId: projectBinding.projectId,
			gitHead: git.gitHead,
			affectedFiles,
		});
	};
	const bindTaskContract = (contract: TaskContract | undefined, persist = true): void => {
		preparedTaskContract = contract;
		if (contract && persist) policyEvidence.task(contract.taskId).contract.write(contract);
	};
	const runtime = new ComplianceRuntime(getEvidenceStore, collector, api, repoRoot, reviewDeps, {
		scheduler,
		strictEvidence,
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
		persistRuntimeState: (taskId, snapshot) => policyEvidence.task(taskId).state.write(snapshot),
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
					projectId: projectBinding.projectId,
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
		await getBrainstormRuntime().retryDueReviews();
	};
	const policy = new PreToolPolicy({
		append: (record) => {
			const taskId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.task) ? record.task : "unbound-task";
			policyEvidence.task(taskId).events.append({
				...record,
				schemaVersion: 1,
				type: record.event,
				eventType: record.event,
				projectId: projectBinding.projectId,
				sessionId: activeSessionId,
				taskId,
				timestamp: new Date().toISOString(),
				eventId: deterministicEvidenceEventId(`pre_tool_policy\0${JSON.stringify(record)}`),
			});
		},
	});
	const evaluateToolCall = async (
		event: ToolCallEvent,
		context: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		let evidence: StrictCompletionEvidence | undefined;
		if (preparedTaskContract) evidence = strictEvidence();
		const currentRevision =
			evidence?.codebasePack?.evidenceRevision ?? evidenceRevision(runtime.currentTaskState?.evidenceRevision);
		const call = canonicalPreToolCall(event, runtime, currentRevision);
		let result: ToolCallEventResult | undefined;
		if (call) {
			const decision = policy.evaluate(call, {
				evidenceRevision: currentRevision,
				projectContext: {
					projectId: projectBinding.projectId,
					root: projectBinding.canonicalRoot,
					codebaseProject,
				},
				...(preparedTaskContract ? { contract: preparedTaskContract } : {}),
				...(evidence?.codebasePack ? { codebasePack: evidence.codebasePack } : {}),
				...(evidence?.codebaseContext ? { trustedCodebaseContext: evidence.codebaseContext } : {}),
			});
			if (!decision.allow) {
				if (decision.evidenceWriteFailed) {
					await runtime.stallForInfrastructure("Pre-tool Evidence persistence failed");
				}
				result = { block: true, reason: decision.reason };
			}
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
	const initialize = async (): Promise<void> => {
		const recovery = policyEvidence.recover();
		const recoverable = recovery.taskIds.flatMap((taskId) => {
			const snapshot = policyEvidence.task(taskId).state.read<ComplianceRuntimePersistenceSnapshot>();
			if (
				!snapshot?.taskState ||
				snapshot.taskState.status === "completed" ||
				snapshot.taskState.status === "overridden"
			) {
				return [];
			}
			const contract = policyEvidence.task(taskId).contract.read<TaskContract>();
			if (!contract) throw new Error(`Persisted TaskContract is missing for ${taskId}`);
			return [{ contract, snapshot }];
		});
		if (recoverable.length > 1) throw new Error("Multiple recoverable compliance tasks found");
		await ensureSchedulerReady();
		const recovered = recoverable[0];
		if (recovered) {
			bindTaskContract(recovered.contract, false);
			await runtime.restorePersistedState(recovered.contract, recovered.snapshot);
		}
		await runtime.retryDueReviews();
		await retryBrainstormDueReviews();
	};
	return {
		sessionId: activeSessionId,
		root: repoRoot,
		collector,
		runtime,
		registry,
		brainstormRegistry,
		getBrainstormInfra,
		getBrainstormRuntime,
		retryBrainstormDueReviews,
		ensureSchedulerReady,
		initialize,
		prepareTask,
		bindTaskContract,
		currentTaskContract: () => preparedTaskContract,
		evaluateToolCall,
		handleAdvisorLifecycle,
	};
}

function runtimeProxy(getBundle: () => RuntimeBundle): ComplianceRuntime {
	return new Proxy({} as ComplianceRuntime, {
		get: (_target, property) => {
			const bundle = getBundle();
			const runtime = bundle.runtime;
			if (property === "start") {
				return async (tddPath: string) => {
					if (runtime.currentTaskState) {
						return runtime.start(tddPath);
					}
					const previous = bundle.currentTaskContract();
					const candidate = bundle.prepareTask(tddPath);
					bundle.bindTaskContract(candidate);
					try {
						return await runtime.start(tddPath);
					} catch (error) {
						bundle.bindTaskContract(previous);
						throw error;
					}
				};
			}
			const value = Reflect.get(runtime, property, runtime) as unknown;
			return typeof value === "function" ? value.bind(runtime) : value;
		},
	});
}

export default function activate(api: ComplianceExtensionHost): void {
	assertAdvisorProtocolV1(api as Pick<ExtensionAPI, "advisorReviewCapabilities" | "requestAdvisorReview">);
	const bundlesBySession = new Map<string, RuntimeBundle>();
	let activeBundle: RuntimeBundle | undefined;
	const bindSession = async (context: ExtensionContext): Promise<void> => {
		const root = repositoryRoot(context.cwd);
		const identity = ProjectIdentityStore.open(context.cwd, { codebaseProjectId: codebaseProjectForRoot(root) });
		if (identity.status !== "bound") throw new Error(`OMP project binding requires ${identity.status}`);
		const sessionId = context.sessionManager.getSessionId();
		let current = bundlesBySession.get(sessionId);
		if (!current || current.root !== identity.observedRoot) {
			current = createRuntimeBundle(api, identity.observedRoot, sessionId, identity.binding);
			bundlesBySession.set(sessionId, current);
		}
		activeBundle = current;
		await current.initialize();
	};
	const getBundle = (): RuntimeBundle => {
		if (!activeBundle) throw new Error("Compliance session is not initialized");
		return activeBundle;
	};
	const bundleForSession = (sessionId: string): RuntimeBundle => {
		const bundle = bundlesBySession.get(sessionId);
		if (!bundle) throw new Error(`Compliance session is not initialized: ${sessionId}`);
		return bundle;
	};
	const deferredRuntime = runtimeProxy(getBundle);

	api.on("session_start", (_event, context) => bindSession(context));
	api.on("session_switch", (_event, context) => bindSession(context));
	api.on("before_agent_start", (event) => appendBrainstormGuidance(event));
	api.on("tool_call", (event, context) =>
		bundleForSession(context.sessionManager.getSessionId()).evaluateToolCall(event, context),
	);
	api.on("tool_result", (event, context) =>
		bundleForSession(context.sessionManager.getSessionId()).collector.recordToolResult(event, context),
	);
	api.on("advisor_before_run", async (event) => {
		const current = bundleForSession(event.primarySessionId);
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
		api.on(eventName, (event) => bundleForSession(event.primarySessionId).handleAdvisorLifecycle(event));
	}
	api.on("turn_end", async (event, context) => {
		if (!activeBundle) return;
		const current = bundleForSession(context.sessionManager.getSessionId());
		current.collector.recordTurnEnd({ ...event });
		await current.runtime.retryDueReviews();
		await current.retryBrainstormDueReviews();
	});
	api.on("agent_end", (_event, context) => {
		if (activeBundle) bundleForSession(context.sessionManager.getSessionId()).collector.refreshPresentation();
	});

	registerComplianceCommand(api, deferredRuntime);
	registerComplianceCompleteTool(api, deferredRuntime);
	registerBrainstormCommand(api, () => getBundle().getBrainstormInfra().coordinator);
	api.registerTool(
		createTopicReadyTool({
			get runtime(): BrainstormRuntime {
				return getBundle().getBrainstormRuntime();
			},
			sessionId: () => activeBundle?.sessionId ?? "unknown",
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
