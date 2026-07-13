/**
 * Collector Runtime — bridges ExtensionAPI events to the ToolEventCollector.
 *
 * Provides typed methods for each event handler the extension registers.
 * All methods return undefined to comply with the passive handler contract.
 */

import { ToolEventCollector } from "./tool-event-collector";

export class CollectorRuntime {
	readonly collector = new ToolEventCollector();

	recordToolCall(event: Record<string, unknown>): undefined {
		this.collector.recordCall(event);
		return undefined;
	}

	recordToolResult(event: Record<string, unknown>): undefined {
		this.collector.recordResult(event);
		return undefined;
	}

	recordTurnEnd(_event: Record<string, unknown>): undefined {
		return undefined;
	}

	refreshPresentation(): undefined {
		return undefined;
	}
}
