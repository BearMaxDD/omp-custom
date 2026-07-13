import { describe, expect, it } from "bun:test";
import { ImpactPlanSink } from "../../src/runtime/impact-sink";
import type { ImpactPlan } from "../../src/runtime/impact-sink";

// ─── Helpers ────────────────────────────────────────────────────────

function samplePlan(overrides: Partial<ImpactPlan> = {}): ImpactPlan {
	return {
		schema_version: "1.0",
		affected_modules: ["src/runtime/compliance-runtime.ts"],
		affected_tests: ["test/runtime/compliance-runtime.test.ts"],
		suggested_commands: ["bun test"],
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ImpactPlanSink", () => {
	it("should resolve the registered promise when accept is called before timeout", async () => {
		const sink = new ImpactPlanSink();
		const plan = samplePlan();

		const promise = sink.register("review-1", 5_000);
		sink.accept("review-1", plan);

		const result = await promise;
		expect(result).toEqual(plan);
	});

	it("should reject the registered promise on timeout", async () => {
		const sink = new ImpactPlanSink();

		const promise = sink.register("review-timeout", 10);

		await expect(promise).rejects.toThrow("ImpactPlanSink timeout for reviewId: review-timeout");
	});

	it("should silently ignore a duplicate accept call", async () => {
		const sink = new ImpactPlanSink();
		const plan = samplePlan();
		const plan2 = samplePlan({ schema_version: "2.0" });

		const promise = sink.register("review-dup", 5_000);
		sink.accept("review-dup", plan);
		// Second accept should be silently ignored
		sink.accept("review-dup", plan2);

		const result = await promise;
		expect(result).toEqual(plan);
	});

	it("should silently ignore accept for unknown reviewId", () => {
		const sink = new ImpactPlanSink();
		// Should not throw
		sink.accept("nonexistent", samplePlan());
	});

	it("should silently ignore reject for unknown reviewId", () => {
		const sink = new ImpactPlanSink();
		sink.reject("nonexistent", "not found");
	});

	it("should reject with the provided reason", async () => {
		const sink = new ImpactPlanSink();

		const promise = sink.register("review-reject", 5_000);
		sink.reject("review-reject", "user cancelled");

		await expect(promise).rejects.toThrow("user cancelled");
	});

	it("should throw on duplicate register", () => {
		const sink = new ImpactPlanSink();
		sink.register("review-dup-reg", 5_000);

		expect(() => sink.register("review-dup-reg", 5_000)).toThrow(
			"Duplicate reviewId: review-dup-reg",
		);
	});
});
