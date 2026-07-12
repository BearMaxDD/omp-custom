import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "./types";
import { CollectorRuntime } from "./signals/collector-runtime";
import { EvidenceStore } from "./evidence/evidence-store";
import { ComplianceRuntime } from "./runtime/compliance-runtime";
import { registerComplianceCommand } from "./commands/compliance-command";
import { registerComplianceCompleteTool } from "./tools/compliance-complete-tool";

/** Default evidence store directory within the repo. */
const DEFAULT_EVIDENCE_DIR = ".omp/evidence";

/**
 * Activate the OMP Compliance extension.
 *
 * Wires the compliance runtime, registers the /compliance command and
 * compliance_complete tool, and sets up passive event handlers for
 * tool event collection.
 */
export default function activate(api: ExtensionAPI): void {
	// Repo root: conventions assume cwd is repo root at activation
	const repoRoot = process.cwd();

	// Ensure evidence directory exists
	const evidenceDir = join(repoRoot, DEFAULT_EVIDENCE_DIR);
	if (!existsSync(evidenceDir)) {
		mkdirSync(evidenceDir, { recursive: true });
	}

	// Core infrastructure
	const collector = new CollectorRuntime();
	const store = new EvidenceStore(evidenceDir);

	// Compliance runtime — the main coordinator
	const runtime = new ComplianceRuntime(store, collector, api, repoRoot);

	// Register command and tool
	registerComplianceCommand(api, runtime);
	registerComplianceCompleteTool(api, runtime);

	// Passive event handlers — all return undefined (no blocking)
	api.on("tool_call", (event) => collector.recordToolCall(event as Record<string, unknown>));
	api.on("tool_result", (event) => collector.recordToolResult(event as Record<string, unknown>));
	api.on("turn_end", (event) => collector.recordTurnEnd(event as Record<string, unknown>));
	api.on("agent_end", () => collector.refreshPresentation());
}
