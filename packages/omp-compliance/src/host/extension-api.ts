import type { EmbeddedComplianceBuildIdentity } from "../embedding/build-identity";

/**
 * Host-provided context describing the embedded compliance extension.
 * Present only when the extension is statically embedded into the host
 * binary; absent for externally installed plugin copies.
 */
export interface EmbeddedExtensionContext {
	readonly identity: EmbeddedComplianceBuildIdentity;
	readonly suppressedExternalDuplicates: readonly string[];
}
