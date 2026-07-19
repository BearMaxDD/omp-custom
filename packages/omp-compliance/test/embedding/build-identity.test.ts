import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { embeddedComplianceBuildIdentity } from "../../src/embedding/build-identity";

type BuildDefines = Record<string, string>;
const BUILD_IDENTITY_ENTRYPOINT = resolve(import.meta.dir, "../../src/embedding/build-identity.ts");
const RELEASE_SOURCE_HASH = `sha256:${"a".repeat(64)}`;

interface IsolatedBuildIdentity {
	readonly identity: ReturnType<typeof embeddedComplianceBuildIdentity>;
	readonly frozen: boolean;
}

function embeddedIdentityFromDefines(defines: BuildDefines): IsolatedBuildIdentity {
	const directory = mkdtempSync(join(tmpdir(), "omp-build-identity-"));
	const outputPath = join(directory, "build-identity.mjs");
	const runnerPath = join(directory, "run-identity.mjs");
	try {
		const defineArgs = Object.entries(defines).flatMap(([name, value]) => ["--define", `${name}=${value}`]);
		execFileSync(
			process.execPath,
			["build", BUILD_IDENTITY_ENTRYPOINT, "--format=esm", "--target=bun", `--outfile=${outputPath}`, ...defineArgs],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		writeFileSync(
			runnerPath,
			`import { embeddedComplianceBuildIdentity } from ${JSON.stringify(pathToFileURL(outputPath).href)};\nconst identity = embeddedComplianceBuildIdentity();\nconsole.log(JSON.stringify({ identity, frozen: Object.isFrozen(identity) }));\n`,
		);
		return JSON.parse(
			execFileSync(process.execPath, [runnerPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
		) as IsolatedBuildIdentity;
	} catch (error) {
		const stderr = (error as { stderr?: Uint8Array | string }).stderr;
		if (stderr)
			throw new Error(typeof stderr === "string" ? stderr : new TextDecoder().decode(stderr), { cause: error });
		throw error;
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
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

	it("returns non-empty compile-time injection values in a frozen identity", () => {
		const { identity, frozen } = embeddedIdentityFromDefines({
			__OMP_COMPLIANCE_PACKAGE_VERSION__: '"1.2.3"',
			__OMP_COMPLIANCE_GIT_COMMIT__: '"abc123"',
			__OMP_COMPLIANCE_SOURCE_HASH__: JSON.stringify(RELEASE_SOURCE_HASH),
		});

		expect(identity).toEqual({
			packageName: "@bearmaxdd/omp-compliance",
			packageVersion: "1.2.3",
			gitCommit: "abc123",
			sourceHash: RELEASE_SOURCE_HASH,
			protocol: "advisor-review/v1",
		});
		expect(frozen).toBe(true);
	});

	it("falls back when compile-time injection values are empty strings", () => {
		const { identity, frozen } = embeddedIdentityFromDefines({
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
		expect(frozen).toBe(true);
	});

	it.each([
		"not-a-sha256-hash",
		"sha256:",
		"sha256:not-a-digest",
		`sha256:${"a".repeat(63)}`,
		`sha256:${"A".repeat(64)}`,
	])("rejects invalid source hash injection %s", (sourceHash) => {
		expect(() =>
			embeddedIdentityFromDefines({
				__OMP_COMPLIANCE_PACKAGE_VERSION__: '"1.2.3"',
				__OMP_COMPLIANCE_GIT_COMMIT__: '"abc123"',
				__OMP_COMPLIANCE_SOURCE_HASH__: JSON.stringify(sourceHash),
			}),
		).toThrow(
			"OMP compliance source hash must be sha256:development or sha256: followed by 64 lowercase hexadecimal characters",
		);
	});
});
