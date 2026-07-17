/**
 * OMP host contracts are owned by @oh-my-pi/pi-coding-agent.
 *
 * This module only keeps compatibility re-exports while callers migrate to
 * direct package imports. It must not redeclare host-owned structures.
 */
export type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolCallEventResult,
	ToolDefinition,
	ToolDefinition as AgentTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
export type {
	AdvisorBeforeRunEvent,
	AdvisorReviewReceipt,
	AdvisorReviewRequest,
	AdvisorRunAugmentation as AdvisorBeforeRunResult,
} from "@oh-my-pi/pi-coding-agent/advisor/index";
export type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
export type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
