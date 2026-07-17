import { type CanonicalToolIdentity, canonicalArgsFingerprint, canonicalizeToolIdentity } from "./tool-identity";

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

export type InvalidXdevReason =
	| "invalid_outer_event"
	| "invalid_xdev_uri"
	| "invalid_content"
	| "malformed_json"
	| "unknown_tool"
	| "missing_xdev_details"
	| "tool_mismatch"
	| "args_mismatch"
	| "unserializable_args";

export interface UnwrappedToolEvent {
	toolCallId: string;
	correlationId: string;
	identity: CanonicalToolIdentity;
}

export type ToolEventClassification =
	| { kind: "valid"; event: UnwrappedToolEvent }
	| { kind: "invalid_xdev"; toolCallId: string; reason: InvalidXdevReason }
	| { kind: "ignored" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventArgs(event: ToolCallLike): unknown {
	return event.type === "tool_call" ? event.input : event.params;
}

function isXdevCandidate(event: ToolCallLike): boolean {
	if (event.toolName !== "write") return false;
	const args = eventArgs(event);
	return isRecord(args) && typeof args.path === "string" && args.path.trim().toLowerCase().startsWith("xd://");
}

function diagnoseXdevCall(event: ToolCallLike): InvalidXdevReason | "help" {
	if (event.type !== "tool_call") return "invalid_outer_event";
	if (!isRecord(event.input)) return "invalid_content";
	const path = event.input.path;
	if (typeof path !== "string") return "invalid_xdev_uri";
	const trimmedPath = path.trim();
	const toolName = trimmedPath.slice("xd://".length);
	if (!toolName || /[/?#\\]/.test(toolName) || toolName === "." || toolName === "..") return "invalid_xdev_uri";
	if (typeof event.input.content !== "string") return "invalid_content";
	const content = event.input.content.trim();
	if (/^(?:|\?|help|describe)$/i.test(content)) return "help";
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return "malformed_json";
	}
	if (!isRecord(parsed)) return "invalid_content";
	const fingerprint = canonicalArgsFingerprint(parsed);
	if (!fingerprint) return "unserializable_args";
	return "unknown_tool";
}

export function classifyToolCallEvent(event: ToolCallLike): ToolEventClassification {
	const toolCallId = stringField(event.toolCallId);
	const toolName = stringField(event.toolName);
	if (!toolCallId || !toolName) return { kind: "ignored" };
	if (event.type !== undefined && event.type !== "tool_call") return { kind: "ignored" };
	const identity = canonicalizeToolIdentity({
		toolName,
		serverName: stringField(event.serverName),
		args: eventArgs(event),
	});
	if (!identity) {
		if (!isXdevCandidate(event)) return { kind: "ignored" };
		const reason = diagnoseXdevCall(event);
		return reason === "help" ? { kind: "ignored" } : { kind: "invalid_xdev", toolCallId, reason };
	}
	if (identity.transport === "xdev" && event.type !== "tool_call") {
		return { kind: "invalid_xdev", toolCallId, reason: "invalid_outer_event" };
	}
	return {
		kind: "valid",
		event: {
			toolCallId,
			correlationId: stringField(event.parentToolCallId) ?? stringField(event.outerToolCallId) ?? toolCallId,
			identity,
		},
	};
}

export function unwrapToolCallEvent(event: ToolCallLike): UnwrappedToolEvent | null {
	const classified = classifyToolCallEvent(event);
	return classified.kind === "valid" ? classified.event : null;
}

export function classifyToolResultEvent(
	event: ToolResultLike,
	expectedQualifiedName?: string,
): ToolEventClassification {
	if (event.type !== "tool_result" || event.toolName !== "write" || !isRecord(event.input)) {
		return { kind: "ignored" };
	}
	const call = classifyToolCallEvent({ ...event, type: "tool_call" });
	if (call.kind !== "valid" || call.event.identity.transport !== "xdev") return call;
	const toolCallId = call.event.toolCallId;
	if (!isRecord(event.details) || !isRecord(event.details.xdev)) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	const xdev = event.details.xdev;
	if (xdev.mode === "help" || xdev.mode === "describe") return { kind: "ignored" };
	if (xdev.mode !== "execute" || typeof xdev.tool !== "string" || !isRecord(xdev.args)) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	if (xdev.tool !== call.event.identity.toolName) {
		return { kind: "invalid_xdev", toolCallId, reason: "tool_mismatch" };
	}
	const resultFingerprint = canonicalArgsFingerprint(xdev.args);
	if (!resultFingerprint) return { kind: "invalid_xdev", toolCallId, reason: "unserializable_args" };
	if (resultFingerprint !== call.event.identity.argsFingerprint) {
		return { kind: "invalid_xdev", toolCallId, reason: "args_mismatch" };
	}
	if (expectedQualifiedName && call.event.identity.qualifiedName !== expectedQualifiedName) {
		return { kind: "invalid_xdev", toolCallId, reason: "tool_mismatch" };
	}
	return call;
}

export function unwrapToolResultEvent(
	event: ToolResultLike,
	expectedQualifiedName?: string,
): UnwrappedToolEvent | null {
	const classified = classifyToolResultEvent(event, expectedQualifiedName);
	return classified.kind === "valid" ? classified.event : null;
}
