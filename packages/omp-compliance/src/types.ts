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
	extensionName: string;
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
	type: string;
	data?: T;
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
	appendEntry: <T = unknown>(customType: string, data?: T) => void;
	logger: {
		info: (msg: string) => void;
		warn: (msg: string) => void;
		error: (msg: string) => void;
		debug: (msg: string) => void;
	};
}
