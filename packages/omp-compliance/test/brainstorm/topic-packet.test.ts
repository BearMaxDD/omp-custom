/**
 * Tests for buildTopicPacket and renderTopicPacket — constructing bounded
 * XML-safe advisor context from a BrainstormTopicState and EvidenceSnapshot.
 */

import { describe, expect, it } from "bun:test";
import { buildTopicPacket, renderTopicPacket } from "../../src/brainstorm/topic-packet";
import { fullCodebaseSnapshot, makeTopicState, validTopicInput } from "./fixtures";

describe("buildTopicPacket / renderTopicPacket", () => {
	it("builds deterministic bounded XML-safe advisor context", () => {
		const topic = makeTopicState(validTopicInput(), fullCodebaseSnapshot());
		const packet = buildTopicPacket(topic, fullCodebaseSnapshot());
		const rendered = renderTopicPacket(packet);
		expect(rendered).toContain("<brainstorm-topic>");
		expect(rendered).toContain("topic_id:");
		expect(rendered).not.toContain("Authorization:");
		expect(rendered.length).toBeLessThanOrEqual(16_000);
	});
});
