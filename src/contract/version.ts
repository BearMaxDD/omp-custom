import { type HostResult, hostError } from "./errors.ts";

export const CONTRACT_VERSION = 1 as const;

export function assertCompatibleHostVersion(
	hostVersion: number,
): HostResult<void> {
	return hostVersion === CONTRACT_VERSION
		? { ok: true, value: undefined }
		: {
				ok: false,
				error: hostError(
					"host_incompatible",
					`Host contract version ${hostVersion} is incompatible with custom contract version ${CONTRACT_VERSION}`,
				),
			};
}
