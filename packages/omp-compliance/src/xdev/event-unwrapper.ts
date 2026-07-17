import { type CanonicalToolIdentity, canonicalizeToolIdentity } from "./tool-identity";

interface ToolCallLike {
	type?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	input?: unknown;
	params?: unknown;
	serverName?: unknown;
	parentToolCallId?: unknown;
	outerToolCallId?: unknown;
}

interface ToolResultLike extends ToolCallLike {
	details?: unknown;
}

export interface UnwrappedToolEvent {
	toolCallId: string;
	correlationId: string;
	identity: CanonicalToolIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventArgs(event: ToolCallLike): unknown {
	return event.type === "tool_call" ? event.input : event.params;
}

export function unwrapToolCallEvent(event: ToolCallLike): UnwrappedToolEvent | null {
	const toolCallId = stringField(event.toolCallId);
	const toolName = stringField(event.toolName);
	if (!toolCallId || !toolName) return null;
	if (event.type !== undefined && event.type !== "tool_call") return null;
	const identity = canonicalizeToolIdentity({
		toolName,
		serverName: stringField(event.serverName),
		args: eventArgs(event),
	});
	if (!identity) return null;
	if (identity.transport === "xdev" && event.type !== "tool_call") return null;
	return {
		toolCallId,
		correlationId: stringField(event.parentToolCallId) ?? stringField(event.outerToolCallId) ?? toolCallId,
		identity,
	};
}

export function unwrapToolResultEvent(
	event: ToolResultLike,
	expectedQualifiedName?: string,
): UnwrappedToolEvent | null {
	if (event.type !== "tool_result" || event.toolName !== "write" || !isRecord(event.input)) return null;
	const call = unwrapToolCallEvent({ ...event, type: "tool_call" });
	if (!call || call.identity.transport !== "xdev" || !isRecord(event.details)) return null;
	const xdev = event.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string" || !isRecord(xdev.args)) {
		return null;
	}
	if (xdev.tool !== call.identity.toolName) return null;
	const resultIdentity = canonicalizeToolIdentity({
		toolName: "write",
		args: { path: `xd://${xdev.tool}`, content: JSON.stringify(xdev.args) },
	});
	if (!resultIdentity || resultIdentity.qualifiedName !== call.identity.qualifiedName) return null;
	if (expectedQualifiedName && resultIdentity.qualifiedName !== expectedQualifiedName) return null;
	return { ...call, identity: resultIdentity };
}
