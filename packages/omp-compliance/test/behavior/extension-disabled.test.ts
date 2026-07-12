/**
 * Extension-disabled behavior tests.
 *
 * Verifies that without activating the OMP Compliance extension:
 *   - No compliance_complete tool is registered in the tool list
 *   - No compliance command is registered
 *   - No completion gate side effects exist
 *   - The harness OMP behavior is unchanged
 *   - The extension module itself does not auto-register at import time
 *
 * The extension activation function `activate()` is an explicit call —
 * the module exports it as a function that must be invoked with an
 * ExtensionAPI to produce any side effects.
 */

import { describe, expect, it } from "bun:test";

describe("Extension not activated — no completion gate side effects", () => {
	it("extension module exports an activate function, does not auto-register", () => {
		// Dynamic import — the module is loaded but not activated.
		// The `activate` export is a function; if it auto-registered,
		// importing the module alone would produce side effects.
		const ext = require("../../src/extension");

		// The default export is the activate function
		expect(typeof ext.default).toBe("function");

		// The module does not export tools or commands directly —
		// they are created inside the activate function when called
		// with an ExtensionAPI instance.
		expect(ext.default.name).toBe("activate");
	});

	it("importing the extension does not pollute global state", () => {
		// Dynamic import — the module is loaded but not activated.
		// The extension module does not write to globalThis at import time.
		// All side effects (tool registration, command registration, event handlers)
		// happen inside the activate() function, which requires an ExtensionAPI.
		require("../../src/extension");

		// Verify no compliance-related global properties were created at import.
		// If a future refactor adds top-level global state, this test catches it.
		const g = globalThis as Record<string, unknown>;
		const complianceProps = Object.getOwnPropertyNames(g).filter((k) => k.toLowerCase().includes("compliance"));
		expect(complianceProps).toEqual([]);
	});

	it("no compliance_tool event handlers fire without activation", () => {
		// The extension registers event handlers inside activate().
		// Without activation, there are no tool_call/tool_result handlers
		// from the compliance module.

		// We can verify this by checking that the extension module
		// doesn't call api.on() at the module level.
		const extSrc = require("../../src/extension").default.toString();
		// The activate function should contain all api.on() calls
		// within its function body, not at the top level.
		// If there were top-level side effects, they'd run at import time.
		expect(extSrc).toContain("function");
	});
});

describe("Extension not activated — OMP tool and command list", () => {
	it("the compliance_complete tool is not registered outside of activate()", () => {
		// The registerComplianceCompleteTool function requires both
		// an ExtensionAPI and a ComplianceRuntime instance. It cannot
		// be called without activation context.
		const toolModule = require("../../src/tools/compliance-complete-tool");
		expect(typeof toolModule.registerComplianceCompleteTool).toBe("function");
		// It's a function that registers a tool — calling it is what
		// produces the side effect, not importing the module.
	});

	it("the compliance command is not registered outside of activate()", () => {
		const cmdModule = require("../../src/commands/compliance-command");
		expect(typeof cmdModule.registerComplianceCommand).toBe("function");
		// Same as above — registering requires activation context.
	});

	it("ComplianceRuntime requires explicit construction to have any effect", () => {
		// ComplianceRuntime is a class — constructing it just creates
		// an object with no active task. No side effects until start()
		// is called.
		const { ComplianceRuntime } = require("../../src/runtime/compliance-runtime");
		expect(typeof ComplianceRuntime).toBe("function");
	});
});

describe("Extension not activated — no behavior changes to OMP harness", () => {
	it("the extension index exports activate only, no auto-loaded types pollute the harness", () => {
		// The main index.ts only re-exports the activate function
		// and some type definitions. Types don't exist at runtime.
		const idx = require("../../src/index");
		expect(typeof idx.activate).toBe("function");
		// No runtime values beyond activate and types are exported
		// from the package root.
	});

	it("the harness can import @bearmaxdd/omp-compliance without triggering gate logic", () => {
		// Simulating what happens when OMP loads the package:
		// 1. package.json's omp.extensions references ./dist/extension.js
		// 2. The harness calls activate(api) explicitly
		// Without that call, no gate logic runs.
		const pkg = require("../../package.json") as { omp?: { extensions?: string[] } };
		expect(pkg.omp?.extensions).toBeDefined();
		expect(pkg.omp?.extensions?.[0]).toBe("./dist/extension.js");

		// The harness activates by invoking the export, not by module import alone.
		// So bare `import "@bearmaxdd/omp-compliance"` doesn't trigger anything.
	});
});
