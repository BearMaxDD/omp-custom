import { describe, expect, it } from "bun:test";
import { PROTOCOL_V1_REQUIRED_ERROR, assertAdvisorProtocolV1 } from "../../src/activation/capability-negotiation";

const requestAdvisorReview = async () => ({ status: "accepted" as const, reviewId: "review-1" });
const capabilitiesV1 = {
	protocolVersion: 1,
	reviewRequest: true,
	beforeRunAugmentation: true,
	lifecycleEvents: true,
	finalReceipt: true,
} as const;
type ProtocolApi = Parameters<typeof assertAdvisorProtocolV1>[0];

describe("assertAdvisorProtocolV1", () => {
	it("accepts exactly protocol v1 with a review request function", () => {
		expect(() =>
			assertAdvisorProtocolV1({ advisorReviewCapabilities: capabilitiesV1, requestAdvisorReview }),
		).not.toThrow();
	});

	it.each([
		["missing capabilities", { requestAdvisorReview }],
		[
			"wrong protocol version",
			{ advisorReviewCapabilities: { ...capabilitiesV1, protocolVersion: 2 }, requestAdvisorReview },
		],
		["missing request function", { advisorReviewCapabilities: capabilitiesV1 }],
		["non-function request", { advisorReviewCapabilities: capabilitiesV1, requestAdvisorReview: true }],
	])("refuses activation for %s without downgrading", (_case, api) => {
		expect(() => assertAdvisorProtocolV1(api as unknown as ProtocolApi)).toThrow(PROTOCOL_V1_REQUIRED_ERROR);
	});
});
