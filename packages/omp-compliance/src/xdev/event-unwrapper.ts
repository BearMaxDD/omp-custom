import { types as utilTypes } from "node:util";
import { codebaseToolAccess, isTrustedCodebaseServerId } from "./codebase-tool-policy";
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
	return typeof value === "object" && value !== null && !utilTypes.isProxy(value) && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface DataField {
	present: boolean;
	value: unknown;
}

function dataField(value: object, key: string): DataField | null {
	if (utilTypes.isProxy(value)) return null;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return { present: false, value: undefined };
	if (!descriptor.enumerable || !("value" in descriptor)) return null;
	return { present: true, value: descriptor.value };
}

const EVENT_FIELD_NAMES = [
	"type",
	"toolName",
	"toolCallId",
	"input",
	"params",
	"serverName",
	"parentToolCallId",
	"outerToolCallId",
	"details",
] as const;

type SafeEventFields = Record<(typeof EVENT_FIELD_NAMES)[number], unknown>;

function safeEventFields(event: ToolCallLike | ToolResultLike): SafeEventFields | null {
	if (typeof event !== "object" || event === null || utilTypes.isProxy(event)) return null;
	const fields = {} as SafeEventFields;
	for (const key of EVENT_FIELD_NAMES) {
		const field = dataField(event, key);
		if (!field) return null;
		fields[key] = field.value;
	}
	return fields;
}

function isXdevCandidate(toolName: string, args: unknown): boolean {
	if (toolName !== "write" || !isRecord(args)) return false;
	const path = dataField(args, "path");
	return Boolean(
		path?.present && typeof path.value === "string" && path.value.trim().toLowerCase().startsWith("xd://"),
	);
}

function isTrustedCodebaseCandidate(serverNameValue: unknown, toolName: string): boolean {
	const serverName = stringField(serverNameValue);
	if (serverName !== undefined && !isTrustedCodebaseServerId(serverName)) return false;
	if (codebaseToolAccess(toolName)) return serverName !== undefined;
	for (const prefix of ["mcp__codebase_memory_mcp__", "mcp__codebase_memory__"] as const) {
		if (toolName.startsWith(prefix) && codebaseToolAccess(toolName.slice(prefix.length))) return true;
	}
	return false;
}

function diagnoseXdevCall(type: unknown, args: unknown): InvalidXdevReason | "help" {
	if (type !== "tool_call") return "invalid_outer_event";
	if (!isRecord(args)) return "invalid_content";
	const path = dataField(args, "path");
	if (!path?.present || typeof path.value !== "string") return "invalid_xdev_uri";
	const trimmedPath = path.value.trim();
	const toolName = trimmedPath.slice("xd://".length);
	if (!toolName || /[/?#\\]/.test(toolName) || toolName === "." || toolName === "..") return "invalid_xdev_uri";
	const contentField = dataField(args, "content");
	if (!contentField?.present || typeof contentField.value !== "string") return "invalid_content";
	const content = contentField.value.trim();
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
	const fields = safeEventFields(event);
	if (!fields) return { kind: "ignored" };
	const toolCallId = stringField(fields.toolCallId);
	const toolName = stringField(fields.toolName);
	if (!toolCallId || !toolName) return { kind: "ignored" };
	if (fields.type !== undefined && fields.type !== "tool_call") return { kind: "ignored" };
	const args = fields.type === "tool_call" ? fields.input : fields.params;
	if (utilTypes.isProxy(args)) {
		return toolName === "write" ? { kind: "invalid_xdev", toolCallId, reason: "invalid_content" } : { kind: "ignored" };
	}
	const identity = canonicalizeToolIdentity({
		toolName,
		serverName: stringField(fields.serverName),
		args,
	});
	if (!identity) {
		if (
			isTrustedCodebaseCandidate(fields.serverName, toolName) &&
			isRecord(args) &&
			canonicalArgsFingerprint(args) === null
		) {
			return { kind: "invalid_xdev", toolCallId, reason: "unserializable_args" };
		}
		if (!isXdevCandidate(toolName, args)) return { kind: "ignored" };
		const reason = diagnoseXdevCall(fields.type, args);
		return reason === "help" ? { kind: "ignored" } : { kind: "invalid_xdev", toolCallId, reason };
	}
	if (identity.transport === "xdev" && fields.type !== "tool_call") {
		return { kind: "invalid_xdev", toolCallId, reason: "invalid_outer_event" };
	}
	return {
		kind: "valid",
		event: {
			toolCallId,
			correlationId: stringField(fields.parentToolCallId) ?? stringField(fields.outerToolCallId) ?? toolCallId,
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
	const fields = safeEventFields(event);
	if (!fields || fields.type !== "tool_result" || fields.toolName !== "write") {
		return { kind: "ignored" };
	}
	const toolCallId = stringField(fields.toolCallId);
	if (!toolCallId) return { kind: "ignored" };
	if (!isRecord(fields.input)) {
		return { kind: "invalid_xdev", toolCallId, reason: "invalid_content" };
	}
	const call = classifyToolCallEvent({
		type: "tool_call",
		toolName: fields.toolName,
		toolCallId,
		input: fields.input,
		serverName: fields.serverName,
		parentToolCallId: fields.parentToolCallId,
		outerToolCallId: fields.outerToolCallId,
	});
	if (call.kind !== "valid" || call.event.identity.transport !== "xdev") return call;
	if (!isRecord(fields.details)) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	const xdevField = dataField(fields.details, "xdev");
	if (!xdevField?.present || !isRecord(xdevField.value)) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	const mode = dataField(xdevField.value, "mode");
	const tool = dataField(xdevField.value, "tool");
	const args = dataField(xdevField.value, "args");
	if (!mode || !tool || !args) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	if (mode.value === "help" || mode.value === "describe") return { kind: "ignored" };
	if (mode.value !== "execute" || typeof tool.value !== "string" || !isRecord(args.value)) {
		return { kind: "invalid_xdev", toolCallId, reason: "missing_xdev_details" };
	}
	if (tool.value !== call.event.identity.toolName) {
		return { kind: "invalid_xdev", toolCallId, reason: "tool_mismatch" };
	}
	const resultFingerprint = canonicalArgsFingerprint(args.value);
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
