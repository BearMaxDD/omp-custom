import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { FakeExtensionAPI } from "./support/fake-extension-api";

describe("omp-compliance installation smoke", () => {
	const pkgRoot = join(__dirname, "..");

	it("npm pack includes expected files", async () => {
		const result = await $`npm pack --dry-run 2>&1`.cwd(pkgRoot);
		const stdout = result.text();
		expect(stdout).toContain("package.json");
		expect(stdout).toContain("dist/extension.js");
		expect(stdout).toContain("dist/index.js");
	});

	it("packed manifest preserves omp.extensions entry", async () => {
		const result = await $`npm pack --dry-run --json 2>&1`.cwd(pkgRoot);
		const stdout = result.text();
		const [manifest] = JSON.parse(stdout.trim());
		expect(manifest.files.some((f: { path: string }) => f.path === "package.json")).toBe(true);

		// Verify the packed package.json would include omp.extensions
		// by checking the source package.json
		const pkg = await Bun.file(join(pkgRoot, "package.json")).json();
		expect(pkg.omp?.extensions).toBeDefined();
		expect(Array.isArray(pkg.omp?.extensions)).toBe(true);
		expect(pkg.omp?.extensions).toContain("./dist/extension.js");
	});

	it("extension entry can be loaded from dist after build", async () => {
		// Build first to ensure dist/ is up to date
		await $`bun run build`.cwd(pkgRoot);

		// Verify dist/extension.js exists
		expect(existsSync(join(pkgRoot, "dist", "extension.js"))).toBe(true);

		// Dynamic import to exercise the module loading boundary —
		// this test verifies the built output is loadable at runtime,
		// which is the whole purpose of a pack/install smoke test.
		const ext = await import(join(pkgRoot, "dist", "extension.js"));
		expect(typeof ext.default).toBe("function");

		// Activate with fake API to verify it registers
		const api = new FakeExtensionAPI();
		ext.default(api.toAPI());
		expect(api.getRegisteredTools()).toContain("compliance_complete");
		expect(api.getRegisteredCommands()).toContain("compliance");
	});

	it("does not send messages or write entries without active task", async () => {
		// Build first
		await $`bun run build`.cwd(pkgRoot);

		const api = new FakeExtensionAPI();
		const activate = (await import(join(pkgRoot, "dist", "extension.js"))).default;
		activate(api.toAPI());

		// No active task means no automatic messages or custom entries
		expect(api.sentMessages).toHaveLength(0);
		expect(api.appendedEntries).toHaveLength(0);
	});
});
