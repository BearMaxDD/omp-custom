/**
 * Brainstorm Command — handles `/brainstorm status`, `/brainstorm history <topic_id>`,
 * `/brainstorm retry <topic_id>`, and `/brainstorm park <topic_id>`.
 *
 * Delegates lifecycle operations to TopicCoordinator.
 * Status and history are READ-ONLY projections — no side effects.
 * retry only accepts review_unavailable topics — transitions to drafting.
 * park records decision without deleting history.
 */

import type { TopicCoordinator } from "../brainstorm/topic-coordinator";
import type { ExtensionAPI } from "../types";

// ─── Command Registration ───────────────────────────────────────────

/**
 * Register the /brainstorm command on the extension API.
 *
 * Subcommands:
 *   status              — show current topic status (read-only)
 *   history <topic_id>  — show chronological event history (read-only)
 *   retry <topic_id>    — retry a review_unavailable topic
 *   park <topic_id>     — park a topic without deleting history
 */
/** Lazy getter for TopicCoordinator — avoids FS side effects at registration time. */
type CoordinatorGetter = () => TopicCoordinator;
export function registerBrainstormCommand(api: ExtensionAPI, getCoordinator: CoordinatorGetter): void {
	api.registerCommand("brainstorm", {
		description:
			"Manage brainstorm topics. " +
			"Usage: /brainstorm status | history <topic_id> | retry <topic_id> | park <topic_id>",
		getArgumentCompletions: () => ["status", "history", "retry", "park"],
		handler: async (args: string[]) => {
			if (args.length === 0) {
				throw new Error("用法: /brainstorm status | history <topic_id> | retry <topic_id> | park <topic_id>");
			}
			const coordinator = getCoordinator();
			const subcommand = args[0].toLowerCase();
			switch (subcommand) {
				case "status": {
					handleStatus(coordinator);
					break;
				}
				case "history": {
					await handleHistory(coordinator, args.slice(1));
					break;
				}
				case "retry": {
					await handleRetry(coordinator, args.slice(1));
					break;
				}
				case "park": {
					await handlePark(coordinator, args.slice(1));
					break;
				}
				default:
					throw new Error(
						`未知子命令: ${subcommand}. 用法: /brainstorm status | history <topic_id> | retry <topic_id> | park <topic_id>`,
					);
			}
		},
	});
}

// ─── Subcommand Handlers ────────────────────────────────────────────

function handleStatus(coordinator: TopicCoordinator): void {
	const topic = coordinator.current();
	if (!topic) {
		console.log("暂无活跃专题。");
		return;
	}

	console.log("=".repeat(50));
	console.log("Brainstorm 专题状态");
	console.log("=".repeat(50));
	console.log(`专题 ID:   ${topic.topicId}`);
	console.log(`标题:      ${topic.input.title}`);
	console.log(`类别:      ${topic.input.topic_kind}`);
	console.log(`状态:      ${topic.status}`);
	console.log(`尝试次数:  ${topic.attempt}`);
	if (topic.decision) {
		console.log(`决策:      ${topic.decision.decision}`);
		if (topic.decision.selected_alternative) {
			console.log(`选定方案:  ${topic.decision.selected_alternative}`);
		}
		if (topic.decision.rationale) {
			console.log(`理由:      ${topic.decision.rationale}`);
		}
	}
	console.log("-".repeat(50));
}

async function handleHistory(coordinator: TopicCoordinator, args: string[]): Promise<void> {
	if (args.length === 0) {
		throw new Error("用法: /brainstorm history <topic_id>");
	}

	const topicId = args[0];
	const events = await coordinator.getTopicEvents(topicId);
	if (events.length === 0) {
		console.log(`专题 "${topicId}" 无历史事件。`);
		return;
	}

	console.log("=".repeat(50));
	console.log(`专题事件历史: ${topicId}`);
	console.log("=".repeat(50));
	for (const event of events) {
		const ts = (event as Record<string, unknown>).ts ?? "?";
		const eventName = (event as Record<string, unknown>).event ?? "?";
		const extra = Object.entries(event)
			.filter(([k]) => k !== "ts" && k !== "event" && k !== "topicId" && k !== "schemaVersion")
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join(", ");
		console.log(`[${ts}] ${eventName}${extra ? ` (${extra})` : ""}`);
	}
	console.log("-".repeat(50));
}

async function handleRetry(coordinator: TopicCoordinator, args: string[]): Promise<void> {
	if (args.length === 0) {
		throw new Error("用法: /brainstorm retry <topic_id>");
	}

	const topicId = args[0];
	const topic = coordinator.current();

	if (!topic || topic.topicId !== topicId) {
		throw new Error(`专题 "${topicId}" 不是当前活跃专题。`);
	}

	if (topic.status !== "review_unavailable") {
		throw new Error(`无法重试: 专题状态为 "${topic.status}"，仅 review_unavailable 可重试。`);
	}

	if (!topic.review) {
		console.log(`专题 "${topicId}" 之前无 review，直接重试。`);
	}

	await coordinator.markReady(topicId);

	console.log(`专题 "${topicId}" 已重置为 ready_for_advisor_review，可重新提交评审。`);
}

async function handlePark(coordinator: TopicCoordinator, args: string[]): Promise<void> {
	if (args.length === 0) {
		throw new Error("用法: /brainstorm park <topic_id>");
	}

	const topicId = args[0];
	const topic = coordinator.current();

	if (!topic || topic.topicId !== topicId) {
		throw new Error(`专题 "${topicId}" 不是当前活跃专题。`);
	}

	if (topic.status !== "awaiting_user_decision") {
		throw new Error(`无法暂存: 专题状态为 "${topic.status}"，仅等待用户决策时方可暂存。`);
	}

	await coordinator.recordDecision(topicId, {
		topic_id: topicId,
		decision: "park",
		rationale: "用户暂存",
		ts: new Date().toISOString(),
	});

	console.log(`专题 "${topicId}" 已暂存。`);
}
