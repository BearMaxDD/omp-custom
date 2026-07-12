import { describe, expect, it } from "bun:test";
import { validateCompletionParams } from "../../src/tools/compliance-complete-tool";

describe("ComplianceCompleteTool — parameter validation", () => {
	it("should accept valid params with just summary", () => {
		const errors = validateCompletionParams({ summary: "Done with the task" });
		expect(errors).toHaveLength(0);
	});

	it("should accept valid params with summary and claimed_verification", () => {
		const errors = validateCompletionParams({
			summary: "Completed feature",
			claimed_verification: ["bun test passes", "biome check clean"],
		});
		expect(errors).toHaveLength(0);
	});

	it("should reject missing summary", () => {
		const errors = validateCompletionParams({});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.field === "summary")).toBe(true);
	});

	it("should reject null summary", () => {
		const errors = validateCompletionParams({ summary: null });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.field === "summary")).toBe(true);
	});

	it("should reject empty summary", () => {
		const errors = validateCompletionParams({ summary: "" });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.message.includes("at least 1 character"))).toBe(true);
	});

	it("should reject summary exceeding 4000 characters", () => {
		const longSummary = "x".repeat(4001);
		const errors = validateCompletionParams({ summary: longSummary });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.message.includes("4000"))).toBe(true);
	});

	it("should accept summary at exactly 4000 characters", () => {
		const maxSummary = "x".repeat(4000);
		const errors = validateCompletionParams({ summary: maxSummary });
		expect(errors).toHaveLength(0);
	});

	it("should reject claimed_verification with more than 30 items", () => {
		const errors = validateCompletionParams({
			summary: "Done",
			claimed_verification: new Array(31).fill("item"),
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.message.includes("30"))).toBe(true);
	});

	it("should accept claimed_verification with exactly 30 items", () => {
		const errors = validateCompletionParams({
			summary: "Done",
			claimed_verification: new Array(30).fill("item"),
		});
		expect(errors).toHaveLength(0);
	});

	it("should reject claimed_verification items exceeding 500 characters", () => {
		const errors = validateCompletionParams({
			summary: "Done",
			claimed_verification: ["valid", "x".repeat(501)],
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.message.includes("500"))).toBe(true);
	});

	it("should reject non-string claimed_verification items", () => {
		const errors = validateCompletionParams({
			summary: "Done",
			claimed_verification: ["valid", 123 as unknown as string],
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.message.includes("string"))).toBe(true);
	});

	it("should reject non-array claimed_verification", () => {
		const errors = validateCompletionParams({
			summary: "Done",
			claimed_verification: "not an array",
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e) => e.field === "claimed_verification")).toBe(true);
	});

	it("should collect multiple validation errors", () => {
		const errors = validateCompletionParams({});
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});
});
