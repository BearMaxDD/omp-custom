import type { TSchema } from "@oh-my-pi/pi-ai";
import type {
	AdvisorBeforeRunEvent,
	AdvisorReviewCapabilities,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
	AdvisorRunAugmentation,
} from "@oh-my-pi/pi-coding-agent/advisor/review-protocol";
import type {
	ExtensionContext,
	RegisteredCommand,
	ToolCallEvent,
	ToolDefinition,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ComplianceExtensionHost } from "../../src/extension";

/**
 * A minimal fake implementation of ExtensionAPI for testing.
 * Records all registrations and calls for later assertion.
 */
export class FakeExtensionAPI {
	public readonly tools: string[] = [];
	public readonly toolDefinitions: ToolDefinition[] = [];
	public readonly commands: string[] = [];
	public readonly commandHandlers = new Map<string, RegisteredCommand["handler"]>();
	public readonly eventHandlers: Map<string, Array<(event: unknown, context?: ExtensionContext) => unknown>> =
		new Map();
	public readonly sentMessages: CustomMessagePayload[] = [];
	public readonly appendedEntries: Array<{ type: string; data?: unknown }> = [];
	public readonly logs: string[] = [];
	public requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt> = async (
		_request: AdvisorReviewRequest,
	) => ({ status: "accepted", reviewId: _request.reviewId });
	public advisorReviewCapabilities: AdvisorReviewCapabilities | undefined = {
		protocolVersion: 1,
		reviewRequest: true,
		beforeRunAugmentation: true,
		lifecycleEvents: true,
		finalReceipt: true,
	};

	constructor(private readonly extensionContext: ExtensionContext = createFakeExtensionContext()) {}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		this.tools.push(tool.name);
		this.toolDefinitions.push(tool as ToolDefinition);
	}

	registerCommand(
		name: string,
		_options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.commands.push(name);
		this.commandHandlers.set(name, _options.handler);
	}

	on(event: string, handler: (event: unknown, context?: ExtensionContext) => unknown): void {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	private createContext(): ExtensionContext {
		return this.extensionContext;
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		_options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): void {
		this.sentMessages.push(message);
	}

	appendEntry<T = unknown>(customType: string, data?: T): void {
		this.appendedEntries.push({ type: customType, data });
	}

	/** Return all registered tool names. */
	getRegisteredTools(): string[] {
		return [...this.tools];
	}

	/** Return all registered command names. */
	getRegisteredCommands(): string[] {
		return [...this.commands];
	}

	getAllTools(): string[] {
		return [...this.tools];
	}

	/** Return the set of events that have at least one handler bound. */
	getBoundEvents(): string[] {
		return Array.from(this.eventHandlers.keys());
	}

	/** Simulate an advisor_before_run event and return collected results. */
	async fireAdvisorBeforeRun(event: Partial<AdvisorBeforeRunEvent>): Promise<AdvisorRunAugmentation | undefined> {
		const handlers = this.eventHandlers.get("advisor_before_run") ?? [];
		const fullEvent: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			reviewId: event.reviewId ?? "test-review",
			trigger: event.trigger ?? "compliance_review",
			priority: event.priority ?? 0,
			metadata: event.metadata,
			primarySessionId: event.primarySessionId ?? "test-session",
			advisorSessionId: event.advisorSessionId ?? "test-advisor",
		};
		for (const handler of handlers) {
			const result = await handler(fullEvent, {
				sessionManager: { getSessionId: () => fullEvent.primarySessionId },
			} as ExtensionContext);
			if (result !== undefined) return result as AdvisorRunAugmentation;
		}
		return undefined;
	}

	/** Simulate a tool_call event through all bound handlers and return collected results. */
	async fireToolCall(
		toolName: string,
		input: Record<string, unknown> = {},
		toolCallId = `test-${toolName}`,
	): Promise<{ block: boolean; reasons: string[] }> {
		const handlers = this.eventHandlers.get("tool_call") ?? [];
		const results: { block?: boolean; reason?: string }[] = [];
		const event: ToolCallEvent = { type: "tool_call", toolName, toolCallId, input };
		const context = this.createContext();

		for (const handler of handlers) {
			const result = await handler(event, context);
			if (result && typeof result === "object" && "block" in (result as Record<string, unknown>)) {
				results.push(result as { block?: boolean; reason?: string });
			}
		}

		return {
			block: results.some((r) => r.block === true),
			reasons: results.filter((r) => r.block).map((r) => r.reason ?? ""),
		};
	}

	async fireToolResult(event: Omit<ToolResultEvent, "type">): Promise<void> {
		const handlers = this.eventHandlers.get("tool_result") ?? [];
		const fullEvent = { type: "tool_result", ...event } as ToolResultEvent;
		const context = this.createContext();
		for (const handler of handlers) await handler(fullEvent, context);
	}

	async fireSessionStart(): Promise<void> {
		const handlers = this.eventHandlers.get("session_start") ?? [];
		const context = this.createContext();
		for (const handler of handlers) {
			await handler({ type: "session_start" }, context);
		}
	}

	async fireSessionSwitch(context: ExtensionContext = this.createContext()): Promise<void> {
		const handlers = this.eventHandlers.get("session_switch") ?? [];
		for (const handler of handlers) await handler({ type: "session_switch" }, context);
	}

	async fireCommand(name: string, args: string): Promise<void> {
		const handler = this.commandHandlers.get(name);
		if (!handler) throw new Error(`Command not registered: ${name}`);
		await handler(args, this.createContext());
	}

	/** Return which tool names would be blocked by handlers (for compliance assertions). */
	async getBlockedToolCalls(): Promise<string[]> {
		const blocked: string[] = [];
		const handlerSet = this.eventHandlers.get("tool_call") ?? [];
		if (handlerSet.length === 0) return blocked;

		// Test a representative set of built-in tools
		const toolNames = ["executeBash", "read", "grep", "edit", "write", "glob", "task"];
		for (const name of toolNames) {
			const event: ToolCallEvent = {
				type: "tool_call",
				toolName: name,
				toolCallId: `blocked-check-${name}`,
				input: {},
			};
			const context = this.createContext();
			for (const handler of handlerSet) {
				const result = await handler(event, context);
				if (result && typeof result === "object" && (result as Record<string, unknown>)?.block === true) {
					blocked.push(name);
					break;
				}
			}
		}
		return blocked;
	}

	/** Convert to the narrow set of official host capabilities consumed by activate(). */
	toAPI(): ComplianceExtensionHost {
		return {
			registerTool: this.registerTool.bind(this),
			registerCommand: this.registerCommand.bind(this),
			on: this.on.bind(this) as ComplianceExtensionHost["on"],
			sendMessage: this.sendMessage.bind(this),
			getAllTools: this.getAllTools.bind(this),
			requestAdvisorReview: this.requestAdvisorReview.bind(this),
			advisorReviewCapabilities: this.advisorReviewCapabilities,
			logger: {
				info: (message: string) => this.logs.push(message),
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		} as ComplianceExtensionHost;
	}
}

export function createFakeExtensionContext(options: { cwd?: string; sessionId?: string } = {}): ExtensionContext {
	return {
		ui: {} as ExtensionContext["ui"],
		getContextUsage: () => undefined,
		compact: async () => {},
		hasUI: false,
		cwd: options.cwd ?? process.cwd(),
		sessionManager: {
			getSessionId: () => options.sessionId ?? "test-session",
		} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		models: {} as ExtensionContext["models"],
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getSystemPrompt: () => [],
	};
}
