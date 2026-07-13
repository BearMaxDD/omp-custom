/**
 * Main Agent Guidance — injects per-turn brainstorm topic submission rules
 * and auto-trigger guidance into the main agent's system prompt.
 *
 * The guidance instructs the main agent when and how to call the
 * brainstorm_topic_ready tool for an independent advisor review.
 */

// ─── Guidance Text ─────────────────────────────────────────────────────

/**
 * Render the brainstorm topic review guidance as a system prompt section.
 *
 * The rendered text is appended before each agent start, reminding the
 * main agent to call brainstorm_topic_ready only for substantive,
 * converged topics.
 */
export function renderMainAgentBrainstormGuidance(): string {
	return `\
---
## Brainstorm Topic Review

When the conversation has converged on a substantive design/architecture/scope/contract/migration/risk/implementation_route decision, call the \`brainstorm_topic_ready\` tool to request an independent advisor review.

The tool accepts:
- topic_kind: one of architecture | scope | contract | migration | risk | implementation_route
- title: short descriptive title (max 200 chars)
- candidate_decision: the main conclusion (max 4,000 chars)
- constraints: list of bounding constraints (max 30 items)
- success_criteria: list of measurable outcomes (max 30 items)
- codebase_relevance: "required" | "optional" | "none"
- discussion_summary: free-text summary of prior discussion (max 8,000 chars)
- unresolved_questions: optional list of open questions (max 30 items)

Do not call for wording, simple clarification, or factual lookup.
Only submit when the topic is substantive and the candidate decision is well-formed.
The advisor will independently challenge the decision.`;
}

// ─── Event Types ───────────────────────────────────────────────────────

export interface BeforeAgentStartEvent {
	readonly systemPrompt: readonly string[];
}

export interface BeforeAgentStartEventResult {
	readonly systemPrompt: readonly string[];
}

// ─── Hook ──────────────────────────────────────────────────────────────

/**
 * Append brainstorm topic review guidance to the system prompt before
 * each agent start.
 *
 * This is the before_agent_start handler that injects the guidance into
 * the main agent's context on every turn.
 */
export function appendBrainstormGuidance(event: BeforeAgentStartEvent): BeforeAgentStartEventResult {
	return { systemPrompt: [...event.systemPrompt, renderMainAgentBrainstormGuidance()] };
}
