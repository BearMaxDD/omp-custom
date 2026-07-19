import { describe, expect, it } from "bun:test";
import { embeddedComplianceBuildIdentity } from "../../src/embedding/build-identity";

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
});
