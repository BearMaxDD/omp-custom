/**
 * Tests for brainstorm-command — /brainstorm status|history|retry|park.
 *
 * Delegates lifecycle operations to TopicCoordinator.
 * Status and history are READ-ONLY projections.
 * retry only accepts review_unavailable topics.
 * park records the decision without deleting history.
 */

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicCoordinator } from "../../src/brainstorm/topic-coordinator";
import { TopicStore } from "../../src/brainstorm/topic-store";
import { registerBrainstormCommand } from "../../src/commands/brainstorm-command";
import { fullCodebaseSnapshot, validReview, validTopicInput } from "../brainstorm/fixtures";

// ─── Mock ExtensionAPI ───────────────────────────────────────────────

interface MockCommand {
	name: string;
	description?: string;
	completions?: string[];
	handler: (args: string[]) => Promise<void> | void;
}

function createMockApi(): {
	api: { registerCommand: (name: string, opts: Record<string, unknown>) => void };
	commands: MockCommand[];
} {
	const commands: MockCommand[] = [];
	const api = {
		registerCommand: (name: string, opts: Record<string, unknown>) => {
			const o = opts as {
				description?: string;
				getArgumentCompletions?: () => string[];
				handler: (args: string[]) => Promise<void> | void;
			};
			commands.push({
				name,
				description: o.description,
				completions: o.getArgumentCompletions?.(),
				handler: o.handler,
			});
		},
	};
	return { api, commands };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `br-cmd-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function makeCoordinatorWithReview(): Promise<TopicCoordinator> {
	const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
	const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	await coordinator.markReviewRequested(topic.topicId, "review-1");
	await coordinator.acceptReview(validReview(topic));
	return coordinator;
}

async function makeCoordinatorReviewUnavailable(): Promise<TopicCoordinator> {
	const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
	const { topic } = await coordinator.submit(validTopicInput(), fullCodebaseSnapshot());
	await coordinator.markReviewRequested(topic.topicId, "review-1");
	await coordinator.markReviewUnavailable(topic.topicId, "Advisor unavailable");
	return coordinator;
}

async function getCommandHandler(coordinator: TopicCoordinator): Promise<(args: string[]) => Promise<void>> {
	const { api, commands } = createMockApi();
	registerBrainstormCommand(api as never, () => coordinator);
	const cmd = commands.find((c) => c.name === "brainstorm");
	if (!cmd) throw new Error("brainstorm command not registered");
	return cmd.handler;
}

// ─── registerBrainstormCommand ───────────────────────────────────────

describe("registerBrainstormCommand", () => {
	it("registers the brainstorm command with expected completions", () => {
		const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
		const { api, commands } = createMockApi();
		registerBrainstormCommand(api as never, coordinator);
		const cmd = commands.find((c) => c.name === "brainstorm");
		expect(cmd).toBeDefined();
		expect(cmd!.description).toBeTruthy();
		expect(cmd!.completions).toEqual(["status", "history", "retry", "park"]);
	});

	it("shows status with current topic info", async () => {
		const coordinator = await makeCoordinatorWithReview();
		const handler = await getCommandHandler(coordinator);
		let output = "";
		const origLog = console.log;
		console.log = (msg: string) => {
			output += msg + "\n";
		};
		try {
			await handler(["status"]);
		} finally {
			console.log = origLog;
		}
		expect(output).toContain("awaiting_user_decision");
	});

	it("shows status when no active topic exists", async () => {
		const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
		const handler = await getCommandHandler(coordinator);
		let output = "";
		const origLog = console.log;
		console.log = (msg: string) => {
			output += msg + "\n";
		};
		try {
			await handler(["status"]);
		} finally {
			console.log = origLog;
		}
		expect(output).toContain("暂无活跃");
	});

	it("shows history with events", async () => {
		const coordinator = await makeCoordinatorWithReview();
		const current = coordinator.current()!;
		const handler = await getCommandHandler(coordinator);
		let output = "";
		const origLog = console.log;
		console.log = (msg: string) => {
			output += msg + "\n";
		};
		try {
			await handler(["history", current.topicId]);
		} finally {
			console.log = origLog;
		}
		expect(output).toContain("topic_created");
		expect(output).toContain("review_requested");
		expect(output).toContain("review_received");
	});

	it("rejects retry when topic is not review_unavailable", async () => {
		const coordinator = await makeCoordinatorWithReview();
		const current = coordinator.current()!;
		const handler = await getCommandHandler(coordinator);
		await expect(handler(["retry", current.topicId])).rejects.toThrow("review_unavailable");
	});

	it("retries a review_unavailable topic", async () => {
		const coordinator = await makeCoordinatorReviewUnavailable();
		const current = coordinator.current()!;
		const handler = await getCommandHandler(coordinator);
		await handler(["retry", current.topicId]);
		expect(coordinator.current()!.status).toBe("ready_for_advisor_review");
	});

	it("parks a topic without deleting history", async () => {
		const coordinator = await makeCoordinatorWithReview();
		const current = coordinator.current()!;
		const handler = await getCommandHandler(coordinator);
		await handler(["park", current.topicId]);
		expect(coordinator.current()!.status).toBe("parked");
		expect(coordinator.current()!.decision).toBeDefined();
		expect(coordinator.current()!.decision?.decision).toBe("park");

		// History should still be accessible
		const events = await coordinator.getTopicEvents(current.topicId);
		expect(events.length).toBeGreaterThan(0);
	});

	it("throws error for unknown subcommand", async () => {
		const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
		const handler = await getCommandHandler(coordinator);
		await expect(handler(["unknown"])).rejects.toThrow("未知");
	});

	it("throws usage error when no args given", async () => {
		const coordinator = new TopicCoordinator(new TopicStore(tempDir()));
		const handler = await getCommandHandler(coordinator);
		await expect(handler([])).rejects.toThrow("用法");
	});
});
