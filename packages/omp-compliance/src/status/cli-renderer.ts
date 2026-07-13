/**
 * CLI Renderer — formats a StatusSnapshot as a box-drawing panel string.
 *
 * Produces a compact terminal-friendly status display with Unicode
 * box-drawing characters and visual indicators.
 */

import type { StatusSnapshot } from "./types";

// ─── Render ─────────────────────────────────────────────────────────

/**
 * Render a StatusSnapshot into a formatted CLI panel string.
 *
 * Output resembles:
 *   ┌─ Advisor Status ─────────────────┐
 *   │ 运行时: ● Active                  │
 *   │ 子代理: 2, MCP调用: 7            │
 *   │ 建议: 1⛔ 3⚠                      │
 *   └──────────────────────────────────┘
 */
export function renderCLIStatus(snapshot: StatusSnapshot): string {
	const lines: string[] = [];

	// ── Runtime section ──────────────────────────────────────────
	const runtimeState = snapshot.runtime.state === "active" ? "● Active" : "○ Idle";
	lines.push(`  运行时: ${runtimeState}`);

	if (snapshot.runtime.currentReview) {
		const r = snapshot.runtime.currentReview;
		lines.push(`  审查:   ${r.reviewId} (${r.trigger}, ${r.elapsed}s)`);
	}

	if (snapshot.runtime.progress) {
		const p = snapshot.runtime.progress;
		lines.push(`  进度:   ${p.current}/${p.total} ${p.phase}`);
	}

	// ── Advisor session ──────────────────────────────────────────
	const subCount = snapshot.advisorSession.subagentCount;
	const mcpCount = snapshot.advisorSession.mcpCallCount;
	const sessionIcon = snapshot.advisorSession.active ? "●" : "○";
	lines.push(`  会话:   ${sessionIcon} 子代理:${subCount}, MCP:${mcpCount}`);

	if (snapshot.advisorSession.subagentIds.length > 0) {
		lines.push(`  子代理: ${snapshot.advisorSession.subagentIds.join(", ")}`);
	}

	// ── Advice summary ───────────────────────────────────────────
	const { blockers, concerns, nits } = snapshot.advice;
	const parts: string[] = [];
	if (blockers > 0) parts.push(`${blockers}⛔`);
	if (concerns > 0) parts.push(`${concerns}⚠`);
	if (nits > 0) parts.push(`${nits}🔧`);
	lines.push(`  建议:   ${parts.join(" ") || "无"}`);

	// ── Compliance ───────────────────────────────────────────────
	const complianceIcon = snapshot.compliance.active ? "●" : "○";
	let complianceLine = `  合规:   ${complianceIcon}`;
	if (snapshot.compliance.taskId) {
		complianceLine += ` ${snapshot.compliance.taskId}`;
	}
	if (snapshot.compliance.status) {
		complianceLine += ` [${snapshot.compliance.status}]`;
	}
	complianceLine += ` 尝试#${snapshot.compliance.attempt}`;
	if (snapshot.compliance.lastVerdict) {
		complianceLine += `  → ${snapshot.compliance.lastVerdict}`;
	}
	lines.push(complianceLine);

	// ── Brainstorm ───────────────────────────────────────────────
	const brainstormIcon = snapshot.brainstorm.active ? "●" : "○";
	let brainstormLine = `  头脑风暴: ${brainstormIcon}`;
	if (snapshot.brainstorm.topicId) {
		brainstormLine += ` ${snapshot.brainstorm.topicId}`;
	}
	if (snapshot.brainstorm.status) {
		brainstormLine += ` [${snapshot.brainstorm.status}]`;
	}
	if (snapshot.brainstorm.topicKind) {
		brainstormLine += ` (${snapshot.brainstorm.topicKind})`;
	}
	lines.push(brainstormLine);

	// ── Box frame ────────────────────────────────────────────────
	const contentWidth = Math.max(...lines.map((l) => l.length), 30);
	const topBorder = `┌─ Advisor Status ${"─".repeat(Math.max(0, contentWidth - 16))}┐`;
	const bottomBorder = `└${"─".repeat(contentWidth + 2)}┘`;
	const padded = lines.map((l) => `│ ${l.padEnd(contentWidth)} │`);

	return [topBorder, ...padded, bottomBorder].join("\n");
}
