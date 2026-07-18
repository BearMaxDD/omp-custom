import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rawPkg from "../package.json" with { type: "json" };
import { FakeExtensionAPI, createFakeExtensionContext } from "./support/fake-extension-api";

const pkg = rawPkg as { name: string; omp?: { extensions?: string[] } };

describe("omp-compliance extension packaging", () => {
	it("declares a unique entry discoverable by OMP extensions", () => {
		expect(pkg.name).toBe("@bearmaxdd/omp-compliance");
		expect(pkg.omp?.extensions).toBeDefined();
		expect(Array.isArray(pkg.omp?.extensions)).toBe(true);
		expect(pkg.omp?.extensions?.length).toBeGreaterThanOrEqual(1);
		expect(pkg.omp?.extensions?.[0]).toBe("./dist/extension.js");
	});

	it("registers control tools and fails closed on writes without an active contract", async () => {
		const root = mkdtempSync(join(tmpdir(), "extension-loading-"));
		const api = new FakeExtensionAPI(createFakeExtensionContext({ cwd: root }));

		// Dynamic import: test exercises the module loading boundary for extension activation
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		const commands = api.getRegisteredCommands();
		expect(commands).toContain("compliance");

		const tools = api.getRegisteredTools();
		expect(tools).toContain("compliance_complete");

		await api.fireSessionStart();
		const blocked = await api.fireToolCall("edit", { path: "src/unsafe.ts", oldText: "a", newText: "b" });
		expect(blocked.block).toBe(true);
		expect(blocked.reasons).toContain("missing_contract");

		const events = api.getBoundEvents();
		expect(events).toContain("tool_call");
		expect(events).toContain("tool_result");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");
		rmSync(root, { recursive: true, force: true });
	});

	it("registers an object parameter schema for every model-facing tool", async () => {
		const api = new FakeExtensionAPI();
		const activate = (await import("../src/extension")).default;
		activate(api.toAPI());

		for (const tool of api.toolDefinitions) {
			expect(tool.parameters, `${tool.name} must declare parameters`).toMatchObject({ type: "object" });
		}
	});
});
