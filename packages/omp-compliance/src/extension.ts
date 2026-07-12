import { join } from "node:path";
import { createComplianceAdvisorHook } from "./advisor/compliance-advisor-hook";
import { ComplianceReviewRegistry } from "./advisor/review-envelope";
import type { ComplianceReviewDependencies } from "./advisor/review-envelope";
import { registerComplianceCommand } from "./commands/compliance-command";
import { EvidenceStore } from "./evidence/evidence-store";
import { ComplianceRuntime } from "./runtime/compliance-runtime";
import { CollectorRuntime } from "./signals/collector-runtime";
import { registerComplianceCompleteTool } from "./tools/compliance-complete-tool";
import type { AdvisorBeforeRunEvent, ExtensionAPI, ExtensionContext } from "./types";

/** Default compliance store directory within the repo. */
const DEFAULT_COMPLIANCE_DIR = ".omp/compliance";

/**
 * Create a memoized EvidenceStore factory.
 * Only instantiates the store (and creates the directory) when first called.
 */
function createLazyEvidenceStore(repoRoot: string): () => EvidenceStore {
	let store: EvidenceStore | null = null;
	return () => {
		if (!store) {
			store = new EvidenceStore(join(repoRoot, DEFAULT_COMPLIANCE_DIR));
		}
		return store;
	};
}

/**
 * Activate the OMP Compliance extension.
 *
 * Wires the compliance runtime, registers the /compliance command and
 * compliance_complete tool, and sets up passive event handlers for
 * tool event collection.
 *
 * Does NOT create the evidence store directory on activation — it is
 * created lazily on the first successful /compliance start.
 */
export default function activate(api: ExtensionAPI): void {
	// Repo root: conventions assume cwd is repo root at activation
	const repoRoot = process.cwd();

	// Core infrastructure (store created lazily — no FS side-effects yet)
	const collector = new CollectorRuntime();
	const getEvidenceStore = createLazyEvidenceStore(repoRoot);

	// Review registry — shared between runtime and advisor_before_run hook
	const registry = new ComplianceReviewRegistry();

	// Session tracking: updated on session_start / session_switch
	let sessionId: string | null = null;
	api.on("session_start", (event: unknown) => {
		const ev = event as { sessionId?: string };
		if (ev.sessionId) sessionId = ev.sessionId;
	});
	api.on("session_switch", (event: unknown) => {
		const ev = event as { sessionId?: string };
		if (ev.sessionId) sessionId = ev.sessionId;
	});
	const reviewDeps: ComplianceReviewDependencies = {
		sessionId: () => {
			if (!sessionId) throw new Error("Compliance: no session binding — session_start not yet received");
			return sessionId;
		},
		registry,
		requestAdvisorReview: (request) => api.requestAdvisorReview(request),
	};

	// Compliance runtime — the main coordinator (gets factory, not store)
	const runtime = new ComplianceRuntime(getEvidenceStore, collector, api, repoRoot, reviewDeps);

	// Register advisor_before_run hook
	api.on("advisor_before_run", (event: unknown, _context: ExtensionContext) => {
		return createComplianceAdvisorHook(registry, runtime)(event as AdvisorBeforeRunEvent);
	});

	// Register command and tool
	registerComplianceCommand(api, runtime);
	registerComplianceCompleteTool(api, runtime);

	// Passive event handlers — all return undefined (no blocking)
	api.on("tool_call", (event) => collector.recordToolCall(event as Record<string, unknown>));
	api.on("tool_result", (event) => collector.recordToolResult(event as Record<string, unknown>));
	api.on("turn_end", (event) => collector.recordTurnEnd(event as Record<string, unknown>));
	api.on("agent_end", () => collector.refreshPresentation());
}
