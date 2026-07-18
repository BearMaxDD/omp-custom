import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export const PROTOCOL_V1_REQUIRED_ERROR = "OMP Advisor Review Protocol v1 is required; compliance activation refused";

export function supportsAdvisorProtocolV1(
	api: Pick<ExtensionAPI, "advisorReviewCapabilities" | "requestAdvisorReview">,
): boolean {
	try {
		const capabilities = api.advisorReviewCapabilities;
		if (
			capabilities?.protocolVersion === 1 &&
			capabilities.reviewRequest === true &&
			capabilities.beforeRunAugmentation === true &&
			capabilities.lifecycleEvents === true &&
			capabilities.finalReceipt === true &&
			typeof api.requestAdvisorReview === "function"
		) {
			return true;
		}
	} catch {
		// Host objects are untrusted activation input; expose one stable refusal.
	}
	return false;
}

export function assertAdvisorProtocolV1(
	api: Pick<ExtensionAPI, "advisorReviewCapabilities" | "requestAdvisorReview">,
): void {
	if (!supportsAdvisorProtocolV1(api)) throw new Error(PROTOCOL_V1_REQUIRED_ERROR);
}
