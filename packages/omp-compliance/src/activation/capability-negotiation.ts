import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export const PROTOCOL_V1_REQUIRED_ERROR = "OMP Advisor Review Protocol v1 is required; compliance activation refused";

export function assertAdvisorProtocolV1(
	api: Pick<ExtensionAPI, "advisorReviewCapabilities" | "requestAdvisorReview">,
): void {
	if (api.advisorReviewCapabilities?.protocolVersion !== 1 || typeof api.requestAdvisorReview !== "function") {
		throw new Error(PROTOCOL_V1_REQUIRED_ERROR);
	}
}
