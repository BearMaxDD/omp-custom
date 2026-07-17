import { beforeEach, describe, expect, it } from "bun:test";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SHA256Hash } from "../../src/contract/types";
import { injectRemediation } from "../../src/remediation/inject-required-fix";

// ─── Fake API that captures sent messages ───────────────────────────

class FakeRemediationAPI {
	public sent: Array<{ message: unknown; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];

	registerTool(): void {}
	registerCommand(): void {}
	on(): void {}
	appendEntry(): void {}

	sendMessage(message: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }): void {
		this.sent.push({ message, options });
	}

	logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ─── Tests ──────────────────────────────────────────────────────────

function api(): FakeRemediationAPI {
	return new FakeRemediationAPI();
}

describe("injectRemediation", () => {
	it("should send a compliance_remediation message with findings", () => {
		const ext = api();
		const sent = injectRemediation(ext, {
			taskId: "task-abc",
			contractHash: "sha256:def" as SHA256Hash,
			findings: [
				{
					id: "finding-1",
					reason: "Missing test coverage",
					requiredFix: "Add unit tests for edge cases",
					evidenceRefs: ["evidence://task-abc"],
				},
			],
		});

		expect(sent).toBe(true);
		expect(ext.sent).toHaveLength(1);

		const msg = ext.sent[0];
		expect(msg.options?.deliverAs).toBe("nextTurn");
		expect(msg.options?.triggerTurn).toBe(true);

		const payload = msg.message as CustomMessagePayload;
		expect(payload.customType).toBe("compliance_remediation");
	});

	it("should include task id, contract hash, and findings in the payload", () => {
		const ext = api();
		injectRemediation(ext, {
			taskId: "task-xyz",
			contractHash: "sha256:123" as SHA256Hash,
			findings: [
				{
					id: "finding-1",
					reason: "Missing tests",
					requiredFix: "Write tests for the API handler",
					evidenceRefs: ["evidence://task-xyz/verification"],
				},
				{
					id: "finding-2",
					reason: "Lint errors",
					requiredFix: "Run biome check and fix warnings",
					evidenceRefs: ["evidence://task-xyz/lint"],
				},
			],
		});
		const msg = ext.sent[0].message;
		expect(msg).toBeDefined();
		if (msg && typeof msg === "object" && "details" in msg) {
			const payload = msg.details as Record<string, unknown>;
			expect(payload.taskId).toBe("task-xyz");
			expect(payload.contractHash).toBe("sha256:123");
			if (Array.isArray(payload.findings)) {
				expect(payload.findings).toHaveLength(2);
				const firstFinding = payload.findings[0];
				if (firstFinding && typeof firstFinding === "object" && "requiredFix" in firstFinding) {
					expect(firstFinding.requiredFix).toBe("Write tests for the API handler");
				}
			}
		}
	});

	it("should return false when findings array is empty", () => {
		const ext = api();
		const sent = injectRemediation(ext, {
			taskId: "task-empty",
			contractHash: "sha256:empty" as SHA256Hash,
			findings: [],
		});

		expect(sent).toBe(false);
		expect(ext.sent).toHaveLength(0);
	});

	it("should set deliverAs to nextTurn and triggerTurn to true", () => {
		const ext = api();
		injectRemediation(ext, {
			taskId: "task-delivery",
			contractHash: "sha256:delivery" as SHA256Hash,
			findings: [
				{
					id: "finding-1",
					reason: "Fix needed",
					requiredFix: "Apply the patch",
					evidenceRefs: ["evidence://task-delivery"],
				},
			],
		});

		expect(ext.sent[0].options?.deliverAs).toBe("nextTurn");
		expect(ext.sent[0].options?.triggerTurn).toBe(true);
	});
});
