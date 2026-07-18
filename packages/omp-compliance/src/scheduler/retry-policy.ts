export const REVIEW_RETRY_INITIAL_DELAY_MS = 5_000;
export const REVIEW_RETRY_MAX_BASE_DELAY_MS = 5 * 60_000;
export const REVIEW_RETRY_JITTER_RATIO = 0.2;
export const REVIEW_RETRY_MAX_ATTEMPT = 1_000_000;

export function reviewRetryDelayMs(attempt: number, random: () => number): number {
	if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > REVIEW_RETRY_MAX_ATTEMPT) {
		throw new Error("review attempt is outside the supported range");
	}
	const exponent = Math.min(30, attempt - 1);
	const base = Math.min(REVIEW_RETRY_INITIAL_DELAY_MS * 2 ** exponent, REVIEW_RETRY_MAX_BASE_DELAY_MS);
	const randomValue = random();
	const sample = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
	return Math.round(base + base * REVIEW_RETRY_JITTER_RATIO * sample);
}
