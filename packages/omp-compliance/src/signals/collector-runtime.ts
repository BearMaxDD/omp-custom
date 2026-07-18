/**
 * Collector Runtime — bridges ExtensionAPI events to the ToolEventCollector.
 *
 * Provides typed methods for each event handler the extension registers.
 * All methods return undefined to comply with the passive handler contract.
 */

import { types as utilTypes } from "node:util";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ToolEventCollector } from "./tool-event-collector";
import type { EvidenceSnapshot } from "./types";

declare const trustedCodebaseEvidenceReader: unique symbol;

export interface TrustedCodebaseEvidenceReader {
	readonly [trustedCodebaseEvidenceReader]: true;
}

export interface ControlledCollectorRuntime {
	readonly runtime: CollectorRuntime;
	readonly reader: TrustedCodebaseEvidenceReader;
}

const trustedReaders = new WeakMap<object, CollectorRuntime>();

export class CollectorRuntime {
	readonly collector = new ToolEventCollector();

	recordToolCall(event: ToolCallEvent, context: ExtensionContext): undefined {
		this.collector.recordCall(event, context);
		return undefined;
	}

	recordToolResult(event: ToolResultEvent, context: ExtensionContext): undefined {
		this.collector.recordResult(event, context);
		return undefined;
	}

	invalidateCodebaseEvidence(): undefined {
		this.collector.invalidateCodebaseMemory();
		return undefined;
	}

	recordTurnEnd(_event: Record<string, unknown>): undefined {
		return undefined;
	}

	refreshPresentation(): undefined {
		return undefined;
	}
}

/** Internal host boundary. This module is not a public package export. */
export function createControlledCollectorRuntime(): ControlledCollectorRuntime {
	const runtime = new CollectorRuntime();
	const reader = Object.freeze({}) as TrustedCodebaseEvidenceReader;
	trustedReaders.set(reader, runtime);
	return Object.freeze({ runtime, reader });
}

/** @internal Consumed only by the Task12 evidence model. */
export function snapshotTrustedCodebaseEvidence(reader: TrustedCodebaseEvidenceReader): EvidenceSnapshot {
	if (typeof reader !== "object" || reader === null || utilTypes.isProxy(reader)) {
		throw new TypeError("invalid_trusted_reader");
	}
	const runtime = trustedReaders.get(reader);
	if (!runtime) throw new TypeError("invalid_trusted_reader");
	return ToolEventCollector.prototype.snapshot.call(runtime.collector);
}
