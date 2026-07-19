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

function isSourceHash(value: string): value is `sha256:${string}` {
	return value.startsWith("sha256:") && value.length > "sha256:".length;
}

function sourceHash(value: string | undefined): `sha256:${string}` {
	const resolved = defined(value, "sha256:development");
	if (!isSourceHash(resolved)) {
		throw new Error("OMP compliance source hash must start with sha256: and include a value");
	}
	return resolved;
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
	sourceHash: sourceHash(
		typeof __OMP_COMPLIANCE_SOURCE_HASH__ === "string" ? __OMP_COMPLIANCE_SOURCE_HASH__ : undefined,
	),
	protocol: "advisor-review/v1",
} satisfies EmbeddedComplianceBuildIdentity);

export function embeddedComplianceBuildIdentity(): EmbeddedComplianceBuildIdentity {
	return buildIdentity;
}
