/**
 * TUI (Terminal UI) Renderer — formats a StatusSnapshot as a compact
 * one-line status string and optional footer for the OMP status bar.
 *
 * Produces output suitable for ctx.ui.setStatus() / setFooter().
 */

import type { StatusSnapshot } from "./types";

// ─── Render ─────────────────────────────────────────────────────────

/**
 * Render a StatusSnapshot into a compact TUI status line and footer.
 *
 * Status line:
 *   [● Active] compliance_review · 2 sub · 7 MCP · 1⛔ 3⚠
 *
 * Footer (when compliance is active):
 *   task-foo ● advisor_reviewing
 */
export function renderTUIStatus(snapshot: StatusSnapshot): { status: string; footer: string } {
	const runtime = snapshot.runtime.state === "active" ? "● Active" : "○ Idle";
	const review = snapshot.runtime.currentReview?.trigger ?? "-";
	const sub = snapshot.advisorSession.subagentCount ?? 0;
	const mcp = snapshot.advisorSession.mcpCallCount ?? 0;
	const b = snapshot.advice.blockers ?? 0;
	const c = snapshot.advice.concerns ?? 0;

	return {
		status: `[${runtime}] ${review} · ${sub} sub · ${mcp} MCP · ${b}⛔ ${c}⚠`,
		footer: snapshot.compliance.active
			? `${snapshot.compliance.taskId} ● ${snapshot.compliance.status}`
			: "",
	};
}
