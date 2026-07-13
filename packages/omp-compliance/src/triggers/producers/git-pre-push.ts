import { BaseProducer } from "./base";

export interface GitPrePushArgs {
	remoteName: string;
	remoteUrl: string;
	localRef: string;
	remoteRef: string;
	localSha: string;
	remoteSha: string;
}

/**
 * CLI-mode producer for git pre-push hooks.
 *
 * The hook script invokes `omp <trigger> '<json-payload>'`.
 * parseArgs extracts the JSON from argv; start/stop are no-ops
 * because this producer is activated per-invocation, not long-lived.
 */
export class GitPrePushProducer extends BaseProducer {
	readonly trigger = "git_pre_push";
	readonly label = "Git Pre-Push Hook";
	private pendingArgs: GitPrePushArgs | null = null;

	constructor(enabled = true) {
		super(enabled);
	}

	static parseArgs(args: string[]): GitPrePushArgs {
		const raw = args.join(" ");
		try {
			const parsed = JSON.parse(raw);
			return {
				remoteName: parsed.remoteName ?? parsed.remote_name ?? "",
				remoteUrl: parsed.remoteUrl ?? parsed.remote_url ?? "",
				localRef: parsed.localRef ?? parsed.local_ref ?? "",
				remoteRef: parsed.remoteRef ?? parsed.remote_ref ?? "",
				localSha: parsed.localSha ?? parsed.local_sha ?? "",
				remoteSha: parsed.remoteSha ?? parsed.remote_sha ?? "",
			};
		} catch {
			throw new Error(
				`GitPrePushProducer.parseArgs: expected a JSON payload, got "${raw}"`,
			);
		}
	}

	/**
	 * Accept parsed push args and emit a produce event.
	 */
	triggerFromArgs(args: GitPrePushArgs): void {
		this.pendingArgs = args;
		this.emitEvent(
			{
				remoteName: args.remoteName,
				remoteUrl: args.remoteUrl,
				localRef: args.localRef,
				remoteRef: args.remoteRef,
				localSha: args.localSha,
				remoteSha: args.remoteSha,
			},
			`git_pre_push-${args.localSha}:${args.remoteSha}`,
		);
	}

	async start(): Promise<void> {
		// CLI mode — no persistent runtime
	}

	async stop(): Promise<void> {
		this.pendingArgs = null;
	}
}
