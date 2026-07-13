/**
 * Minimal type definitions for the Oh My Pi ExtensionAPI.
 * Matches the interface from @oh-my-pi/pi-coding-agent v16.4.x
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic schema from zod/arktype
export type TSchema = unknown;

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	description?: string;
	parameters?: TParams;
	details?: TDetails;
	handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: () => string[];
	handler: (args: string[]) => Promise<void> | void;
}

export interface ExtensionContext {
	sessionManager: { getSessionId(): string };
}

export type ExtensionHandler<TEvent, TResult = void> = (
	event: TEvent,
	context: ExtensionContext,
) => TResult | Promise<TResult>;

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

export interface CustomMessagePayload<T = unknown> {
	customType: string;
	content: string;
	display: boolean;
	attribution: "agent" | "user";
	details?: T;
}

export interface ExtensionAPI {
	registerTool: <TParams extends TSchema = TSchema, TDetails = unknown>(
		tool: ToolDefinition<TParams, TDetails>,
	) => void;
	registerCommand: (
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: () => string[];
			handler: (args: string[]) => Promise<void> | void;
		},
	) => void;
	on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => void;
	sendMessage: <T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	) => void;
	requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt>;
	logger: {
		info: (msg: string) => void;
		warn: (msg: string) => void;
		error: (msg: string) => void;
		debug: (msg: string) => void;
	};
	getAllTools: () => string[];
}

/**
 * Advisor run trigger — distinguishes compliance reviews from regular turns.
 */
export type AdvisorRunTrigger = "turn_end" | "compliance_review" | "impact_analysis" | "git_pre_push" | "file_change" | "scheduled" | "manual_review";

/**
 * Minimal AgentTool shape for the Advisor before-run hook.
 *
 * The harness provides the full AgentTool type; this stub lets the
 * compliance package compile and test independently.
 */
export interface AgentTool {
	name: string;
	label: string;
	description?: string;
	parameters?: unknown;
	intent?: "omit" | "optional" | "require";
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult) => void,
		context?: unknown,
	) => Promise<AgentToolResult>;
}

export interface AgentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	useless?: boolean;
	isError?: boolean;
}

/**
 * Event payload fired before each Advisor run.
 *
 * Extensions can match on `trigger` to inject compliance context/tools.
 */
export interface AdvisorBeforeRunEvent {
	type: "advisor_before_run";
	sessionId: string;
	advisorId: string;
	trigger: AdvisorRunTrigger;
	messages: readonly unknown[];
	metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Result returned by an advisor_before_run handler.
 *
 * Additional system context is prepended as lines before the system
 * prompt; additional tools are registered for the duration of that
 * single Advisor run.
 */
export interface AdvisorBeforeRunResult {
	additionalSystemContext?: readonly string[];
	additionalTools?: readonly AgentTool[];
	metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Request payload for triggering an Advisor compliance review run.
 */
export interface AdvisorReviewRequest {
	readonly reviewId: string;
	readonly metadata?: Record<string, unknown>;
}
/**
 * Receipt returned by the harness after requesting an Advisor review.
 *
 * Matches the upstream OMP v16.4.x shape exactly:
 *   - status: "accepted" | "rejected"
 *   - reviewId: string
 *   - reason?: string
 */
export interface AdvisorReviewReceipt {
	readonly status: "accepted" | "rejected";
	readonly reviewId: string;
	readonly reason?: string;
}
