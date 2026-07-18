export const REVIEW_RETRY_INITIAL_DELAY_MS = 5_000;
export const REVIEW_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const REVIEW_RETRY_JITTER_RATIO = 0.2;

export function reviewRetryDelayMs(attempt: number, random: () => number): number {
	const exponent = Math.max(0, Math.min(30, attempt - 1));
	const base = Math.min(REVIEW_RETRY_INITIAL_DELAY_MS * 2 ** exponent, REVIEW_RETRY_MAX_DELAY_MS);
	const randomValue = random();
	const sample = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0.5;
	const jitterMultiplier = 1 + (sample * 2 - 1) * REVIEW_RETRY_JITTER_RATIO;
	return Math.min(Math.round(base * jitterMultiplier), REVIEW_RETRY_MAX_DELAY_MS);
}
