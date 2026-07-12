export const HOST_ERROR_CODES = [
	"host_incompatible",
	"host_unavailable",
	"strict_execution_failed",
	"artifact_write_failed",
	"codebase_memory_failed",
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export interface HostError {
	readonly code: HostErrorCode;
	readonly message: string;
}

export type HostResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: HostError };

export function hostError(code: HostErrorCode, message: string): HostError {
	return Object.freeze({ code, message });
}
