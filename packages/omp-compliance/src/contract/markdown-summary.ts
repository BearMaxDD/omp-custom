/**
 * Limited-content summary extraction from TDD markdown.
 *
 * Parses structured sections (goal, scope, files, tests, verification,
 * completion criteria) from a TDD document and extracts a bounded
 * amount of content per section. The original source text is always
 * preserved as the authoritative contract — an incomplete summary is
 * never a local failure verdict.
 *
 * The goal (h1) is extracted from the heading line itself rather than
 * from content between headings since the heading IS the goal title.
 * Other sections (h2) extract content between their heading and the
 * next heading.
 */

import type { ContractSummary } from "./types";

/** Per-section heading patterns (supports Chinese and English). */
const SECTION_HEADINGS: Record<keyof ContractSummary, RegExp> = {
	goal: /^#\s*(?:目标|Goal|Objective)(?:[：:\s]|$)/im,
	scope: /^##\s*(?:范围|Scope)(?:[：:\s]|$)/im,
	files: /^##\s*(?:文件|Files)(?:[：:\s]|$)/im,
	tests: /^##\s*(?:测试|Tests)(?:[：:\s]|$)/im,
	verification: /^##\s*(?:验证|Verification)(?:[：:\s]|$)/im,
	completionCriteria: /^##\s*(?:完成条件|Completion)(?:[：:\s]|$)/im,
};

/** Regex to extract the title text after the heading prefix. */
const GOAL_EXTRACTOR = /^#\s*(?:目标|Goal|Objective)[：:]\s*(.+)$/i;

/** Any markdown heading that could delimit sections. */
const ANY_HEADING = /^#{1,6}\s+\S/m;

/** Maximum lines of content to capture per section (h2 sections). */
const MAX_LINES_PER_SECTION = 10;

/**
 * Extract a bounded summary from TDD markdown sections.
 *
 * For the goal (h1 heading), captures the title text after the heading
 * marker. For each other section (h2), reads content until the next
 * heading and captures up to MAX_LINES_PER_SECTION non-empty lines.
 *
 * Returns both the summary and a status flag: "complete" if all six
 * sections were found, "incomplete" otherwise.
 */
export function extractContractSummary(markdown: string): {
	summary: ContractSummary;
	summaryStatus: "complete" | "incomplete";
} {
	const lines = markdown.split("\n");

	const summary: ContractSummary = {
		goal: undefined,
		scope: [],
		files: [],
		tests: [],
		verification: [],
		completionCriteria: [],
	};

	const sections = Object.keys(SECTION_HEADINGS) as Array<keyof ContractSummary>;

	for (const key of sections) {
		const headingRegex = SECTION_HEADINGS[key];
		const startIdx = lines.findIndex((line) => headingRegex.test(line));
		if (startIdx === -1) continue;

		if (key === "goal") {
			// Extract goal text from the heading line directly
			const headingLine = lines[startIdx];
			const goalMatch = GOAL_EXTRACTOR.exec(headingLine);
			summary.goal = goalMatch?.[1]?.trim() ?? undefined;
			continue;
		}

		// For h2 sections, extract content between this heading and the next
		const contentStart = startIdx + 1;
		let endIdx = -1;
		for (let i = contentStart; i < lines.length; i++) {
			if (ANY_HEADING.test(lines[i])) {
				endIdx = i;
				break;
			}
		}

		const sectionLines = lines
			.slice(contentStart, endIdx === -1 ? undefined : endIdx)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("---"))
			.filter((l) => !/^```/.test(l));

		const captured = sectionLines.slice(0, MAX_LINES_PER_SECTION);
		(summary[key] as string[]) = captured;
	}

	const foundCount = sections.filter((key) =>
		key === "goal" ? summary.goal !== undefined : (summary[key] as string[]).length > 0,
	).length;

	const summaryStatus = foundCount >= sections.length ? "complete" : "incomplete";

	return { summary, summaryStatus };
}
