import { beforeEach, describe, expect, it } from "bun:test";
import type { ComplianceVerdict, VerdictContext } from "../../src/advisor/verdict-schema";
import { acceptVerdict, hasPassed } from "../../src/advisor/verdict-sink";
import type { VerdictStore } from "../../src/advisor/verdict-sink";
import type { SHA256Hash } from "../../src/contract/types";
import { strictVerdictContext, strictVerdictFields } from "../support/strict-verdict";

// ─── Helpers ────────────────────────────────────────────────────────

const DEFAULT_HASH = "sha256:abc123def456" as SHA256Hash;

const defaultContext: VerdictContext = strictVerdictContext("code-task", DEFAULT_HASH);

function validVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		...strictVerdictFields(
			strictVerdictContext("code-task", DEFAULT_HASH, Number(overrides.attempt ?? defaultContext.attempt)),
		),
		task_id: "code-task",
		contract_hash: DEFAULT_HASH,
		attempt: 1,
		status: "pass",
		findings: [],
		...overrides,
	};
}

function freshStore(): VerdictStore {
	return { records: [], lastPass: {}, acceptedKeys: new Set() };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("acceptVerdict", () => {
	it("accepts a valid pass verdict", () => {
		const store = freshStore();
		const result = acceptVerdict(validVerdict(), defaultContext, store);
		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.verdict.status).toBe("pass");
		}
	});

	it("accepts a valid remediate verdict", () => {
		const store = freshStore();
		const result = acceptVerdict(
			validVerdict({
				status: "remediate",
				findings: [{ id: "f1", reason: "Fix this", required_fix: "do the thing" }],
			}),
			defaultContext,
			store,
		);
		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.verdict.status).toBe("remediate");
		}
	});

	it("rejects an invalid verdict (missing schema_version)", () => {
		const store = freshStore();
		const result = acceptVerdict({ status: "pass", findings: [] }, defaultContext, store);
		expect(result.status).toBe("rejected");
		expect(result.protocolError).toBe(true);
	});

	it("is idempotent — same verdict rejected on second call", () => {
		const store = freshStore();
		const verdict = validVerdict();

		// First call — accepted
		const first = acceptVerdict(verdict, defaultContext, store);
		expect(first.status).toBe("accepted");

		// Second call — idempotent reject
		const second = acceptVerdict(verdict, defaultContext, store);
		expect(second.status).toBe("rejected");
		expect(second.protocolError).toBeUndefined();
	});

	it("is idempotent across different verdict contexts", () => {
		const store = freshStore();
		const verdictA = validVerdict();
		const verdictB = validVerdict({ attempt: 2 });

		// First verdict accepted
		expect(acceptVerdict(verdictA, defaultContext, store).status).toBe("accepted");

		// Different attempt → different verdict → accepted
		const ctxB = strictVerdictContext("code-task", DEFAULT_HASH, 2);
		expect(acceptVerdict(verdictB, ctxB, store).status).toBe("accepted");

		// Repeat of attempt 1 → now stale (pass at attempt 2 has advanced beyond attempt 1)
		const repeatA = acceptVerdict(verdictA, defaultContext, store);
		expect(repeatA.status).toBe("rejected");
		expect(repeatA.protocolError).toBe(true);
	});

	it("rejects a stale attempt (attempt < last pass attempt)", () => {
		const store = freshStore();

		// Accept attempt 2 pass first
		const ctx2 = strictVerdictContext("code-task", DEFAULT_HASH, 2);
		const pass2 = acceptVerdict(validVerdict({ attempt: 2 }), ctx2, store);
		expect(pass2.status).toBe("accepted");

		// Now attempt 1 is stale
		const stale = acceptVerdict(validVerdict({ attempt: 1 }), defaultContext, store);
		expect(stale.status).toBe("rejected");
		expect(stale.protocolError).toBe(true);
	});

	it("rejects a remediate after a pass (post-pass lock)", () => {
		const store = freshStore();

		// Accept a pass first
		const pass = acceptVerdict(validVerdict(), defaultContext, store);
		expect(pass.status).toBe("accepted");

		// Same attempt remediate → rejected
		const remediate = acceptVerdict(
			validVerdict({ status: "remediate", findings: [{ id: "f1", reason: "Fix", required_fix: "fix" }] }),
			defaultContext,
			store,
		);
		expect(remediate.status).toBe("rejected");
		expect(remediate.protocolError).toBe(true);
	});

	it("accepts a remediate after a remediate (no pass yet)", () => {
		const store = freshStore();

		// Accept remediate at attempt 1
		const ctx1 = strictVerdictContext("code-task", DEFAULT_HASH);
		const r1 = acceptVerdict(
			validVerdict({ status: "remediate", findings: [{ id: "f1", reason: "Fix", required_fix: "fix" }] }),
			ctx1,
			store,
		);
		expect(r1.status).toBe("accepted");

		// Accept remediate at attempt 2 (pass never happened)
		const ctx2 = strictVerdictContext("code-task", DEFAULT_HASH, 2);
		const r2 = acceptVerdict(
			validVerdict({ attempt: 2, status: "remediate", findings: [{ id: "f1", reason: "Fix", required_fix: "fix" }] }),
			ctx2,
			store,
		);
		expect(r2.status).toBe("accepted");
	});

	it("updates the store record count on acceptance", () => {
		const store = freshStore();
		const result = acceptVerdict(validVerdict(), defaultContext, store);
		expect(result.status).toBe("accepted");
		expect(store.records).toHaveLength(1);
		expect(store.records[0].attempt).toBe(1);
	});

	it("accepts a pre-parsed verdict (avoids duplicate parse)", () => {
		const store = freshStore();
		const parsed = {
			schema_version: 1 as const,
			review_id: defaultContext.reviewId,
			task_id: "code-task",
			project_id: defaultContext.projectId,
			contract_hash: DEFAULT_HASH,
			evidence_revision: defaultContext.evidenceRevision as SHA256Hash,
			git_head: defaultContext.gitHead,
			diff_hash: defaultContext.diffHash as SHA256Hash,
			trigger: "compliance_review" as const,
			attempt: 1,
			status: "pass" as const,
			findings: [],
		};
		// Pass raw + pre-parsed verdict
		const result = acceptVerdict({} as Record<string, unknown>, defaultContext, store, parsed);
		expect(result.status).toBe("accepted");
	});
});

describe("hasPassed", () => {
	it("returns false when no pass has been accepted", () => {
		const store = freshStore();
		expect(hasPassed("code-task", DEFAULT_HASH, store)).toBe(false);
	});

	it("returns true after a pass verdict for the same task+hash", () => {
		const store = freshStore();
		acceptVerdict(validVerdict(), defaultContext, store);
		expect(hasPassed("code-task", DEFAULT_HASH, store)).toBe(true);
	});

	it("returns false after only remediate verdicts", () => {
		const store = freshStore();
		const ctx = strictVerdictContext("code-task", DEFAULT_HASH);
		acceptVerdict(
			validVerdict({ status: "remediate", findings: [{ id: "f1", reason: "Fix", required_fix: "fix" }] }),
			ctx,
			store,
		);
		expect(hasPassed("code-task", DEFAULT_HASH, store)).toBe(false);
	});

	it("returns false for a different task+hash", () => {
		const store = freshStore();
		acceptVerdict(validVerdict(), defaultContext, store);
		expect(hasPassed("other-task", DEFAULT_HASH, store)).toBe(false);
		expect(hasPassed("code-task", "sha256:other" as SHA256Hash, store)).toBe(false);
	});
});
