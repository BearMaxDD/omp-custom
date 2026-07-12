/**
 * Tests for Brainstorm TopicStore — atomic JSONL persistence.
 *
 * Uses real temporary directories for each test group to isolate
 * file-system state. All tests are deterministic.
 */

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicStore } from "../../src/brainstorm/topic-store";
import type { BrainstormDecision, BrainstormTopicState } from "../../src/brainstorm/types";
import { fullCodebaseSnapshot, makeTopicState, validReview, validTopicInput } from "./fixtures";

// ─── Helpers ─────────────────────────────────────────────────────────

function tempDir(): string {
	const dir = join(tmpdir(), `topic-store-test-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── Suite ───────────────────────────────────────────────────────────

describe("TopicStore", () => {
	// ── Initialization ──────────────────────────────────────────────

	it("creates the brainstorms state directory on construction", () => {
		const dir = tempDir();
		const _store = new TopicStore(dir);
		expect(existsSync(join(dir, "state.json"))).toBe(false); // no state yet
		expect(existsSync(join(dir, "topics"))).toBe(true); // topics directory created
	});

	it("returns null from load() when no state file exists", () => {
		const store = new TopicStore(tempDir());
		expect(store.load()).toBeNull();
	});

	it("returns null from loadState() after a fresh construction", async () => {
		const store = new TopicStore(tempDir());
		const state = await store.loadState();
		expect(state).toBeNull();
	});

	// ── State Write / Read ──────────────────────────────────────────

	it("round-trips a topic state through atomic write and load", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();

		await store.saveState(topic);

		const loaded = store.load();
		expect(loaded).not.toBeNull();
		expect(loaded?.topicId).toBe(topic.topicId);
		expect(loaded?.inputHash).toBe(topic.inputHash);
		expect(loaded?.status).toBe(topic.status);
		expect(loaded?.attempt).toBe(topic.attempt);
	});

	it("overwrites state atomically on repeated save", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic1 = makeTopicState(validTopicInput({ title: "first" }));
		const topic2 = makeTopicState(validTopicInput({ title: "second" }));

		await store.saveState(topic1);
		await store.saveState(topic2);

		const loaded = store.load();
		expect(loaded?.input.title).toBe("second");
	});

	it("does not leave a dangling .tmp file after successful write", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();

		await store.saveState(topic);

		const content = readFileSync(join(dir, "state.json"), "utf-8");
		expect(content.length).toBeGreaterThan(0);
		expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
	});

	// ── JSONL Event Log ─────────────────────────────────────────────

	it("appends events to the JSONL log for a topic", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();

		await store.appendEvent(topic.topicId, "topic_created", { attempt: 1 });

		const events = await store.readEvents(topic.topicId);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "topic_created",
			topicId: topic.topicId,
		});
	});

	it("appends multiple events in order", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();

		await store.appendEvent(topic.topicId, "topic_created", { attempt: 1 });
		await store.appendEvent(topic.topicId, "review_requested", { reviewId: "r1" });
		await store.appendEvent(topic.topicId, "review_received", { reviewId: "r1" });

		const events = await store.readEvents(topic.topicId);
		expect(events).toHaveLength(3);
		expect(events.map((e) => e.event)).toEqual(["topic_created", "review_requested", "review_received"]);
	});

	it("tolerates a truncated last line in JSONL (crash recovery)", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();
		const logDir = join(dir, "topics");

		const validLine1 = JSON.stringify({
			event: "topic_created",
			topicId: topic.topicId,
			attempt: 1,
			ts: new Date().toISOString(),
			schemaVersion: 1,
		});
		const validLine2 = JSON.stringify({
			event: "review_requested",
			topicId: topic.topicId,
			reviewId: "r1",
			ts: new Date().toISOString(),
			schemaVersion: 1,
		});
		const partialLine = '{"event":"review_received","topicId":"';

		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, `${topic.topicId}.jsonl`), `${validLine1}\n${validLine2}\n${partialLine}`, "utf-8");

		const events = await store.readEvents(topic.topicId);
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.event)).toEqual(["topic_created", "review_requested"]);
	});

	it("returns empty events for a topic with no log file", async () => {
		const store = new TopicStore(tempDir());
		const events = await store.readEvents("nonexistent-topic");
		expect(events).toEqual([]);
	});

	// ── Reset / Clear ───────────────────────────────────────────────

	it("clears all state and event files on reset", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();

		await store.saveState(topic);
		await store.appendEvent(topic.topicId, "topic_created", { attempt: 1 });
		expect(store.load()).not.toBeNull();

		store.reset();
		expect(store.load()).toBeNull();
	});

	// ── Edge Cases ──────────────────────────────────────────────────

	it("handles concurrent state writes without throwing", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const promises = Array.from({ length: 10 }, (_, i) => {
			const t = makeTopicState(validTopicInput({ title: `concurrent-${i}` }));
			return store.saveState(t);
		});

		await Promise.all(promises);
		const loaded = store.load();
		expect(loaded).not.toBeNull();
	});

	it("reads empty JSONL file gracefully", async () => {
		const dir = tempDir();
		const store = new TopicStore(dir);
		const topic = makeTopicState();
		const logDir = join(dir, "topics");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, `${topic.topicId}.jsonl`), "", "utf-8");

		const events = await store.readEvents(topic.topicId);
		expect(events).toEqual([]);
	});
});
