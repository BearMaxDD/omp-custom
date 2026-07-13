import { describe, expect, it } from "bun:test";
import { VerdictValidationError, parseVerdict } from "../../src/advisor/verdict-schema";
import type { ComplianceVerdict, VerdictContext } from "../../src/advisor/verdict-schema";
import type { SHA256Hash } from "../../src/contract/types";
import invalidLegacyFixture from "../fixtures/verdict/invalid-legacy.json";
import passFixture from "../fixtures/verdict/pass.json";
import remediateFixture from "../fixtures/verdict/remediate.json";

// ─── Helpers ────────────────────────────────────────────────────────

const DEFAULT_HASH = "sha256:abc123def456" as SHA256Hash;

const defaultContext: VerdictContext = {
	taskId: "code-task",
	contractHash: DEFAULT_HASH,
	attempt: 1,
};

function validVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		task_id: "code-task",
		contract_hash: DEFAULT_HASH,
		attempt: 1,
		status: "pass",
		findings: [],
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("parseVerdict", () => {
	it("accepts a valid pass verdict with empty findings", () => {
		const result = parseVerdict(validVerdict(), defaultContext);
		expect(result.status).toBe("pass");
		expect(result.schema_version).toBe(1);
		expect(result.task_id).toBe("code-task");
		expect(result.contract_hash).toBe(DEFAULT_HASH);
		expect(result.attempt).toBe(1);
		expect(result.findings).toEqual([]);
	});

	it("accepts a valid pass verdict with non-empty findings", () => {
		const result = parseVerdict(
			validVerdict({
				findings: [{ id: "info-1", reason: "Minor observation" }],
			}),
			defaultContext,
		);
		expect(result.status).toBe("pass");
		expect(result.findings).toHaveLength(1);
	});

	it("accepts a valid remediate verdict with required_fix", () => {
		const result = parseVerdict(
			validVerdict({
				status: "remediate",
				findings: [
					{
						id: "missing-codebase",
						reason: "No codebase MCP queries found",
						required_fix: "Use the codebase MCP tool to query the relevant source files",
					},
				],
			}),
			defaultContext,
		);
		expect(result.status).toBe("remediate");
		expect(result.findings[0].required_fix).toBeDefined();
	});

	it("rejects a mismatched task_id", () => {
		expect(() => parseVerdict(validVerdict({ task_id: "other" }), defaultContext)).toThrow("task_id");
	});

	it("rejects a mismatched contract_hash", () => {
		expect(() => parseVerdict(validVerdict({ contract_hash: "sha256:other" }), defaultContext)).toThrow(
			"contract_hash",
		);
	});

	it("rejects a mismatched attempt", () => {
		expect(() => parseVerdict(validVerdict({ attempt: 99 }), defaultContext)).toThrow("attempt");
	});

	it("rejects remediate with empty findings (no required_fix)", () => {
		expect(() => parseVerdict(validVerdict({ status: "remediate", findings: [] }), defaultContext)).toThrow(
			"required_fix",
		);
	});

	it("rejects remediate with finding missing required_fix", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [{ id: "f1", reason: "Something wrong" }],
				}),
				defaultContext,
			),
		).toThrow("required_fix");
	});

	it("rejects remediate with empty required_fix", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [
						{
							id: "f1",
							reason: "Something wrong",
							required_fix: "",
						},
					],
				}),
				defaultContext,
			),
		).toThrow("required_fix");
	});

	it("rejects remediate with whitespace-only required_fix", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [
						{
							id: "f1",
							reason: "Something wrong",
							required_fix: "   ",
						},
					],
				}),
				defaultContext,
			),
		).toThrow("required_fix");
	});

	it("rejects an invalid schema_version", () => {
		expect(() => parseVerdict(validVerdict({ schema_version: 2 }), defaultContext)).toThrow("schema_version");
	});

	it("rejects an invalid status value", () => {
		expect(() => parseVerdict(validVerdict({ status: "invalid" }), defaultContext)).toThrow("status");
	});

	it("rejects non-array findings", () => {
		expect(() => parseVerdict(validVerdict({ findings: "not-an-array" }), defaultContext)).toThrow("findings");
	});

	it("rejects a finding with empty id", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [
						{
							id: "",
							reason: "test",
							required_fix: "fix it",
						},
					],
				}),
				defaultContext,
			),
		).toThrow("id");
	});

	it("rejects a finding with empty reason", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [
						{
							id: "f1",
							reason: "",
							required_fix: "fix it",
						},
					],
				}),
				defaultContext,
			),
		).toThrow("reason");
	});

	it("throws VerdictValidationError on failure", () => {
		expect(() => parseVerdict(validVerdict({ task_id: "other" }), defaultContext)).toThrow(VerdictValidationError);
	});

	// ─── Fixture-based tests ──────────────────────────────────────

	it("canonical fixtures pass and legacy bridge shape fails", () => {
		const fixtureContext: VerdictContext = {
			taskId: "task-9",
			contractHash: "sha256:a00000000000000000000000000000000000000000000000000000000000000" as SHA256Hash,
			attempt: 1,
		};

		expect(parseVerdict(passFixture, fixtureContext).status).toBe("pass");
		expect(parseVerdict(remediateFixture, fixtureContext).findings[0]?.required_fix).toBeTruthy();
		expect(() => parseVerdict(invalidLegacyFixture, fixtureContext)).toThrow("schema_version");
	});

	it("remediate verdict with empty findings is rejected", () => {
		const fixtureContext: VerdictContext = {
			taskId: "task-9",
			contractHash: "sha256:a00000000000000000000000000000000000000000000000000000000000000" as SHA256Hash,
			attempt: 1,
		};
		expect(() => parseVerdict({ ...remediateFixture, findings: [] }, fixtureContext)).toThrow("required_fix");
	});

	it("pass verdict with a required_fix on a finding is rejected", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					findings: [{ id: "f1", reason: "bad", required_fix: "fix it" }],
				}),
				defaultContext,
			),
		).toThrow("required_fix");
	});

	it("remediate with mixed findings (one without required_fix, one with) passes", () => {
		expect(() =>
			parseVerdict(
				validVerdict({
					status: "remediate",
					findings: [
						{ id: "f1", reason: "Missing fix" },
						{ id: "f2", reason: "Has fix", required_fix: "fix it" },
					],
				}),
				defaultContext,
			),
		).not.toThrow();
		const result = parseVerdict(
			validVerdict({
				status: "remediate",
				findings: [
					{ id: "f1", reason: "Missing fix" },
					{ id: "f2", reason: "Has fix", required_fix: "fix it" },
				],
			}),
			defaultContext,
		);
		expect(result.status).toBe("remediate");
		expect(result.findings).toHaveLength(2);
	});
});
