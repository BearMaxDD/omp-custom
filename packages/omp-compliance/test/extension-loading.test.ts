import { describe, expect, it } from "bun:test";
import { FakeExtensionAPI } from "./support/fake-extension-api";

describe("omp-compliance extension packaging", () => {
	it("declares a unique entry discoverable by OMP extensions", () => {
		const pkg = require("../package.json") as {
			name: string;
			omp?: { extensions?: string[] };
		};

		expect(pkg.name).toBe("@bearmaxdd/omp-compliance");
		expect(pkg.omp?.extensions).toBeDefined();
		expect(Array.isArray(pkg.omp?.extensions)).toBe(true);
		expect(pkg.omp?.extensions?.length).toBeGreaterThanOrEqual(1);
		expect(pkg.omp?.extensions?.[0]).toBe("./dist/extension.js");
	});

	it("registers only compliance command and completion tool, without blocking built-in tools", async () => {
		const api = new FakeExtensionAPI();

		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		const commands = api.getRegisteredCommands();
		expect(commands).toContain("compliance");

		const tools = api.getRegisteredTools();
		expect(tools).toContain("compliance_complete");

		const blocked = await api.getBlockedToolCalls();
		expect(blocked).toHaveLength(0);

		const events = api.getBoundEvents();
		expect(events).toContain("tool_call");
		expect(events).toContain("tool_result");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");
	});
});
