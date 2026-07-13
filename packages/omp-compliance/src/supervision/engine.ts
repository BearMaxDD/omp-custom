import type { Severity, SupervisionFinding, SupervisionHook } from "./types";

const SEVERITY_ORDER: Severity[] = ["nit", "concern", "blocker"];

interface DedupeEntry {
	lastAdvise: number;
	lastSeverity: Severity;
	count: number;
}

/**
 * SupervisionEngine runs registered hooks against tool events and
 * produces findings with deduplication, severity escalation, and
 * silence-after-N‑repeats rules.
 *
 * - Same id + same severity within 60 s is suppressed.
 * - Severity escalation (nit→concern→blocker) bypasses the 60 s window.
 * - After 5 advices with the same id the hook is silenced.
 * - Every finding is dual-written: to the `advise` callback and to `evidence`.
 */
export class SupervisionEngine {
	private readonly hooks: SupervisionHook[] = [];
	private readonly dedupeState = new Map<string, DedupeEntry>();
	private readonly advise: (finding: SupervisionFinding) => void;
	private readonly evidence: (finding: SupervisionFinding) => void;

	constructor(opts: {
		advise: (finding: SupervisionFinding) => void;
		evidence: (finding: SupervisionFinding) => void;
	}) {
		this.advise = opts.advise;
		this.evidence = opts.evidence;
	}

	register(hook: SupervisionHook): void {
		this.hooks.push(hook);
	}

	onToolResult(event: { toolName: string; success: boolean }): SupervisionFinding[] {
		const findings: SupervisionFinding[] = [];

		for (const hook of this.hooks) {
			if (!hook.onToolResult) continue;
			const finding = hook.onToolResult(event);
			if (!finding) continue;

			// Evidence: always persist regardless of dedup
			this.evidence(finding);
			findings.push(finding);

			// Advise: independently dedup/rate-limit
			if (!this.shouldAdvise(finding)) continue;
			this.advise(finding);
		}

		return findings;
	}

	private shouldAdvise(finding: SupervisionFinding): boolean {
		const entry = this.dedupeState.get(finding.id);

		if (!entry) {
			// First occurrence — always advise
			this.dedupeState.set(finding.id, {
				lastAdvise: Date.now(),
				lastSeverity: finding.severity,
				count: 1,
			});
			return true;
		}

		// Silence after 5 repeats
		if (entry.count >= 5) return false;

		const currentSevIndex = SEVERITY_ORDER.indexOf(finding.severity);
		const lastSevIndex = SEVERITY_ORDER.indexOf(entry.lastSeverity);
		const isEscalation = currentSevIndex > lastSevIndex;

		const elapsed = Date.now() - entry.lastAdvise;

		if (isEscalation) {
			// Severity upgrade always advises, resets the timer
			entry.lastAdvise = Date.now();
			entry.lastSeverity = finding.severity;
			entry.count++;
			return true;
		}

		if (elapsed < 60_000) {
			// Same severity within 60 s — suppress
			return false;
		}

		// Outside the 60 s window — advise again
		entry.lastAdvise = Date.now();
		entry.count++;
		return true;
	}
}
