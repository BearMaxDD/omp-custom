/**
 * Decision Card Renderer — produces a human-readable decision card
 * for a brainstorm topic after the advisor review is complete.
 *
 * The card includes:
 *   - Current conclusion (candidate decision)
 *   - Advisor objections (high-impact findings)
 *   - Alternative options
 *   - User confirmation prompt
 */

import type { BrainstormTopicState } from "./types";

// ─── Render ──────────────────────────────────────────────────────────

/**
 * Render a human-readable decision card for a brainstorm topic.
 *
 * When the topic has a review, the card shows the candidate decision,
 * any high-impact advisor findings, alternative options, and prompts
 * the user to make an explicit decision.
 *
 * Without a review, the card notes that no review results are available.
 */
export function renderDecisionCard(topic: BrainstormTopicState): string {
	const lines: string[] = [];

	// ── Header ──────────────────────────────────────────────────────
	lines.push("=".repeat(60));
	lines.push("专题决策卡");
	lines.push("=".repeat(60));
	lines.push(`专题: ${topic.input.title}`);
	lines.push(`类别: ${topic.input.topic_kind}`);
	lines.push(`状态: ${topic.status}`);
	lines.push("");

	// ── Current Conclusion ──────────────────────────────────────────
	lines.push("── 当前结论 ──");
	lines.push(topic.input.candidate_decision);
	lines.push("");

	// ── Constraints ─────────────────────────────────────────────────
	if (topic.input.constraints.length > 0) {
		lines.push("── 约束条件 ──");
		for (const c of topic.input.constraints) {
			lines.push(`  • ${c}`);
		}
		lines.push("");
	}

	// ── Advisor Review ──────────────────────────────────────────────
	if (topic.review) {
		const review = topic.review;
		lines.push("── Advisor 评审摘要 ──");
		lines.push(review.summary);
		lines.push(`评审状态: ${review.status} | 置信度: ${review.confidence}`);
		lines.push("");

		// High/Low impact findings
		const highImpact = review.findings.filter((f) => f.impact === "high");
		if (highImpact.length > 0) {
			lines.push("── Advisor 异议（高优先级）──");
			for (const f of highImpact) {
				lines.push(`  [!] [${f.category}] ${f.statement}`);
			}
			lines.push("");
		}

		const otherFindings = review.findings.filter((f) => f.impact !== "high");
		if (otherFindings.length > 0) {
			lines.push("── Advisor 其他发现 ──");
			for (const f of otherFindings) {
				lines.push(`  • [${f.category}] ${f.statement}`);
			}
			lines.push("");
		}

		// Alternatives
		if (review.alternatives.length > 0) {
			lines.push("── 可选替代方案 ──");
			for (const alt of review.alternatives) {
				lines.push(`  [${alt.name}]`);
				lines.push(`    描述: ${alt.description}`);
				if (alt.tradeoffs.length > 0) {
					lines.push("    权衡:");
					for (const t of alt.tradeoffs) {
						lines.push(`      - ${t}`);
					}
				}
				lines.push(`    适用场景: ${alt.when_to_choose}`);
				lines.push("");
			}
		} else {
			lines.push("── 可选替代方案 ──");
			lines.push("  无可用替代方案");
			lines.push("");
		}

		// Recommendation
		lines.push("── Advisor 建议 ──");
		lines.push(review.recommendation);
		lines.push("");
	} else {
		lines.push("暂无可审查结果。");
		lines.push("");
	}

	// ── Decision Prompt ─────────────────────────────────────────────
	lines.push("── 决策入口 ──");
	lines.push("需要用户明确选择。请使用 brainstorm_decision 工具确认：");
	lines.push("  1. accept_candidate — 接受当前候选结论");
	lines.push("  2. accept_alternative — 采纳 Advisor 的替代方案");
	lines.push("  3. reopen — 重新讨论");
	lines.push("  4. park — 暂存，稍后处理");
	lines.push("");
	lines.push("=".repeat(60));

	return lines.join("\n");
}
