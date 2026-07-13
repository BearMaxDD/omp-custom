import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "../../src/types";
import { FakeExtensionAPI } from "../support/fake-extension-api";

describe("brainstorm + compliance isolation — activate", () => {
	let tmpDir: string;
	let origCwd: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "bs-isolation-"));
		origCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterAll(() => {
		process.chdir(origCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("activate creates neither .omp/compliance nor .omp/compliance/brainstorm", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../../src/extension")).default;
		activate(api.toAPI() as unknown as ExtensionAPI);

		expect(existsSync(join(tmpDir, ".omp/compliance"))).toBe(false);
		expect(existsSync(join(tmpDir, ".omp/compliance/brainstorm"))).toBe(false);
	});

	it("registers all expected brainstorm tools and commands", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../../src/extension")).default;
		activate(api.toAPI() as unknown as ExtensionAPI);

		// Compliance registrations
		expect(api.getRegisteredCommands()).toContain("compliance");
		expect(api.getRegisteredTools()).toContain("compliance_complete");

		// Brainstorm registrations
		expect(api.getRegisteredCommands()).toContain("brainstorm");
		expect(api.getRegisteredTools()).toContain("brainstorm_topic_ready");
		expect(api.getRegisteredTools()).toContain("brainstorm_decision");

		// Both advisor_before_run and tool_call handlers are bound
		const boundEvents = api.getBoundEvents();
		expect(boundEvents).toContain("advisor_before_run");
		expect(boundEvents).toContain("session_start");
		expect(boundEvents).toContain("session_switch");
		expect(boundEvents).toContain("tool_call");
	});

	it("advisor_before_run: compliance_review matches compliance hook", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../../src/extension")).default;
		activate(api.toAPI() as unknown as ExtensionAPI);

		const result = await api.fireAdvisorBeforeRun({
			trigger: "compliance_review",
			metadata: { reviewId: "test-review" },
		});

		// Compliance hook returns undefined for unknown reviewId (no envelope in registry)
		expect(result).toBeUndefined();
	});

	it("advisor_before_run: brainstorm_review matches brainstorm hook", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../../src/extension")).default;
		activate(api.toAPI() as unknown as ExtensionAPI);

		const result = await api.fireAdvisorBeforeRun({
			trigger: "brainstorm_review",
			metadata: { reviewId: "test-brainstorm-review" },
		});

		// Brainstorm hook returns undefined for unknown reviewId (no envelope in registry)
		expect(result).toBeUndefined();
	});

	it("supports session lifecycle events without error", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../../src/extension")).default;
		activate(api.toAPI() as unknown as ExtensionAPI);

		// Simulate session_start — should not throw
		const sessionContext = {
			sessionManager: { getSessionId: () => "session-42" },
		};
		const startHandlers = api.eventHandlers.get("session_start");
		expect(startHandlers).toBeDefined();
		for (const h of startHandlers ?? []) {
			await h({}, sessionContext);
		}

		// Session_switch should also work
		const switchHandlers = api.eventHandlers.get("session_switch");
		expect(switchHandlers).toBeDefined();
		for (const h of switchHandlers ?? []) {
			await h({}, sessionContext);
		}
	});
});
