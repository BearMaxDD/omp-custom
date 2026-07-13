import { describe, expect, it } from "bun:test";
import { computeFingerprint } from "../../src/evidence/fingerprint";

describe("computeFingerprint", () => {
	it("produces a 64-character hex string", () => {
		const fp = computeFingerprint("diff1", "findings1", "verify1", "contract1");
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("same inputs produce identical fingerprints", () => {
		const a = computeFingerprint("diff1", "findings1", "verify1", "contract1");
		const b = computeFingerprint("diff1", "findings1", "verify1", "contract1");
		expect(a).toBe(b);
	});

	it("different worktree diff hash changes fingerprint", () => {
		const a = computeFingerprint("diff1", "findings1", "verify1", "contract1");
		const b = computeFingerprint("diff2", "findings1", "verify1", "contract1");
		expect(a).not.toBe(b);
	});

	it("different findings change fingerprint", () => {
		const a = computeFingerprint("diff1", "findingsA", "verify1", "contract1");
		const b = computeFingerprint("diff1", "findingsB", "verify1", "contract1");
		expect(a).not.toBe(b);
	});

	it("different verification hash changes fingerprint", () => {
		const a = computeFingerprint("diff1", "findings1", "verifyA", "contract1");
		const b = computeFingerprint("diff1", "findings1", "verifyB", "contract1");
		expect(a).not.toBe(b);
	});

	it("different contract hash changes fingerprint", () => {
		const a = computeFingerprint("diff1", "findings1", "verify1", "contractA");
		const b = computeFingerprint("diff1", "findings1", "verify1", "contractB");
		expect(a).not.toBe(b);
	});

	it("empty inputs produce a deterministic fingerprint", () => {
		const fp = computeFingerprint("", "", "", "");
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("works with typical real-world input sizes", () => {
		const diffHash = "a".repeat(64);
		const findings = JSON.stringify([{ rule: "no-console", count: 3 }]);
		const verifyHash = "b".repeat(64);
		const contractHash = "sha256:c".repeat(60);
		const fp = computeFingerprint(diffHash, findings, verifyHash, contractHash);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});
