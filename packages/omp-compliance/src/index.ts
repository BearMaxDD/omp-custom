/**
 * @bearmaxdd/omp-compliance — OMP Advisor Compliance Extension
 *
 * Provides compliance checking, task completion tracking, and
 * repository standard enforcement for Oh My Pi projects.
 */

// Export types for consumers
export type {
	ExtensionAPI,
	ToolDefinition,
	CustomMessagePayload,
	ToolCallEventResult,
} from "./types";

// The extension activation function is the primary entry point
export { default as activate } from "./extension";
