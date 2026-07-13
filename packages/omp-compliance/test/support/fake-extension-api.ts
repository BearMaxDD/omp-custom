import type { AdvisorBeforeRunEvent, AdvisorBeforeRunResult, AdvisorReviewReceipt, AdvisorReviewRequest, CustomMessagePayload, ExtensionAPI, ToolDefinition } from "../../src/types";

/**
 * A minimal fake implementation of ExtensionAPI for testing.
 * Records all registrations and calls for later assertion.
 */
export class FakeExtensionAPI {
	public readonly tools: string[] = [];
	public readonly commands: string[] = [];
	public readonly eventHandlers: Map<string, Array<(event: unknown) => unknown>> = new Map();
	public readonly sentMessages: CustomMessagePayload[] = [];
	public readonly appendedEntries: Array<{ type: string; data?: unknown }> = [];
	public requestAdvisorReview: (request: AdvisorReviewRequest) => Promise<AdvisorReviewReceipt> = async (
		_request: AdvisorReviewRequest,
	) => ({ reviewId: _request.reviewId, status: "accepted" });

	registerTool<TParams = unknown, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		this.tools.push(tool.name);
	}

	registerCommand(
		name: string,
		_options: {
			description?: string;
			getArgumentCompletions?: () => string[];
			handler: (args: string[]) => Promise<void> | void;
		},
	): void {
		this.commands.push(name);
	}

	on(event: string, handler: (event: unknown) => unknown): void {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
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

	/** Return the set of events that have at least one handler bound. */
	getBoundEvents(): string[] {
		return Array.from(this.eventHandlers.keys());
	}

	/** Simulate an advisor_before_run event and return collected results. */
	async fireAdvisorBeforeRun(
		event: Partial<AdvisorBeforeRunEvent>,
	): Promise<AdvisorBeforeRunResult | undefined> {
		const handlers = this.eventHandlers.get("advisor_before_run") ?? [];
		const fullEvent: AdvisorBeforeRunEvent = {
			type: "advisor_before_run",
			sessionId: event.sessionId ?? "test-session",
			advisorId: event.advisorId ?? "test-advisor",
			trigger: event.trigger ?? "compliance_review",
			messages: event.messages ?? [],
			metadata: event.metadata,
		};
		for (const handler of handlers) {
			const result = await handler(fullEvent, {
				sessionManager: { getSessionId: () => fullEvent.sessionId },
			});
			if (result !== undefined) return result as AdvisorBeforeRunResult;
		}
		return undefined;
	}

	/** Simulate a tool_call event through all bound handlers and return collected results. */
	async fireToolCall(toolName: string): Promise<{ block: boolean; reasons: string[] }> {
		const handlers = this.eventHandlers.get("tool_call") ?? [];
		const results: { block?: boolean; reason?: string }[] = [];

		for (const handler of handlers) {
			const result = await handler({ tool_name: toolName });
			if (result && typeof result === "object" && "block" in (result as Record<string, unknown>)) {
				results.push(result as { block?: boolean; reason?: string });
			}
		}

		return {
			block: results.some((r) => r.block === true),
			reasons: results.filter((r) => r.block).map((r) => r.reason ?? ""),
		};
	}

	/** Return which tool names would be blocked by handlers (for compliance assertions). */
	async getBlockedToolCalls(): Promise<string[]> {
		const blocked: string[] = [];
		const handlerSet = this.eventHandlers.get("tool_call") ?? [];
		if (handlerSet.length === 0) return blocked;

		// Test a representative set of built-in tools
		const toolNames = ["executeBash", "read", "grep", "edit", "write", "glob", "task"];
		for (const name of toolNames) {
			const event = { tool_name: name };
			for (const handler of handlerSet) {
				const result = await handler(event);
				if (result && typeof result === "object" && (result as Record<string, unknown>)?.block === true) {
					blocked.push(name);
					break;
				}
			}
		}
		return blocked;
	}

	/** Convert to the ExtensionAPI interface for use by extension activate(). */
	toAPI(): ExtensionAPI {
		return {
			registerTool: this.registerTool.bind(this),
			registerCommand: this.registerCommand.bind(this),
			on: this.on.bind(this),
			sendMessage: this.sendMessage.bind(this),
			appendEntry: this.appendEntry.bind(this),
			requestAdvisorReview: this.requestAdvisorReview.bind(this),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};
	}
}
