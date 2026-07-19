import { describe, expect, it } from "bun:test";
import { embeddedComplianceBuildIdentity } from "../../src/embedding/build-identity";

type BuildDefines = Record<string, string>;
type BuildIdentityModule = typeof import("../../src/embedding/build-identity");

async function embeddedIdentityFromDefines(defines: BuildDefines) {
	const result = await Bun.build({
		entrypoints: ["packages/omp-compliance/src/embedding/build-identity.ts"],
		format: "esm",
		target: "bun",
		define: defines,
		write: false,
	});
	if (!result.success) throw new Error("identity fixture build failed");
	const output = result.outputs[0];
	if (!output) throw new Error("identity fixture produced no output");
	const code = await output.text();
	const module = (await import(
		`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
	)) as BuildIdentityModule;
	return module.embeddedComplianceBuildIdentity();
}

describe("embeddedComplianceBuildIdentity", () => {
	it("uses portable development fallbacks and returns a frozen identity", () => {
		const identity = embeddedComplianceBuildIdentity();

		expect(identity).toEqual({
			packageName: "@bearmaxdd/omp-compliance",
			packageVersion: "development",
			gitCommit: "development",
			sourceHash: "sha256:development",
			protocol: "advisor-review/v1",
		});
		expect(Object.isFrozen(identity)).toBe(true);
	});

	it("returns non-empty compile-time injection values in a frozen identity", async () => {
		const identity = await embeddedIdentityFromDefines({
			__OMP_COMPLIANCE_PACKAGE_VERSION__: '"1.2.3"',
			__OMP_COMPLIANCE_GIT_COMMIT__: '"abc123"',
			__OMP_COMPLIANCE_SOURCE_HASH__: '"sha256:release"',
		});

		expect(identity).toEqual({
			packageName: "@bearmaxdd/omp-compliance",
			packageVersion: "1.2.3",
			gitCommit: "abc123",
			sourceHash: "sha256:release",
			protocol: "advisor-review/v1",
		});
		expect(Object.isFrozen(identity)).toBe(true);
	});

	it("falls back when compile-time injection values are empty strings", async () => {
		const identity = await embeddedIdentityFromDefines({
			__OMP_COMPLIANCE_PACKAGE_VERSION__: '""',
			__OMP_COMPLIANCE_GIT_COMMIT__: '""',
			__OMP_COMPLIANCE_SOURCE_HASH__: '""',
		});

		expect(identity).toEqual({
			packageName: "@bearmaxdd/omp-compliance",
			packageVersion: "development",
			gitCommit: "development",
			sourceHash: "sha256:development",
			protocol: "advisor-review/v1",
		});
		expect(Object.isFrozen(identity)).toBe(true);
	});
});
