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

function defined(value: string | undefined, fallback: string): string {
	return value === undefined || value.length === 0 ? fallback : value;
}

const buildIdentity = Object.freeze({
	packageName: "@bearmaxdd/omp-compliance",
	packageVersion: defined(
		typeof __OMP_COMPLIANCE_PACKAGE_VERSION__ === "string" ? __OMP_COMPLIANCE_PACKAGE_VERSION__ : undefined,
		"development",
	),
	gitCommit: defined(
		typeof __OMP_COMPLIANCE_GIT_COMMIT__ === "string" ? __OMP_COMPLIANCE_GIT_COMMIT__ : undefined,
		"development",
	),
	sourceHash: defined(
		typeof __OMP_COMPLIANCE_SOURCE_HASH__ === "string" ? __OMP_COMPLIANCE_SOURCE_HASH__ : undefined,
		"sha256:development",
	) as `sha256:${string}`,
	protocol: "advisor-review/v1",
} satisfies EmbeddedComplianceBuildIdentity);

export function embeddedComplianceBuildIdentity(): EmbeddedComplianceBuildIdentity {
	return buildIdentity;
}
