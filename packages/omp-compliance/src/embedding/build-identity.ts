declare const __OMP_COMPLIANCE_PACKAGE_VERSION__: string | undefined;
declare const __OMP_COMPLIANCE_GIT_COMMIT__: string | undefined;
declare const __OMP_COMPLIANCE_SOURCE_HASH__: string | undefined;

export interface EmbeddedComplianceBuildIdentity {
	readonly packageName: "@bearmaxdd/omp-compliance";
	readonly packageVersion: string;
	readonly gitCommit: string;
	readonly sourceHash: `sha256:${string}`;
	readonly protocol: "advisor-review/v1";
}

const buildIdentity = Object.freeze({
	packageName: "@bearmaxdd/omp-compliance",
	packageVersion: typeof __OMP_COMPLIANCE_PACKAGE_VERSION__ === "string" ? __OMP_COMPLIANCE_PACKAGE_VERSION__ : "development",
	gitCommit: typeof __OMP_COMPLIANCE_GIT_COMMIT__ === "string" ? __OMP_COMPLIANCE_GIT_COMMIT__ : "development",
	sourceHash:
		typeof __OMP_COMPLIANCE_SOURCE_HASH__ === "string"
			? (__OMP_COMPLIANCE_SOURCE_HASH__ as `sha256:${string}`)
			: "sha256:development",
	protocol: "advisor-review/v1",
} satisfies EmbeddedComplianceBuildIdentity);

export function embeddedComplianceBuildIdentity(): EmbeddedComplianceBuildIdentity {
	return buildIdentity;
}
