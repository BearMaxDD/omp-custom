import { expect, test } from "bun:test";
import {
	assertCompatibleHostVersion,
	CONTRACT_VERSION,
	hostError,
} from "../../src/index.ts";

test("accepts a host with the current contract version", () => {
	expect(CONTRACT_VERSION).toBe(1);
	expect(assertCompatibleHostVersion(1)).toEqual({
		ok: true,
		value: undefined,
	});
});

test("rejects an incompatible host with the documented frozen error", () => {
	const result = assertCompatibleHostVersion(2);

	expect(result).toEqual({
		ok: false,
		error: {
			code: "host_incompatible",
			message:
				"Host contract version 2 is incompatible with custom contract version 1",
		},
	});
	if (result.ok) {
		throw new Error("expected an incompatible-host error");
	}
	expect(Object.isFrozen(result.error)).toBe(true);
});

test("creates frozen coded host errors", () => {
	const error = hostError("artifact_write_failed", "atomic rename failed");
	expect(error).toEqual({
		code: "artifact_write_failed",
		message: "atomic rename failed",
	});
	expect(Object.isFrozen(error)).toBe(true);
});
