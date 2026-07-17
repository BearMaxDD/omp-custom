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
		[
			"false protocol version",
			{ advisorReviewCapabilities: { ...capabilitiesV1, protocolVersion: false }, requestAdvisorReview },
		],
		[
			"missing protocol version",
			{
				advisorReviewCapabilities: Object.fromEntries(
					Object.entries(capabilitiesV1).filter(([key]) => key !== "protocolVersion"),
				),
				requestAdvisorReview,
			},
		],
		[
			"string protocol version",
			{ advisorReviewCapabilities: { ...capabilitiesV1, protocolVersion: "1" }, requestAdvisorReview },
		],
		[
			"spoofed protocol version",
			{
				advisorReviewCapabilities: { ...capabilitiesV1, protocolVersion: { valueOf: () => 1 } },
				requestAdvisorReview,
			},
		],
		["missing request function", { advisorReviewCapabilities: capabilitiesV1 }],
		["non-function request", { advisorReviewCapabilities: capabilitiesV1, requestAdvisorReview: true }],
		...(["reviewRequest", "beforeRunAugmentation", "lifecycleEvents", "finalReceipt"] as const).flatMap(
			(capability) => [
				[
					`${capability} false`,
					{ advisorReviewCapabilities: { ...capabilitiesV1, [capability]: false }, requestAdvisorReview },
				],
				[
					`${capability} missing`,
					{
						advisorReviewCapabilities: Object.fromEntries(
							Object.entries(capabilitiesV1).filter(([key]) => key !== capability),
						),
						requestAdvisorReview,
					},
				],
				[
					`${capability} string`,
					{ advisorReviewCapabilities: { ...capabilitiesV1, [capability]: "true" }, requestAdvisorReview },
				],
			],
		),
	])("refuses activation for %s without downgrading", (_case, api) => {
		expect(() => assertAdvisorProtocolV1(api as unknown as ProtocolApi)).toThrow(PROTOCOL_V1_REQUIRED_ERROR);
	});

	it.each([
		[
			"capabilities getter",
			{
				get advisorReviewCapabilities(): never {
					throw new Error("secret");
				},
				requestAdvisorReview,
			},
		],
		[
			"request getter",
			{
				advisorReviewCapabilities: capabilitiesV1,
				get requestAdvisorReview(): never {
					throw new Error("secret");
				},
			},
		],
		[
			"capabilities proxy",
			{
				advisorReviewCapabilities: new Proxy(capabilitiesV1, {
					get: () => {
						throw new Error("secret");
					},
				}),
				requestAdvisorReview,
			},
		],
	])("turns a throwing %s into the stable refusal", (_case, api) => {
		expect(() => assertAdvisorProtocolV1(api as unknown as ProtocolApi)).toThrow(PROTOCOL_V1_REQUIRED_ERROR);
	});
});
